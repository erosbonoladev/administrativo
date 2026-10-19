import { createClient, type Client, type Transaction } from "@libsql/client/web";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type {
  Folio,
  LogLevel,
  Permiso,
  Precio,
  PrecioInput,
  Remision,
  RemisionConRenglones,
  RemisionInput,
  RemisionRenglon,
  RemisionRenglonInput,
  RemisionHistorialRow,
  Rol,
  TipoFolio,
  TipoRemision,
  User,
} from "./types";
import { PRECIOS_VENTA_CATEGORIAS } from "./types";
import type { Catalogo, PrecioVentaCategoria } from "./types";
import { FOLIO_PREFIJOS, buildFolioString, formatFechaFolioLocal } from "./folios";
import { computeSkuPrincipal } from "./precios";
import { numeroATextoMoneda } from "./numeroALetras";
import { withNetworkResilience } from "./dbResilience";

const client = withNetworkResilience(
  createClient({
    url: import.meta.env.VITE_TURSO_URL,
    authToken: import.meta.env.VITE_TURSO_AUTH_TOKEN,
    intMode: "number",
  }),
);

// La primera consulta de la sesión paga DNS + TLS + apertura de conexión
// (~3s medido); App la dispara al arrancar para que ese costo ocurra mientras
// el usuario está en el login y no en su primera búsqueda.
export function warmUpConnection(): void {
  client.execute("SELECT 1").catch(() => {});
}

// Cache en memoria para los listados completos de pantallas que no cambian
// seguido (Catálogo, Historial de remisiones, SKU Master, Piezas General) — sin
// esto, cada vez que se vuelve a una de esas pantallas (típicamente con la
// píldora de regresar, después de solo ir a ver el detalle de algo) se
// repetía el viaje de red completo a Turso aunque nada hubiera cambiado. Se
// invalida por prefijo desde las funciones de escritura de la tabla
// correspondiente (products/plastic_products/remisiones/precios) apenas
// después de que su transacción hace commit, así que un back/forward sin
// ediciones de por medio es instantáneo, pero cualquier alta/edición/borrado
// real fuerza el refetch en la próxima visita. Vive acá y no en un módulo
// aparte porque solo tiene sentido junto a las queries que cachea.
//
// Además de invalidarse por escritura, cada entrada expira sola a los pocos
// minutos (LIST_CACHE_TTL_MS): la BD es compartida entre varias máquinas
// (ver CLAUDE.md), así que una edición hecha en otra compu no dispara
// ninguna invalidación local — el TTL es la red de seguridad para que esta
// sesión no se quede mostrando datos obsoletos indefinidamente solo por no
// haber escrito nada ella misma.
const LIST_CACHE_TTL_MS = 3 * 60 * 1000;
const listCache = new Map<string, { value: unknown; expiresAt: number }>();

function cacheGet<T>(key: string): T | undefined {
  const entry = listCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    listCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): T {
  listCache.set(key, { value, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  return value;
}

function cacheInvalidate(prefix: string): void {
  for (const key of listCache.keys()) {
    if (key.startsWith(prefix)) listCache.delete(key);
  }
}

// Solo para tests: resetDb() (tests/helpers.ts) trunca las tablas por fuera
// de db.ts (rawClient(), para sembrar fixtures sin pasar por assertActor*),
// así que esta cache de módulo no se entera — sin esto, una prueba podía
// heredar el listado cacheado por otra prueba anterior en el mismo archivo.
export function __resetListCacheForTests(): void {
  listCache.clear();
}

// Búsqueda insensible a mayúsculas/minúsculas y a acentos: SQLite folda
// mayúsculas solo en ASCII, así que "México"/"MEXICO" no calzan por sí solos.
// `foldSearchColumn` envuelve la columna en `replace()` por cada vocal/ñ/ü
// acentuada antes de aplicar `lower()`, y `normalizeSearchTerm` (mismo
// criterio NFD que `normalizeHeader` en fichaImport.ts/precios.ts) hace lo
// mismo del lado del término buscado, para que ambos lados queden en la
// misma forma "plana" antes del LIKE.
const FOLDABLE_CHARS: [string, string][] = [
  ["á", "a"], ["Á", "a"],
  ["é", "e"], ["É", "e"],
  ["í", "i"], ["Í", "i"],
  ["ó", "o"], ["Ó", "o"],
  ["ú", "u"], ["Ú", "u"],
  ["ü", "u"], ["Ü", "u"],
  ["ñ", "n"], ["Ñ", "n"],
];

function foldSearchColumn(column: string): string {
  const replaced = FOLDABLE_CHARS.reduce(
    (expr, [from, to]) => `replace(${expr}, '${from}', '${to}')`,
    column,
  );
  return `lower(${replaced})`;
}

export function normalizeSearchTerm(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// El scope de fs de la app es angosto a propósito (solo appData — ver
// capabilities/default.json): un path elegido por el usuario en un diálogo
// nativo (open/save) no entra automáticamente al scope de Tauri, así que
// justo después de cada diálogo hay que extenderlo en runtime para ese path
// puntual antes de leer/escribir ahí. El comando Rust valida además que sea
// absoluto y sin segmentos "..".
export async function allowFsPath(path: string, isDir = false): Promise<void> {
  await invoke("allow_fs_path", { path, isDir });
}

// Diálogo nativo "Guardar como" + escritura (para exportaciones a Excel).
// false = el usuario canceló el diálogo.
export async function saveFileAs(defaultFileName: string, bytes: Uint8Array): Promise<boolean> {
  const target = await save({ defaultPath: defaultFileName });
  if (!target) return false;
  await allowFsPath(target);
  await writeFile(target, bytes);
  return true;
}

// readFile(path)/writeFile(path, bytes) cruzan el IPC de Tauri con el archivo
// entero de una sola vez — en Windows (WebView2/V8) reconstruir ese payload

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  activo: number;
  rol: string;
  creado_en: string;
}

async function rowToUser(row: UserRow): Promise<User> {
  const permsResult = await client.execute({
    sql: "SELECT permiso FROM user_permissions WHERE user_id = ?1",
    args: [row.id],
  });
  const permisos = (permsResult.rows as unknown as { permiso: string }[]).map(
    (r) => r.permiso as Permiso,
  );
  return {
    id: row.id,
    username: row.username,
    activo: Boolean(row.activo),
    rol: row.rol as Rol,
    permisos,
    creado_en: row.creado_en,
  };
}

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
// Sesión deslizante: cada login o validateSession() exitoso extiende el
// vencimiento este tanto hacia adelante — una sesión en uso activo (la app
// revalida periódicamente, ver auth.tsx) nunca expira a medias, pero un
// token abandonado (localStorage de una máquina apagada, o robado sin más
// actividad) deja de servir pasadas estas horas sin necesitar cambio de
// contraseña ni logout explícito.
const SESSION_TTL_HOURS = 12;

interface LoginRow extends UserRow {
  failed_attempts: number;
  is_locked: number;
}

export type LoginResult =
  | { status: "ok"; user: User; token: string }
  | { status: "invalid" }
  | { status: "locked" };

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyLogin(
  username: string,
  password: string,
): Promise<LoginResult> {
  const result = await client.execute({
    sql: `SELECT *, (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked
          FROM users WHERE username = ?1`,
    args: [username.trim()],
  });
  const row = result.rows[0] as unknown as LoginRow | undefined;
  if (!row || !row.activo) return { status: "invalid" };
  if (row.is_locked) return { status: "locked" };

  const ok = await invoke<boolean>("verify_password", {
    password,
    hash: row.password_hash,
  });

  if (!ok) {
    const attempts = (row.failed_attempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      await client.execute({
        sql: `UPDATE users SET failed_attempts = ?1, locked_until = datetime('now', ?2) WHERE id = ?3`,
        args: [attempts, `+${LOGIN_LOCKOUT_MINUTES} minutes`, row.id],
      });
    } else {
      await client.execute({
        sql: "UPDATE users SET failed_attempts = ?1 WHERE id = ?2",
        args: [attempts, row.id],
      });
    }
    return { status: "invalid" };
  }

  const token = generateSessionToken();
  await client.execute({
    sql: `UPDATE users
          SET failed_attempts = 0, locked_until = NULL, session_token = ?1,
              session_expires_at = datetime('now', ?2)
          WHERE id = ?3`,
    args: [token, `+${SESSION_TTL_HOURS} hours`, row.id],
  });
  return { status: "ok", user: await rowToUser(row), token };
}

export async function validateSession(id: number, token: string): Promise<User | null> {
  const result = await client.execute({
    sql: `SELECT * FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [id, token],
  });
  const row = result.rows[0] as unknown as UserRow | undefined;
  if (!row || !row.activo) return null;
  await client.execute({
    sql: "UPDATE users SET session_expires_at = datetime('now', ?1) WHERE id = ?2",
    args: [`+${SESSION_TTL_HOURS} hours`, id],
  });
  return rowToUser(row);
}

export interface Actor {
  id: number;
  token: string;
}

// Defensa en profundidad para operaciones sensibles (catálogo, precios,
// remisiones, producción, restaurar/eliminar backups, cambiar su
// programación, administrar usuarios y permisos): la app no tiene backend
// propio (ver docs/ARCHITECTURE.md — el token de Turso vive en el bundle por
// diseño, es un constraint aceptado, no un descuido), así que esto NO es una
// barrera real contra alguien con ese token embebido y acceso a
// devtools/consola. Lo que sí evita es que un botón mal gateado, un bug de
// UI, o un uso "creativo" de las funciones exportadas de este archivo
// ejecute la operación sin pasar por una sesión real, vigente y con el rol o
// permiso correcto verificados contra la BD — no solo un booleano que el
// propio llamador podría fabricar.
async function loadActorSession(
  actor: Actor,
  permisos: Permiso[] = [],
): Promise<{ username: string; rol: string; activo: number; tiene_permiso: number } | undefined> {
  // Sesión y permisos en una sola consulta (un viaje a Turso en vez de dos).
  const placeholders = permisos.map((_, i) => `?${i + 3}`).join(", ");
  const permisoExpr = permisos.length
    ? `(SELECT COUNT(*) FROM user_permissions up WHERE up.user_id = users.id AND up.permiso IN (${placeholders}))`
    : "0";
  const result = await client.execute({
    sql: `SELECT username, rol, activo, ${permisoExpr} AS tiene_permiso FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [actor.id, actor.token, ...permisos],
  });
  return result.rows[0] as unknown as
    | { username: string; rol: string; activo: number; tiene_permiso: number }
    | undefined;
}

async function assertActorAuthorized(
  actor: Actor,
  requiredPermiso?: Permiso | Permiso[],
): Promise<string> {
  const permisos = requiredPermiso === undefined ? [] : Array.isArray(requiredPermiso) ? requiredPermiso : [requiredPermiso];
  const row = await loadActorSession(actor, permisos);
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  if (row.rol === "admin") return row.username;
  if (permisos.length === 0) {
    throw new Error("No autorizado: esta acción requiere una cuenta administradora.");
  }
  if (!Number(row.tiene_permiso)) {
    throw new Error("No autorizado: falta el permiso requerido para esta acción.");
  }
  return row.username;
}

// --- Sesiones (usuarios conectados) ---

const SESSION_STALE_SECONDS = 90;

export async function heartbeat(userId: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO user_sessions (user_id, last_seen) VALUES (?1, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET last_seen = datetime('now')`,
    args: [userId],
  });
  await client.execute({
    sql: `DELETE FROM user_sessions WHERE last_seen < datetime('now', ?1)`,
    args: [`-${SESSION_STALE_SECONDS} seconds`],
  });
}

// token identifica LA sesión que se está cerrando, no solo el usuario: sin
// esto, un logout con un token ya viejo (p.ej. una pestaña que quedó atrás)
// podía pisar session_token de una sesión más nueva del mismo usuario abierta
// después en otro dispositivo, cerrándola sin que esa persona hiciera nada.
// Mismo criterio que ya usan validateSession()/loadActorSession() (id AND
// session_token). La fila de presencia en user_sessions sigue limpiándose
// solo por user_id — no es sensible, es la tabla de "¿tiene la app abierta?".
export async function clearSession(userId: number, token: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM user_sessions WHERE user_id = ?1",
    args: [userId],
  });
  await client.execute({
    sql: "UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE id = ?1 AND session_token = ?2",
    args: [userId, token],
  });
}

export async function logEvent(
  nivel: LogLevel,
  mensaje: string,
  usuario?: string | null,
): Promise<void> {
  try {
    await client.execute({
      sql: "INSERT INTO app_logs (nivel, mensaje, usuario) VALUES (?1, ?2, ?3)",
      args: [nivel, mensaje, usuario ?? null],
    });
  } catch {
    // El registro nunca debe romper la aplicación.
  }
}

// Para eventos asociados a una acción de un usuario ya autenticado: resuelve
// el username desde la sesión verificada en la BD en vez de confiar en el
// string que arme el llamador (mismo motivo que assertActorSession/
// assertActorAuthorized). No usar para eventos que ocurren antes de tener
// una sesión válida (login fallido/bloqueado, restaurar sesión al abrir la
// app) — ahí no hay Actor que verificar, logEvent() sigue aceptando el
// string libre. Best-effort como logEvent(): un actor vencido/inválido no
// debe romper el flujo que está intentando registrar el evento, solo
// registra el evento sin usuario.
export async function logEventAsActor(actor: Actor, nivel: LogLevel, mensaje: string): Promise<void> {
  let usuario: string | null = null;
  try {
    const row = await loadActorSession(actor);
    usuario = row?.username ?? null;
  } catch {
    // best-effort, ver arriba.
  }
  await logEvent(nivel, mensaje, usuario);
}

// --- Folios (misma tabla `folios` que usa Clio; acá solo remisiones) ---

interface FolioRow {
  id: number;
  seccion: string;
  consecutivo: number;
  folio: string;
  sku: string;
  creado_en: string;
}

// Usada por createRemisionConFolio, que la corre dentro de un client.transaction
// junto con el INSERT del documento — así folio y documento se confirman o
// se revierten juntos, sin dejar un folio huérfano si el segundo INSERT falla.
async function insertFolioRow(
  execer: Client | Transaction,
  tipo: TipoFolio,
  sku: string,
): Promise<Folio> {
  // consecutivo se calcula dentro del mismo INSERT (subconsulta), no en un
  // SELECT previo por separado — mismo patrón que requisiciones.numero_dia,
  // mismo motivo (SQLite/libSQL serializa las escrituras). Acá el scope es
  // `seccion`, no `fecha`: el consecutivo de folios nunca se reinicia.
  const insertResult = await execer.execute({
    sql: `INSERT INTO folios (seccion, consecutivo, sku)
          VALUES (?1, (SELECT COALESCE(MAX(consecutivo), 0) + 1 FROM folios WHERE seccion = ?1), ?2)
          RETURNING *`,
    args: [tipo, sku],
  });
  const row = insertResult.rows[0] as unknown as FolioRow;
  // El folio queda "congelado" con el sku al momento de crearse — si el
  // código del producto cambia después, el folio histórico no se actualiza;
  // es intencional, es un documento inmutable.
  const folio = buildFolioString(FOLIO_PREFIJOS[tipo], sku, formatFechaFolioLocal(), row.consecutivo);
  await execer.execute({
    sql: "UPDATE folios SET folio = ?1 WHERE id = ?2",
    args: [folio, row.id],
  });
  return { id: row.id, seccion: tipo, consecutivo: row.consecutivo, folio, sku, creado_en: row.creado_en };
}

// --- Precios ---

interface PrecioRow {
  id: number;
  sku: string;
  sku_principal: string;
  nombre: string;
  precio: number;
  actualizado_en: string;
  actualizado_por: string | null;
  creado_en: string;
  tipo: string | null;
}

function rowToPrecio(row: PrecioRow): Precio {
  return {
    id: row.id,
    sku: row.sku,
    sku_principal: row.sku_principal,
    nombre: row.nombre,
    precio: row.precio,
    actualizado_en: row.actualizado_en,
    actualizado_por: row.actualizado_por,
    creado_en: row.creado_en,
    tipo: row.tipo === "interno" || row.tipo === "externo" ? row.tipo : null,
  };
}

function assertPrecioValido(precio: number): void {
  if (!Number.isFinite(precio) || precio < 0) {
    throw new Error("Ingresa un precio válido (mayor o igual a 0).");
  }
}

export async function upsertPrecio(
  actor: Actor,
  input: PrecioInput & {
    // Solo la usa la captura masiva — preserva la fecha declarada en el
    // Excel en vez del momento real de importación (ver src/precios.ts). La
    // edición manual desde PreciosModal nunca la pasa.
    actualizadoEn?: string;
  },
): Promise<Precio> {
  // Se llama tanto desde PreciosModal (precios_modificar) como desde
  // "Guardar producto" en RemisionForm (solo remisiones_crear) — cualquiera
  // de los dos habilita la escritura, para no restringir el flujo existente
  // de Remisiones.
  const username = await assertActorAuthorized(actor, ["precios_modificar", "remisiones_crear"]);
  assertPrecioValido(input.precio);
  const skuPrincipal = computeSkuPrincipal(input.sku);

  const tx = await client.transaction("write");
  try {
    const existing = await tx.execute({
      sql: "SELECT precio FROM precios WHERE sku = ?1",
      args: [input.sku],
    });
    const precioAnterior =
      (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

    const result = await tx.execute({
      sql: `INSERT INTO precios (sku, sku_principal, nombre, precio, actualizado_en, actualizado_por, tipo)
            VALUES (?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), ?6, ?7)
            ON CONFLICT(sku) DO UPDATE SET
              sku_principal = ?2, nombre = ?3, precio = ?4,
              actualizado_en = COALESCE(?5, datetime('now')), actualizado_por = ?6,
              tipo = COALESCE(?7, precios.tipo)
            RETURNING *`,
      args: [
        input.sku,
        skuPrincipal,
        input.nombre,
        input.precio,
        input.actualizadoEn ?? null,
        username,
        input.tipo ?? null,
      ],
    });
    const row = result.rows[0] as unknown as PrecioRow;

    await tx.execute({
      sql: "INSERT INTO precios_historial (sku, precio_anterior, precio_nuevo, usuario) VALUES (?1, ?2, ?3, ?4)",
      args: [input.sku, precioAnterior, input.precio, username],
    });

    await tx.commit();
    return rowToPrecio(row);
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Edita un precio existente permitiendo cambiar el SKU (identidad natural de
// la fila) — a diferencia de upsertPrecio, que solo puede crear/actualizar
// por SKU exacto y no puede "renombrarlo". Se identifica la fila por `id`

// PreciosModal (precios_ver/precios_modificar), RemisionForm/
// RemisionDetalleModal (remisiones_acceso/remisiones_crear).
const PRECIO_LECTURA_PERMISOS: Permiso[] = [
  "precios_ver",
  "precios_modificar",
  "remisiones_acceso",
  "remisiones_crear",
];

export async function getPrecio(actor: Actor, sku: string): Promise<Precio | null> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku = ?1",
    args: [sku],
  });
  const row = result.rows[0] as unknown as PrecioRow | undefined;
  return row ? rowToPrecio(row) : null;
}

export async function getPreciosBySkuPrincipal(actor: Actor, skuPrincipal: string): Promise<Precio[]> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku_principal = ?1 ORDER BY sku",
    args: [skuPrincipal],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

// Búsqueda para el renglón de una remisión: el SKU (normal o con letra, ej.
// "7078E") y el nombre que se muestran ahí son los de `precios`, no los de
// `products` — un SKU con letra puede no tener ficha técnica propia.
export async function searchPrecios(actor: Actor, query: string): Promise<Precio[]> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const trimmed = query.trim();
  if (!trimmed) return [];
  const result = await client.execute({
    sql: `SELECT * FROM precios WHERE ${foldSearchColumn("sku")} LIKE ?1 OR ${foldSearchColumn("nombre")} LIKE ?1 ORDER BY sku`,
    args: [`%${normalizeSearchTerm(trimmed)}%`],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

// --- Remisiones ---

interface RemisionRow {
  id: number;
  folio: string;
  fecha: string;
  tipo: string;
  pedido_bodegas: string | null;
  // Pueden faltar si la migración add-remisiones-cliente-externo-columns.mjs aún no corrió.
  cliente_rfc?: string | null;
  cliente_direccion?: string | null;
  cliente_contacto?: string | null;
  cliente_telefono?: string | null;
  cancelada: number;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
  usuario: string | null;
  creado_en: string;
}

function rowToRemision(row: RemisionRow): Remision {
  return {
    id: row.id,
    folio: row.folio,
    fecha: row.fecha,
    tipo: row.tipo as TipoRemision,
    pedido_bodegas: row.pedido_bodegas ?? "",
    cliente_rfc: row.cliente_rfc ?? "",
    cliente_direccion: row.cliente_direccion ?? "",
    cliente_contacto: row.cliente_contacto ?? "",
    cliente_telefono: row.cliente_telefono ?? "",
    cancelada: !!row.cancelada,
    subtotal: row.subtotal,
    descuento_pct: row.descuento_pct,
    descuento: row.descuento,
    iva: row.iva,
    total: row.total,
    precio_texto: row.precio_texto,
    usuario: row.usuario,
    creado_en: row.creado_en,
  };
}

// Misma fórmula que RemisionForm.tsx/RemisionDetalleModal.tsx — recalculada
// server-side (en vez de confiar en precio_unitario/importe/subtotal/
// descuento/iva/total/precio_texto tal como los mande el cliente) para que
// llamar estas funciones directamente con esos campos manipulados no pueda
// dejar una remisión con números inconsistentes. Si se cambia el % de IVA o
// la fórmula de negocio, hay que actualizar los tres lugares a la vez.
export const IVA_RATE = 0.16;

// Aritmética pura, sin validar — comparte el mismo cálculo entre el servidor
// (computeRemisionTotales abajo, que sí valida/lanza) y la vista previa en
// vivo de RemisionForm.tsx/RemisionDetalleModal.tsx (que ya hace su propia
// validación por renglón para mostrar errores puntuales, y no quiere que un
// campo a medio teclear tire una excepción en cada render). Único lugar que
// conoce la fórmula de negocio: IVA = Subtotal × IVA_RATE; Total = Subtotal
// − Descuento + IVA (se suma — regla de negocio documentada en
// docs/WORKFLOWS.md).
export function computeRemisionMontos(
  renglones: { cantidad: number; precio_unitario: number }[],
  descuentoPct: number,
): { subtotal: number; descuento: number; iva: number; total: number } {
  const subtotal = renglones.reduce((sum, r) => sum + r.cantidad * r.precio_unitario, 0);
  const descuento = subtotal * (descuentoPct / 100);
  const iva = subtotal * IVA_RATE;
  const total = subtotal - descuento + iva;
  return { subtotal, descuento, iva, total };
}

function computeRemisionTotales(
  renglones: RemisionRenglonInput[],
  descuentoPct: number,
): {
  renglones: RemisionRenglonInput[];
  subtotal: number;
  descuento: number;
  iva: number;
  total: number;
  precioTexto: string;
} {
  if (renglones.length === 0) {
    throw new Error("Agrega al menos un producto.");
  }
  if (!Number.isFinite(descuentoPct) || descuentoPct < 0 || descuentoPct > 100) {
    throw new Error("El descuento % debe estar entre 0 y 100.");
  }
  const recomputed = renglones.map((r) => {
    if (!Number.isFinite(r.cantidad) || r.cantidad <= 0) {
      throw new Error(`Cantidad inválida en el renglón de ${r.sku || "producto sin SKU"}.`);
    }
    if (!Number.isFinite(r.precio_unitario) || r.precio_unitario < 0) {
      throw new Error(`Precio inválido en el renglón de ${r.sku || "producto sin SKU"}.`);
    }
    return { ...r, importe: r.cantidad * r.precio_unitario };
  });
  const { subtotal, descuento, iva, total } = computeRemisionMontos(recomputed, descuentoPct);
  if (total < 0) {
    throw new Error("El total no puede quedar negativo — revisa el descuento.");
  }
  return { renglones: recomputed, subtotal, descuento, iva, total, precioTexto: numeroATextoMoneda(total) };
}

// Folio + header + renglones en una sola transacción interactiva. Antes,
// RemisionForm llamaba a createFolio() por separado (confirmaba el folio de
// inmediato) y luego a createRemision(), que sí escribía header+renglones
// atómicamente vía client.batch() — pero si ese batch fallaba (ej. la
// conexión cae justo después), el folio ya consumido quedaba huérfano: un
// "documento fantasma" con folio quemado y ninguna remisión real. Ahora todo
// se confirma o se revierte junto, así que un fallo nunca deja un folio sin
// su remisión ni una remisión sin (todos) sus renglones.
// El segundo parámetro se llama `bodega` (no `sku`, a diferencia de
// createFolio/createRequisicionConFolio): a pedido del negocio, el folio de
// remisión lleva el nombre de la bodega destino en el segmento donde los
// otros tres tipos (Requisición/Producción/Compra) llevan el SKU del
// producto — RemisionForm le pasa `pedido_bodegas`, no un SKU. En remisiones
// externas ese campo es el nombre del cliente, y el folio usa la sección
// `remision_externa` (prefijo REMEX, consecutivo propio desde 00001).
export async function createRemisionConFolio(
  actor: Actor,
  bodega: string,
  input: Omit<RemisionInput, "folio" | "subtotal" | "descuento" | "iva" | "total" | "precio_texto" | "usuario">,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  const username = await assertActorAuthorized(actor, "remisiones_crear");
  const totales = computeRemisionTotales(renglones, input.descuento_pct);
  const tx = await client.transaction("write");
  try {
    const folio = await insertFolioRow(tx, input.tipo === "externa" ? "remision_externa" : "remision", bodega);

    // Las columnas cliente_* solo se escriben en externas y solo si hay algún dato
    // capturado: son opcionales, y así una remisión sin esos datos (y toda interna)
    // se guarda igual aunque la migración de esas columnas no haya corrido.
    const clienteTodas: [string, string][] =
      input.tipo === "externa"
        ? [
            ["cliente_rfc", input.cliente_rfc?.trim() ?? ""],
            ["cliente_direccion", input.cliente_direccion?.trim() ?? ""],
            ["cliente_contacto", input.cliente_contacto?.trim() ?? ""],
            ["cliente_telefono", input.cliente_telefono?.trim() ?? ""],
          ]
        : [];
    const clienteCols = clienteTodas.some(([, value]) => value) ? clienteTodas : [];
    const headerArgs = [
      folio.folio,
      input.fecha,
      input.tipo,
      input.pedido_bodegas,
      totales.subtotal,
      input.descuento_pct,
      totales.descuento,
      totales.iva,
      totales.total,
      totales.precioTexto,
      username,
      ...clienteCols.map(([, value]) => value),
    ];
    const headerResult = await tx.execute({
      sql: `INSERT INTO remisiones
              (folio, fecha, tipo, pedido_bodegas, subtotal, descuento_pct, descuento, iva, total, precio_texto, usuario${clienteCols.map(([c]) => `, ${c}`).join("")})
            VALUES (${headerArgs.map((_, i) => `?${i + 1}`).join(", ")})
            RETURNING *`,
      args: headerArgs,
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow;

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of totales.renglones.entries()) {
      const rowResult = await tx.execute({
        sql: `INSERT INTO remision_renglones
                (remision_id, numero_renglon, sku, producto_nombre, cantidad, precio_unitario, importe)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
              RETURNING *`,
        args: [headerRow.id, i + 1, r.sku, r.producto_nombre, r.cantidad, r.precio_unitario, r.importe],
      });
      savedRenglones.push(rowResult.rows[0] as unknown as RemisionRenglon);
    }

    await tx.commit();
    cacheInvalidate("remisiones|");
    return { ...rowToRemision(headerRow), renglones: savedRenglones };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Edita una remisión existente conservando folio, fecha, tipo, usuario
// (creador) y creado_en — actualiza pedido_bodegas y los totales
// (recalculados a partir de los renglones editados) y reemplaza los
// renglones por completo (mismo patrón replace-and-reinsert que
// specs/descriptions), nunca genera un folio nuevo ni una segunda remisión.
export async function updateRemisionConRenglones(
  actor: Actor,
  id: number,
  totalesInput: Pick<RemisionInput, "pedido_bodegas" | "descuento_pct">,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  await assertActorAuthorized(actor, "remisiones_crear");
  const totales = computeRemisionTotales(renglones, totalesInput.descuento_pct);
  const tx = await client.transaction("write");
  try {
    const headerResult = await tx.execute({
      sql: `UPDATE remisiones
              SET pedido_bodegas = ?1, subtotal = ?2, descuento_pct = ?3, descuento = ?4, iva = ?5,
                  total = ?6, precio_texto = ?7
            WHERE id = ?8
            RETURNING *`,
      args: [
        totalesInput.pedido_bodegas,
        totales.subtotal,
        totalesInput.descuento_pct,
        totales.descuento,
        totales.iva,
        totales.total,
        totales.precioTexto,
        id,
      ],
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow | undefined;
    if (!headerRow) throw new Error("Remisión no encontrada.");

    await tx.execute({ sql: "DELETE FROM remision_renglones WHERE remision_id = ?1", args: [id] });

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of totales.renglones.entries()) {
      const rowResult = await tx.execute({
        sql: `INSERT INTO remision_renglones
                (remision_id, numero_renglon, sku, producto_nombre, cantidad, precio_unitario, importe)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
              RETURNING *`,
        args: [id, i + 1, r.sku, r.producto_nombre, r.cantidad, r.precio_unitario, r.importe],
      });
      savedRenglones.push(rowResult.rows[0] as unknown as RemisionRenglon);
    }

    await tx.commit();
    cacheInvalidate("remisiones|");
    return { ...rowToRemision(headerRow), renglones: savedRenglones };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function listRemisiones(actor: Actor, limit?: number): Promise<Remision[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  const cacheKey = `remisiones|${limit ?? "all"}`;
  const cached = cacheGet<Remision[]>(cacheKey);
  if (cached) return cached.slice();
  const result =
    limit === undefined
      ? await client.execute("SELECT * FROM remisiones ORDER BY id DESC")
      : await client.execute({ sql: "SELECT * FROM remisiones ORDER BY id DESC LIMIT ?1", args: [limit] });
  return cacheSet(cacheKey, (result.rows as unknown as RemisionRow[]).map(rowToRemision));
}

// Índice mínimo (remisión → SKU/nombre de sus productos) para que el buscador
// del Historial de remisiones encuentre todas las remisiones donde aparece un
// producto, sin cargar renglones completos ni abrir cada remisión. Usa el
// snapshot de remision_renglones, igual que el resto del historial.
export async function listRemisionProductosIndex(
  actor: Actor,
): Promise<{ remision_id: number; sku: string; producto_nombre: string }[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  const cacheKey = "remisiones|productos-index";
  const cached = cacheGet<{ remision_id: number; sku: string; producto_nombre: string }[]>(cacheKey);
  if (cached) return cached.slice();
  const result = await client.execute("SELECT remision_id, sku, producto_nombre FROM remision_renglones");
  return cacheSet(
    cacheKey,
    result.rows as unknown as { remision_id: number; sku: string; producto_nombre: string }[],
  );
}

export async function getRemisionRenglones(actor: Actor, remisionId: number): Promise<RemisionRenglon[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  const result = await client.execute({
    sql: "SELECT * FROM remision_renglones WHERE remision_id = ?1 ORDER BY numero_renglon",
    args: [remisionId],
  });
  return result.rows as unknown as RemisionRenglon[];
}

// Mismo patrón que deletePrintItemOrder/deletePrintItemPurchase (Imprenta):
// borrado real, no un flag — remision_renglones se borra primero por la FK.
export async function deleteRemision(actor: Actor, id: number): Promise<void> {
  const username = await assertActorAuthorized(actor, "remisiones_cancelar");
  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "DELETE FROM remision_renglones WHERE remision_id = ?1", args: [id] });
    await tx.execute({ sql: "DELETE FROM remisiones WHERE id = ?1", args: [id] });
    await tx.commit();
    cacheInvalidate("remisiones|");
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
  await logEvent("WARNING", `Remisión #${id} eliminada`, username);
}

// Sin chequeo de Actor a propósito — es un helper interno, cada exportado
// que la llama (listRemisionRenglonesParaHistorial, getSkuMasterExportData)
// hace su propio assertActorAuthorized con el permiso de su propia pantalla
// antes de invocarla, mismo criterio que el resto de queries de soporte.
async function fetchRemisionRenglonesHistorial(): Promise<RemisionHistorialRow[]> {
  const result = await client.execute(`
    SELECT
      r.fecha AS fecha, r.folio AS folio, r.pedido_bodegas AS pedido_bodegas, r.cancelada AS cancelada,
      rr.numero_renglon AS numero_renglon, rr.sku AS sku, rr.cantidad AS cantidad,
      rr.producto_nombre AS producto_nombre, rr.precio_unitario AS precio_unitario, rr.importe AS importe,
      r.subtotal AS subtotal, r.descuento_pct AS descuento_pct, r.descuento AS descuento, r.iva AS iva, r.total AS total
    FROM remision_renglones rr
    JOIN remisiones r ON r.id = rr.remision_id
    ORDER BY r.fecha, r.id, rr.numero_renglon
  `);
  return (
    result.rows as unknown as (Omit<RemisionHistorialRow, "pedido_bodegas" | "cancelada"> & {
      pedido_bodegas: string | null;
      cancelada: number;
    })[]
  ).map((row) => ({
    ...row,
    pedido_bodegas: row.pedido_bodegas ?? "",
    cancelada: !!row.cancelada,
  }));
}

export async function listRemisionRenglonesParaHistorial(actor: Actor): Promise<RemisionHistorialRow[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  return fetchRemisionRenglonesHistorial();
}

// --- Catálogo en lista (solo lectura) ---

const CATALOGO_CACHE_KEY = "catalogo|lista";
const PRECIO_VENTA_LECTURA_PERMISOS: Permiso[] = ["precios_venta_ver", "precios_venta_modificar"];

// El catálogo base (código, nombre, categoría, material) es abierto a todo
// usuario autenticado, igual que en Clio; los precios de venta no: solo los
// trae si el usuario tiene precios_venta_ver/modificar (o es admin) — la
// misma regla que Clio aplica en getPreciosVenta, verificada acá contra la
// BD y no solo ocultando columnas en la UI. Sin las columnas de imagen
// (BLOB): una lista no las usa y traerlas vuelve lenta la carga.
export async function listCatalogo(actor: Actor): Promise<Catalogo> {
  const session = await loadActorSession(actor, PRECIO_VENTA_LECTURA_PERMISOS);
  if (!session || !session.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  const preciosVisibles = session.rol === "admin" || Number(session.tiene_permiso) > 0;

  const cacheKey = `${CATALOGO_CACHE_KEY}|${preciosVisibles ? "con-precios" : "sin-precios"}`;
  const cached = cacheGet<Catalogo>(cacheKey);
  if (cached) return { ...cached, items: cached.items.slice() };

  const productos = await client.execute(
    "SELECT id, codigo, nombre, categoria, material FROM products ORDER BY nombre, material",
  );
  const preciosPorProducto = new Map<number, Partial<Record<PrecioVentaCategoria, number | null>>>();
  if (preciosVisibles) {
    const precios = await client.execute("SELECT product_id, categoria, precio FROM precios_venta");
    for (const row of precios.rows as unknown as {
      product_id: number;
      categoria: PrecioVentaCategoria;
      precio: number | null;
    }[]) {
      const deProducto = preciosPorProducto.get(row.product_id) ?? {};
      deProducto[row.categoria] = row.precio;
      preciosPorProducto.set(row.product_id, deProducto);
    }
  }

  const items = (
    productos.rows as unknown as { id: number; codigo: string; nombre: string; categoria: string; material: string }[]
  ).map((row) => {
    const deProducto = preciosPorProducto.get(row.id) ?? {};
    return {
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      categoria: row.categoria,
      material: row.material,
      precios: Object.fromEntries(
        PRECIOS_VENTA_CATEGORIAS.map((categoria) => [categoria, deProducto[categoria] ?? null]),
      ) as Record<PrecioVentaCategoria, number | null>,
    };
  });
  return cacheSet(cacheKey, { items, preciosVisibles });
}

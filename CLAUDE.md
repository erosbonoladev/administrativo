# CLAUDE.md

Guía para Claude Code en este repo. Esto es un **índice**: reglas siempre vigentes + comandos. El detalle de flujos vive en `docs/`. Ver también `AGENTS.md` (mismo contenido, mantenido para Codex y otros agentes) — si editas uno, edita el otro para que no se desincronicen.

## Qué es

**Administrativo**: app de escritorio para el área administrativa de la imprenta. Nació al dividir **Clio** (repo `Clio`, catálogo + secciones de producción) en dos apps; lo único administrativo que tenía Clio era **Remisiones**, que se mudó acá. Tiene dos módulos:

- **Remisiones** — documentos de venta (internas y externas) con PDF sobre plantilla oficial, historial, edición, borrado y exportación a Excel. Flujo completo: [docs/WORKFLOWS.md](docs/WORKFLOWS.md).
- **Catálogo en lista** — lista simple, de solo lectura, de las fichas (SKU, nombre, categoría, material) con sus precios de venta si el usuario tiene permiso. Sin imágenes, sin ficha de detalle, sin edición (eso sigue en Clio).

Corre en Windows y macOS contra **la misma BD cloud (Turso) que Clio**. No tiene BD propia ni esquema propio.

## Stack

Tauri v2 (Rust + webview) + React 19 + TypeScript. BD: Turso/libSQL vía `@libsql/client/web` (sin plugin de Tauri). PDF: `jspdf`. Excel: `xlsx`. Pruebas de integridad con Vitest.

## Comandos

Node/Rust vía `nvm`/`rustup`; si una shell nueva no los encuentra: `source ~/.zshrc`.

Requiere `.env` en la raíz (gitignored) con `VITE_TURSO_URL` y `VITE_TURSO_AUTH_TOKEN` — los **mismos valores que el `.env` de Clio** (ver `.env.example`). Se hornean en el bundle en build time.

- `npm run tauri dev` — app completa (Rust+webview). Puerto de Vite **1421** (Clio usa 1420), así que las dos pueden correr a la vez.
- `npm run dev` — solo frontend en navegador; no sirve para login (el hash de contraseña es un comando Rust).
- `npx tsc --noEmit` — type-check. `npm run build` — type-check + build de producción.
- `cd src-tauri && cargo check` — chequeo rápido de Rust.
- `npm test` — pruebas de integridad contra un SQLite local descartable (`.env.test`, `tests/`), nunca contra Turso; `vitest.config.ts` redirige `@libsql/client/web` al cliente Node solo bajo pruebas.

Antes de dar por cerrada una tarea que toca lógica de negocio, corré `npx tsc --noEmit` y `npm test`; si tocás `src/db.ts`, agregá o extendé pruebas en `tests/`.

## Relación con Clio (leer antes de tocar `db.ts` o permisos)

- **Clio es dueño del esquema.** Las tablas y columnas las crea y migra Clio (`scripts/add-*.mjs` de ese repo, ver su `docs/DATABASE.md`). Acá nunca se hace `CREATE`/`ALTER`/`DROP`. Las tablas que esta app usa: `users`, `user_permissions`, `user_sessions`, `app_logs`, `folios`, `precios`, `precios_historial`, `precios_venta`, `products` (solo lectura), `remisiones`, `remision_renglones`. `tests/schema.ts` es una copia de las definiciones de Clio — si allá cambia una columna que acá se usa, actualizá ambos.
- **Usuarios, roles y permisos se administran en Clio** (`UsersPanel`). Esta app no tiene administración de usuarios. Permisos que consulta: `remisiones_acceso`/`remisiones_crear`/`remisiones_cancelar`, `precios_venta_ver`/`precios_venta_modificar`, `precios_ver`/`precios_modificar`. Si se renombra uno en Clio, hay que renombrarlo acá también (son strings en la BD).
- **Código duplicado a propósito** (viven en repos distintos, no se puede compartir un import): `db.ts` (login/sesión/`Actor`/folios/precios/remisiones), `dbResilience.ts`, `folios.ts`, `precios.ts` (`computeSkuPrincipal`, `parseAmount`), `numeroALetras.ts`, `remisionLayout.ts` y la plantilla de PDF. Si cambia la fórmula de IVA/total, el formato de folio o `computeSkuPrincipal` en un lado, revisar el otro.
- **Una sola sesión por usuario.** La sesión vive en `users.session_token` (como en Clio), una sola por usuario: iniciar sesión en Clio con el mismo usuario invalida la sesión de esta app (y al revés) — la otra app lo nota a más tardar en 5 min (revalidación) o en la siguiente escritura. Es una limitación conocida; la solución es una sesión por app (columnas o tabla aparte), que requiere una migración desde Clio.
- **Auto-update:** igual que Clio (`tauri-plugin-updater` + Update API de Clio, `docs/DISTRIBUTION.md`), pero **sin activación**: el endpoint es `/updates/administrativo/*` del Worker de Clio, sin credencial de instalación. Código en `src/updateContext.tsx` + `src/components/UpdateChecker.tsx` (Sidebar). Versión en `package.json`, `src-tauri/Cargo.toml` y `tauri.conf.json` (las tres).
- **Restauración de BD:** no hay panel de backups/restauración acá. Es la misma BD que Clio: una restauración hecha en Clio ya aplica a esta app (reemplaza `users`/sesiones; esta app lo nota en su revalidación y pide login de nuevo). Backups siguen siendo de Clio y `clio-backups`.
- **Fuera de alcance:** gate de activación por credencial (`ActivationGate`) y backups propios. No agregar sin acordarlo — implica tocar `update-api/` y GitHub Actions del lado de Clio.

## Reglas SIEMPRE vigentes

- Toda query va en `src/db.ts`, nunca inline en un componente — es la única puerta a la BD.
- Sin router: la navegación es un `useState` en `App.tsx`.
- Toda pantalla gateada (`hasPermission`) chequea en su propio render, no solo ocultando el botón de entrada. El catálogo base (código, nombre, categoría, material) es abierto a todo usuario autenticado, igual que en Clio; los **precios** de venta no: `listCatalogo` los omite en el servidor sin `precios_venta_ver`/`precios_venta_modificar`.
- Toda escritura (y lectura sensible) en `db.ts` recibe un `Actor` (`{id, token}`) y lo verifica contra la BD (`assertActorAuthorized`/`loadActorSession`) antes de ejecutar — defensa en profundidad, no un sustituto de backend real (el token de Turso va embebido en el bundle por diseño). Función nueva, mismo patrón; no la dejes sin Actor.
- Operaciones que escriben más de una tabla/fila como una unidad lógica van en una transacción (`client.transaction("write")`) — folio+remisión+renglones, borrado en cascada.
- El precio/nombre guardado en `remision_renglones` es un snapshot histórico — nunca se recalcula ni se vuelve a leer de `precios`/`products` después de creada la remisión.
- Nunca meter un PAT de GitHub, una clave de firma ni un token administrativo de Turso en el bundle (no en `.env` con prefijo `VITE_`).
- El nombre visible de la app es **"Administrativo"** (ventana, instalador). El `identifier` (`com.mariat.administrativo`) no se cambia una vez distribuida la app.
- Cambiar una capability de Tauri: el `<plugin>:default` casi nunca alcanza — revisar `permissions/default.toml` del crate; requiere rebuild completo, no HMR. El scope de `fs` es solo `appData`; un path elegido en un diálogo se habilita en runtime con `allowFsPath` justo después del diálogo (comando Rust `allow_fs_path`).

## Convenciones de código

- Sin comentarios salvo que el *por qué* no sea obvio.
- No agregar abstracciones/validaciones para casos que no pueden pasar.

## Documentación

| Tarea | Leer |
|---|---|
| Flujo de Remisiones (internas/externas, folios, PDF, historial, edición), catálogo en lista | [docs/WORKFLOWS.md](docs/WORKFLOWS.md) |
| Auto-update, publicar una versión, restauración de BD | [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) |
| Esquema de BD, permisos y sesión en detalle | Repo Clio: `docs/DATABASE.md`, `docs/PERMISSIONS.md` |

App: `com.mariat.administrativo` / "Administrativo".

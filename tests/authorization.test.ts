import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  createRemisionConFolio,
  getPrecio,
  getRemisionRenglones,
  listCatalogo,
  listRemisiones,
  listRemisionRenglonesParaHistorial,
  logEventAsActor,
  searchPrecios,
  upsertPrecio,
  validateSession,
} from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("sesión — cualquier lectura/escritura exige una sesión vigente y activa", () => {
  it("rechaza un token que no existe", async () => {
    await expect(listCatalogo({ id: 999999, token: "nope" })).rejects.toThrow(/no autorizado/i);
  });

  it("rechaza una sesión vencida", async () => {
    const user = await createFixtureUser({ username: "vencido", expired: true });
    await expect(listCatalogo(user)).rejects.toThrow(/no autorizado/i);
  });

  it("rechaza un usuario inactivo aunque el token sea correcto", async () => {
    const user = await createFixtureUser({ username: "inactivo", activo: false });
    await expect(listCatalogo(user)).rejects.toThrow(/no autorizado/i);
  });

  it("acepta cualquier usuario autenticado en el catálogo base, sin permiso específico", async () => {
    const user = await createFixtureUser({ username: "cualquiera", permisos: [] });
    await expect(listCatalogo(user)).resolves.toMatchObject({ items: [] });
  });
});

describe("clearSession — cierra por id+token, nunca pisa una sesión más nueva del mismo usuario", () => {
  it("invalida la sesión cuando el token coincide", async () => {
    const user = await createFixtureUser({ username: "cierre_normal" });
    await expect(validateSession(user.id, user.token)).resolves.not.toBeNull();

    await clearSession(user.id, user.token);

    await expect(validateSession(user.id, user.token)).resolves.toBeNull();
  });

  it("una sesión de Clio (session_token) no es válida acá, y el logout acá no la cierra", async () => {
    const user = await createFixtureUser({ username: "dos_apps" });
    await rawClient().execute({
      sql: "UPDATE users SET session_token = 'token-clio', session_expires_at = datetime('now', '+12 hours') WHERE id = ?1",
      args: [user.id],
    });

    await expect(validateSession(user.id, "token-clio")).resolves.toBeNull();
    await expect(validateSession(user.id, user.token)).resolves.not.toBeNull();

    await clearSession(user.id, user.token);

    const row = (await rawClient().execute({
      sql: "SELECT session_token, admin_session_token FROM users WHERE id = ?1",
      args: [user.id],
    })).rows[0];
    expect(row.session_token).toBe("token-clio");
    expect(row.admin_session_token).toBeNull();
  });

  it("un logout con un token viejo no invalida una sesión más nueva del mismo usuario (p. ej. logueado después en otro equipo)", async () => {
    const user = await createFixtureUser({ username: "dos_sesiones" });
    const tokenViejo = user.token;

    const tokenNuevo = "token-sesion-nueva";
    await rawClient().execute({
      sql: "UPDATE users SET admin_session_token = ?1, admin_session_expires_at = datetime('now', '+12 hours') WHERE id = ?2",
      args: [tokenNuevo, user.id],
    });

    await clearSession(user.id, tokenViejo);

    await expect(validateSession(user.id, tokenNuevo)).resolves.not.toBeNull();
  });
});

describe("upsertPrecio y lecturas de precios — precios_modificar O remisiones_crear", () => {
  it("rechaza a un usuario sin ninguno de los dos permisos", async () => {
    const user = await createFixtureUser({ username: "ninguno", permisos: ["precios_venta_ver"] });
    await expect(upsertPrecio(user, { sku: "Y", nombre: "Y", precio: 1 })).rejects.toThrow(/no autorizado/i);
  });

  it("acepta con precios_modificar solamente", async () => {
    const user = await createFixtureUser({ username: "soloprecios", permisos: ["precios_modificar"] });
    await expect(upsertPrecio(user, { sku: "Y1", nombre: "Y1", precio: 1 })).resolves.toMatchObject({ sku: "Y1" });
  });

  it("acepta con remisiones_crear solamente (flujo 'Guardar producto' de la remisión)", async () => {
    const user = await createFixtureUser({ username: "soloremisiones", permisos: ["remisiones_crear"] });
    await expect(upsertPrecio(user, { sku: "Y2", nombre: "Y2", precio: 1 })).resolves.toMatchObject({ sku: "Y2" });
  });

  it("getPrecio/searchPrecios rechazan sin permiso y aceptan con remisiones_acceso", async () => {
    const creador = await createFixtureUser({ username: "creador-precio", permisos: ["precios_modificar"] });
    await upsertPrecio(creador, { sku: "BUSCA1", nombre: "Producto buscable", precio: 5 });

    const sinPermiso = await createFixtureUser({ username: "sinpermisoprecio", permisos: [] });
    await expect(getPrecio(sinPermiso, "BUSCA1")).rejects.toThrow(/no autorizado/i);
    await expect(searchPrecios(sinPermiso, "buscable")).rejects.toThrow(/no autorizado/i);

    const conAcceso = await createFixtureUser({ username: "conaccesoprecio", permisos: ["remisiones_acceso"] });
    await expect(searchPrecios(conAcceso, "buscable")).resolves.toHaveLength(1);
  });
});

describe("lecturas de remisiones — gate de Actor/permiso", () => {
  const baseInput = {
    fecha: "2026-09-04",
    tipo: "interna" as const,
    pedido_bodegas: "JALISCO",
    descuento_pct: 0,
  };
  const renglon = { sku: "R1", producto_nombre: "R1", cantidad: 1, precio_unitario: 100, importe: 100 };

  it("listRemisiones/getRemisionRenglones rechazan sin remisiones_acceso, aceptan con el permiso", async () => {
    const creador = await createFixtureUser({ username: "creador-lect", permisos: ["remisiones_crear"] });
    const created = await createRemisionConFolio(creador, "R1", baseInput, [renglon]);

    const sinAcceso = await createFixtureUser({ username: "sinacceso", permisos: [] });
    await expect(listRemisiones(sinAcceso)).rejects.toThrow(/no autorizado/i);
    await expect(getRemisionRenglones(sinAcceso, created.id)).rejects.toThrow(/no autorizado/i);

    const conAcceso = await createFixtureUser({ username: "conacceso", permisos: ["remisiones_acceso"] });
    await expect(listRemisiones(conAcceso)).resolves.toEqual(expect.any(Array));
    await expect(getRemisionRenglones(conAcceso, created.id)).resolves.toHaveLength(1);
  });

  it("listRemisionRenglonesParaHistorial (exportación a Excel) exige remisiones_acceso", async () => {
    const sinPermiso = await createFixtureUser({ username: "sinexport", permisos: ["backups_ver"] });
    await expect(listRemisionRenglonesParaHistorial(sinPermiso)).rejects.toThrow(/no autorizado/i);

    const conPermiso = await createFixtureUser({ username: "conexport", permisos: ["remisiones_acceso"] });
    await expect(listRemisionRenglonesParaHistorial(conPermiso)).resolves.toEqual(expect.any(Array));
  });
});

describe("logEventAsActor — resuelve el usuario desde la sesión verificada, nunca de un string aparte", () => {
  it("registra el evento con el username del Actor verificado", async () => {
    const user = await createFixtureUser({ username: "logueado", permisos: [] });
    await logEventAsActor(user, "INFO", "evento con actor");

    const logs = await rawClient().execute({
      sql: "SELECT usuario FROM app_logs WHERE mensaje = 'evento con actor'",
      args: [],
    });
    expect(logs.rows[0]?.usuario).toBe("logueado");
  });

  it("es best-effort: un actor inválido no rompe el flujo, solo registra sin usuario", async () => {
    await expect(
      logEventAsActor({ id: 999999, token: "nope" }, "INFO", "evento con actor invalido"),
    ).resolves.toBeUndefined();

    const logs = await rawClient().execute({
      sql: "SELECT usuario FROM app_logs WHERE mensaje = 'evento con actor invalido'",
      args: [],
    });
    expect(logs.rows[0]?.usuario).toBeNull();
  });
});

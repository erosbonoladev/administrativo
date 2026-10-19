import { beforeEach, describe, expect, it } from "vitest";
import { listCatalogo } from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function seedProducto(codigo: string, nombre: string, material = "", categoria = ""): Promise<number> {
  const result = await rawClient().execute({
    sql: "INSERT INTO products (codigo, nombre, categoria, material, descripcion) VALUES (?1, ?2, ?3, ?4, '')",
    args: [codigo, nombre, categoria, material],
  });
  return Number(result.lastInsertRowid);
}

async function seedPrecioVenta(productId: number, categoria: string, precio: number | null): Promise<void> {
  await rawClient().execute({
    sql: "INSERT INTO precios_venta (product_id, categoria, precio) VALUES (?1, ?2, ?3)",
    args: [productId, categoria, precio],
  });
}

describe("listCatalogo", () => {
  it("lista todas las fichas ordenadas por nombre y material, sin traer imágenes", async () => {
    await seedProducto("B1", "Memorama", "Cartón");
    await seedProducto("A1", "Lotería", "Cartón", "Juegos");
    await seedProducto("A2", "Lotería", "Madera");
    const user = await createFixtureUser({ username: "lector" });

    const { items } = await listCatalogo(user);

    expect(items.map((i) => i.codigo)).toEqual(["A1", "A2", "B1"]);
    expect(items[0]).toMatchObject({ nombre: "Lotería", categoria: "Juegos", material: "Cartón" });
    expect(items[0]).not.toHaveProperty("imagen");
  });

  it("sin precios_venta_ver no trae precios ni los marca como visibles — verificado server-side, no solo ocultando columnas", async () => {
    const id = await seedProducto("P1", "Producto");
    await seedPrecioVenta(id, "Mayoreo", 99);
    const user = await createFixtureUser({ username: "sinprecios", permisos: ["remisiones_acceso"] });

    const catalogo = await listCatalogo(user);

    expect(catalogo.preciosVisibles).toBe(false);
    expect(catalogo.items[0].precios.Mayoreo).toBeNull();
  });

  it("con precios_venta_ver trae las 5 categorías, null donde no hay precio", async () => {
    const id = await seedProducto("P1", "Producto");
    await seedPrecioVenta(id, "Mayoreo", 99);
    await seedPrecioVenta(id, "Gobierno", null);
    const user = await createFixtureUser({ username: "conprecios", permisos: ["precios_venta_ver"] });

    const catalogo = await listCatalogo(user);

    expect(catalogo.preciosVisibles).toBe(true);
    expect(catalogo.items[0].precios).toEqual({
      Gobierno: null,
      Representante: null,
      Mayoreo: 99,
      "Medio mayoreo": null,
      "Publico sugerido": null,
    });
  });

  it("un admin ve precios sin tener el permiso otorgado explícitamente", async () => {
    const id = await seedProducto("P1", "Producto");
    await seedPrecioVenta(id, "Publico sugerido", 150);
    const admin = await createFixtureUser({ username: "admin-cat", rol: "admin" });

    const catalogo = await listCatalogo(admin);

    expect(catalogo.preciosVisibles).toBe(true);
    expect(catalogo.items[0].precios["Publico sugerido"]).toBe(150);
  });

  it("la cache no mezcla la vista con precios de un usuario con la vista sin precios de otro", async () => {
    const id = await seedProducto("P1", "Producto");
    await seedPrecioVenta(id, "Mayoreo", 99);
    const conPrecios = await createFixtureUser({ username: "cache-con", permisos: ["precios_venta_modificar"] });
    const sinPrecios = await createFixtureUser({ username: "cache-sin", permisos: [] });

    await listCatalogo(conPrecios);
    const vistaSin = await listCatalogo(sinPrecios);

    expect(vistaSin.preciosVisibles).toBe(false);
    expect(vistaSin.items[0].precios.Mayoreo).toBeNull();
  });
});

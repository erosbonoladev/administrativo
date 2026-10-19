// Subconjunto de los tipos de Clio: solo lo que usan Remisiones y el catálogo
// en lista. La BD es la misma que la de Clio, así que los nombres de permisos
// y de columnas tienen que coincidir tal cual con los de allá.

export type Rol = "usuario" | "admin";

// Permisos que esta app consulta. La lista completa (y quién los otorga) vive
// en Clio (UsersPanel) — acá no hay administración de usuarios.
export const PERMISOS = [
  "precios_ver",
  "precios_modificar",
  "precios_venta_ver",
  "precios_venta_modificar",
  "remisiones_acceso",
  "remisiones_crear",
  "remisiones_cancelar",
] as const;
export type Permiso = (typeof PERMISOS)[number];

export interface User {
  id: number;
  username: string;
  activo: boolean;
  rol: Rol;
  permisos: Permiso[];
  creado_en: string;
}

export type LogLevel = "INFO" | "WARNING" | "ERROR";

export type TipoFolio = "remision" | "remision_externa";

export interface Folio {
  id: number;
  seccion: TipoFolio;
  consecutivo: number;
  folio: string;
  sku: string;
  creado_en: string;
}

// --- Precios ---

export type TipoPrecio = "interno" | "externo";

export interface Precio {
  id: number;
  sku: string;
  sku_principal: string;
  nombre: string;
  precio: number;
  actualizado_en: string;
  actualizado_por: string | null;
  creado_en: string;
  // NULL = productos guardados antes de esta clasificación — se tratan como
  // "interno", nunca como "externo".
  tipo: TipoPrecio | null;
}

export interface PrecioInput {
  sku: string;
  nombre: string;
  precio: number;
  // Opcional: si se omite al actualizar un precio existente, upsertPrecio()
  // conserva la clasificación que ya tenía (COALESCE en su query).
  tipo?: TipoPrecio;
}

// Nombres fijos (mismos que en Clio).
export const PRECIOS_VENTA_CATEGORIAS = [
  "Gobierno",
  "Representante",
  "Mayoreo",
  "Medio mayoreo",
  "Publico sugerido",
] as const;
export type PrecioVentaCategoria = (typeof PRECIOS_VENTA_CATEGORIAS)[number];

// --- Catálogo en lista (solo lectura) ---

export interface CatalogoItem {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  // null = la categoría no tiene precio asignado todavía.
  precios: Record<PrecioVentaCategoria, number | null>;
}

export interface Catalogo {
  items: CatalogoItem[];
  // false = el usuario no tiene precios_venta_ver/modificar; `precios` viene
  // todo en null y la UI no debe mostrar las columnas de precio.
  preciosVisibles: boolean;
}

// --- Remisiones ---

export type TipoRemision = "interna" | "externa";

export interface Remision {
  id: number;
  folio: string;
  fecha: string;
  tipo: TipoRemision;
  pedido_bodegas: string;
  // Solo remisiones externas (pedido_bodegas es el nombre del cliente); "" en internas.
  cliente_rfc: string;
  cliente_direccion: string;
  cliente_contacto: string;
  cliente_telefono: string;
  cancelada: boolean;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
  usuario: string | null;
  creado_en: string;
}

export interface RemisionRenglon {
  id: number;
  remision_id: number;
  numero_renglon: number;
  sku: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  importe: number;
}

export interface RemisionRenglonInput {
  sku: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  importe: number;
}

export interface RemisionInput {
  folio: string;
  fecha: string;
  tipo: TipoRemision;
  pedido_bodegas: string;
  cliente_rfc?: string;
  cliente_direccion?: string;
  cliente_contacto?: string;
  cliente_telefono?: string;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
}

export interface RemisionConRenglones extends Remision {
  renglones: RemisionRenglon[];
}

export interface RemisionHistorialRow {
  fecha: string;
  folio: string;
  pedido_bodegas: string;
  cancelada: boolean;
  numero_renglon: number;
  sku: string;
  cantidad: number;
  producto_nombre: string;
  precio_unitario: number;
  importe: number;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
}

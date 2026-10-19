/**
 * Esquema mínimo para pruebas de integridad: solo las tablas que lee/escribe
 * esta app. La BD real es la misma de Clio (que es quien la crea y migra, ver
 * sus scripts/add-*.mjs), así que estas definiciones son una copia de las de
 * Clio (tests/schema.ts de ese repo) — si allá cambia una columna que usa
 * Administrativo, actualizar este archivo también. Es fuente de verdad solo
 * para pruebas, no para producción.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    categoria TEXT,
    material TEXT,
    descripcion TEXT,
    imagen BLOB,
    imagen_mime TEXT,
    imagen_codigo_barras BLOB,
    imagen_codigo_barras_mime TEXT,
    tipo_producto TEXT,
    codigo_barras_texto TEXT,
    presentacion_original TEXT,
    dimensiones_empaque TEXT,
    juegos_por_empaque TEXT,
    peso_empaque TEXT,
    volumen_empaque TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_en TEXT
  )`,
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    rol TEXT NOT NULL DEFAULT 'usuario',
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    session_token TEXT,
    session_expires_at TEXT,
    admin_session_token TEXT,
    admin_session_expires_at TEXT,
    backup_local_diario INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    permiso TEXT NOT NULL
  )`,
  `CREATE TABLE user_sessions (
    user_id INTEGER PRIMARY KEY,
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nivel TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // folio se inserta en NULL a propósito y se llena con un UPDATE aparte
  // (insertFolioRow en db.ts arma el string del folio con el id ya
  // generado) — no puede ser NOT NULL.
  `CREATE TABLE folios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seccion TEXT NOT NULL,
    consecutivo INTEGER NOT NULL,
    folio TEXT,
    sku TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    sku_principal TEXT NOT NULL,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_por TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    tipo TEXT
  )`,
  `CREATE TABLE precios_historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    precio_anterior REAL,
    precio_nuevo REAL NOT NULL,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE remisiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio TEXT NOT NULL,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    pedido_bodegas TEXT,
    cliente_rfc TEXT,
    cliente_direccion TEXT,
    cliente_contacto TEXT,
    cliente_telefono TEXT,
    cancelada INTEGER NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL,
    descuento_pct REAL NOT NULL DEFAULT 0,
    descuento REAL NOT NULL DEFAULT 0,
    iva REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    precio_texto TEXT,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE precios_venta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    categoria TEXT NOT NULL,
    precio REAL,
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_por TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_id, categoria)
  )`,
  `CREATE TABLE remision_renglones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remision_id INTEGER NOT NULL,
    numero_renglon INTEGER NOT NULL,
    sku TEXT,
    producto_nombre TEXT,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    importe REAL NOT NULL
  )`,
];

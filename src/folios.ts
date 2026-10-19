// Lógica del sistema de folios (AAA-SKU-DDMMYY-00001), mismo formato y misma
// tabla `folios` que usa Clio. La generación atómica del consecutivo vive en
// db.ts (insertFolioRow) — este archivo solo contiene lógica pura reutilizable
// por db.ts y por los componentes que arman el string a mostrar/usar.
import type { TipoFolio } from "./types";

export const FOLIO_PREFIJOS: Record<TipoFolio, string> = {
  remision: "REM",
  remision_externa: "REMEX",
};

// Fecha local (día del taller, no UTC).
export function fechaLocalDeHoy(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatFechaFolioLocal(fechaISO: string = fechaLocalDeHoy()): string {
  const [y, m, d] = fechaISO.split("-");
  return `${d}${m}${y.slice(2)}`;
}

function sanitizeFolioComponent(text: string): string {
  return text.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "SKU";
}

export function buildFolioString(
  prefix: string,
  sku: string,
  fechaDDMMYY: string,
  consecutivo: number,
): string {
  return `${prefix}-${sanitizeFolioComponent(sku)}-${fechaDDMMYY}-${String(consecutivo).padStart(5, "0")}`;
}

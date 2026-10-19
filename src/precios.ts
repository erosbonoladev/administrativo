// SKU con letras adicionales (8059C, 8059D) se agrupan bajo su SKU principal
// quitando las letras finales — sin verificar que ese SKU base exista como
// producto real (8059C puede ser un precio relacionado sin ficha propia).
const TRAILING_LETTERS_RE = /[A-Za-z]+$/;

export function computeSkuPrincipal(sku: string): string {
  const trimmed = sku.trim();
  const stripped = trimmed.replace(TRAILING_LETTERS_RE, "");
  return stripped || trimmed;
}

// Parser estricto para inputs numéricos tecleados a mano (cantidad, precio
// unitario, % de descuento en RemisionForm/RemisionDetalleModal)
// — a diferencia de parseFloat(), que acepta un prefijo parcial ("12abc" →
// 12) y deja pasar basura silenciosamente, esto exige que el string completo
// sea un número (admite coma o punto como separador decimal, convención
// local). Vacío o inválido → null, nunca 0 — así el caller puede distinguir
// "no hay nada" de "el usuario puso cero" y bloquear el guardado en vez de
// guardar un 0 que nadie tecleó.
const AMOUNT_RE = /^\d+(\.\d+)?$/;

export function parseAmount(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!AMOUNT_RE.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

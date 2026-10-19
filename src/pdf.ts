import { jsPDF } from "jspdf";
import type { Remision, RemisionRenglon, TipoRemision } from "./types";
import remisionTemplateUrl from "../Assets/remision-template.png";
import remisionTemplateExternaUrl from "../Assets/remision-template-externa.png";
import { formatMoney } from "./excelExport";
import * as L from "./remisionLayout";

// --- Remisión (plantilla Assets/remision.pdf, rasterizada como fondo) ---

interface RemisionTemplate {
  img: HTMLImageElement;
  w: number;
  h: number;
}

const remisionTemplatePromises = new Map<string, Promise<RemisionTemplate | null>>();

function getRemisionTemplate(tipo: TipoRemision): Promise<RemisionTemplate | null> {
  const url = tipo === "externa" ? remisionTemplateExternaUrl : remisionTemplateUrl;
  let promise = remisionTemplatePromises.get(url);
  if (!promise) {
    promise = (async () => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return { img, w: img.naturalWidth, h: img.naturalHeight };
      } catch (err) {
        console.warn("No se pudo cargar la plantilla de remisión:", err);
        return null;
      }
    })();
    remisionTemplatePromises.set(url, promise);
  }
  return promise;
}

// El renglón solo tiene una línea de alto — un nombre de producto que no
// quepa se corta con "…" en vez de perder texto sin ningún indicio visible
// en un documento impreso/legal como la remisión.
function truncateToWidth(doc: jsPDF, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && doc.getTextWidth(`${truncated}…`) > maxWidth) {
    truncated = truncated.slice(0, -1).trimEnd();
  }
  return `${truncated}…`;
}

// Reduce el tamaño de letra (en vez de truncar, a diferencia de
// truncateToWidth) hasta que el folio entre en el ancho disponible — a
// diferencia de un nombre de producto, el folio es un identificador legal del
// documento y no debe perder caracteres.
function fitFolioFontSize(doc: jsPDF, text: string, maxWidth: number, startSize: number, minSize: number): number {
  doc.setFont("helvetica", "bold");
  return fitFontSize(doc, text, maxWidth, startSize, minSize);
}

// Igual para el nombre del cliente/bodega, que es texto libre (con la fuente ya seleccionada).
function fitFontSize(doc: jsPDF, text: string, maxWidth: number, startSize: number, minSize: number): number {
  let size = startSize;
  doc.setFontSize(size);
  while (size > minSize && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    doc.setFontSize(size);
  }
  return size;
}

export async function buildRemisionPdf(
  remision: Remision,
  renglones: RemisionRenglon[],
): Promise<Uint8Array> {
  const template = await getRemisionTemplate(remision.tipo);
  const doc = new jsPDF({ unit: "pt", format: [L.PAGE_W, L.PAGE_H] });
  const externa = remision.tipo === "externa";
  const C = L.columnsFor(remision.tipo);

  function drawBackground() {
    if (!template) return;
    doc.addImage(template.img, "PNG", 0, 0, L.PAGE_W, L.PAGE_H);
  }

  function erase(rect: L.Rect) {
    doc.setFillColor(255, 255, 255);
    doc.rect(rect[0], rect[1], rect[2], rect[3], "F");
  }

  const totalPages = Math.max(1, Math.ceil(renglones.length / L.ROWS_PER_PAGE));
  const folio = L.folioImpreso(remision.folio);
  const folioFontSize = fitFolioFontSize(doc, folio, L.FOLIO.maxWidth, 10.5, 6);
  const pedido = remision.pedido_bodegas || "—";
  doc.setFont("helvetica", "normal");
  const pedidoFontSize = fitFontSize(doc, pedido, L.PEDIDO.maxWidth, L.FONT_HEADER_FIELD, 6);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();
    drawBackground();

    // El folio/fecha/pedido se repiten en cada página (no solo la primera) —
    // un documento de varias páginas debe poder identificarse completo aunque
    // se separen las hojas.
    erase(L.FOLIO.erase);
    erase(L.FECHA.erase);
    if (!externa) erase(L.PEDIDO.erase);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(folioFontSize);
    doc.text(folio, L.FOLIO.cx, L.FOLIO.cy, { align: "center", baseline: "middle" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.FONT_HEADER_FIELD);
    doc.text(L.formatFechaHoja(remision.fecha), L.FECHA.cx, L.FECHA.cy, { align: "center", baseline: "middle" });

    if (externa) {
      // Bloque de datos del cliente (la plantilla externa no trae el de Bodegas Educativas).
      const blk = L.CLIENTE_BLOCK;
      const valores: Record<L.ClienteCampo, string> = {
        cliente: remision.pedido_bodegas,
        rfc: remision.cliente_rfc,
        direccion: remision.cliente_direccion,
        contacto: remision.cliente_contacto,
        telefono: remision.cliente_telefono,
      };
      blk.fields.forEach(({ campo, label }, i) => {
        const cy = blk.firstCy + i * blk.pitch;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(L.FONT_BODY);
        doc.text(label, blk.labelX, cy, { baseline: "middle" });
        const valor = valores[campo];
        if (!valor) return;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(fitFontSize(doc, valor, blk.valueMaxWidth, L.FONT_BODY, 6));
        doc.text(valor, blk.valueX, cy, { baseline: "middle" });
      });
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(pedidoFontSize);
      doc.text(pedido, L.PEDIDO.cx, L.PEDIDO.cy, { align: "center", baseline: "middle" });
    }

    const pageRows = renglones.slice(page * L.ROWS_PER_PAGE, (page + 1) * L.ROWS_PER_PAGE);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.FONT_BODY);
    pageRows.forEach((renglon, i) => {
      const y = L.rowCenterY(i);
      const mid = { baseline: "middle" } as const;
      // La clave es información interna: la plantilla externa no tiene esa columna.
      if (C.clave) doc.text(renglon.sku, (C.clave[0] + C.clave[1]) / 2, y, { align: "center", ...mid });
      doc.text(String(renglon.cantidad), (C.cantidad[0] + C.cantidad[1]) / 2, y, { align: "center", ...mid });
      const producto = truncateToWidth(doc, renglon.producto_nombre, C.producto[1] - 4 - C.productoTextX);
      doc.text(producto, C.productoTextX, y, mid);
      doc.text(formatMoney(renglon.precio_unitario), C.precioTextRight, y, { align: "right", ...mid });
      doc.text(formatMoney(renglon.importe), C.importeTextRight, y, { align: "right", ...mid });
    });

    if (page === totalPages - 1) {
      const pt = L.PRECIO_TEXTO;
      erase([pt.x - 1, pt.y - 1, pt.w + 2, pt.h]);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(remision.precio_texto, pt.x, pt.y + 5, { maxWidth: pt.w, baseline: "middle", lineHeightFactor: pt.lineHeight / 9 });

      doc.setFontSize(L.FONT_TOTALES);
      const right = { align: "right", baseline: "middle" } as const;
      doc.text(formatMoney(remision.subtotal), L.TOTALES_RIGHT, L.TOTAL_CY.subtotal, right);
      doc.text(`${remision.descuento_pct}%`, L.TOTALES_RIGHT, L.TOTAL_CY.descuentoPct, right);
      doc.text(formatMoney(remision.descuento), L.TOTALES_RIGHT, L.TOTAL_CY.descuento, right);
      doc.text(formatMoney(remision.iva), L.TOTALES_RIGHT, L.TOTAL_CY.iva, right);
      doc.setFont("helvetica", "bold");
      doc.text(formatMoney(remision.total), L.TOTALES_RIGHT, L.TOTAL_CY.total, right);
    }
  }

  return new Uint8Array(doc.output("arraybuffer"));
}


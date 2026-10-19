import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth";
import { listCatalogo } from "../db";
import { formatMoney } from "../excelExport";
import { PRECIOS_VENTA_CATEGORIAS } from "../types";
import type { Catalogo } from "../types";
import Pagination from "./Pagination";

const PAGE_SIZE = 25;

function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export default function CatalogoSection() {
  const { user, token } = useAuth();
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (!user || !token) return;
    let cancelled = false;
    setError(null);
    listCatalogo({ id: user.id, token })
      .then((result) => {
        if (!cancelled) setCatalogo(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [user, token]);

  const filtrados = useMemo(() => {
    if (!catalogo) return [];
    const q = normalizeSearch(query);
    if (!q) return catalogo.items;
    return catalogo.items.filter((item) =>
      normalizeSearch(`${item.codigo} ${item.nombre} ${item.categoria} ${item.material}`).includes(q),
    );
  }, [catalogo, query]);

  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const preciosVisibles = catalogo?.preciosVisibles ?? false;
  const pagina = filtrados.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="private-section">
      <h1>Catálogo</h1>

      <input
        className="search-input"
        type="text"
        placeholder="Buscar por SKU, nombre, categoría o material…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCurrentPage(1);
        }}
      />

      {error ? (
        <p className="form-error" role="alert">
          No se pudo cargar el catálogo: {error}
        </p>
      ) : !catalogo ? (
        <p className="hint">Cargando…</p>
      ) : filtrados.length === 0 ? (
        <p className="hint">Sin resultados para esa búsqueda.</p>
      ) : (
        <>
          <p className="hint">
            {filtrados.length} {filtrados.length === 1 ? "producto" : "productos"}
          </p>
          <div className="catalogo-table-wrap">
            <table className="catalogo-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Nombre</th>
                  <th>Categoría</th>
                  <th>Material</th>
                  {preciosVisibles &&
                    PRECIOS_VENTA_CATEGORIAS.map((categoria) => (
                      <th key={categoria} className="catalogo-precio">
                        {categoria}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {pagina.map((item) => (
                  <tr key={item.id}>
                    <td>{item.codigo}</td>
                    <td>{item.nombre}</td>
                    <td>{item.categoria}</td>
                    <td>{item.material}</td>
                    {preciosVisibles &&
                      PRECIOS_VENTA_CATEGORIAS.map((categoria) => {
                        const precio = item.precios[categoria];
                        return (
                          <td key={categoria} className="catalogo-precio">
                            {precio === null ? "—" : formatMoney(precio)}
                          </td>
                        );
                      })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <Pagination currentPage={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
          )}
        </>
      )}
    </div>
  );
}

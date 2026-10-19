import { useEffect, useState } from "react";
import "./App.css";
import { warmUpConnection } from "./db";
import CatalogoSection from "./components/CatalogoSection";
import LoginScreen from "./components/LoginScreen";
import RemisionesSection from "./components/RemisionesSection";
import Sidebar from "./components/Sidebar";
import { hasPermission, useAuth } from "./auth";

type View = "catalogo" | "remisiones";

function App() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    warmUpConnection();
  }, []);

  // Pantalla de inicio: Remisiones para quien tiene acceso (es para lo que se
  // abre esta app), el catálogo en lista para el resto. Se recalcula al cambiar
  // de usuario para no heredar la vista de la sesión anterior.
  useEffect(() => {
    setView(null);
  }, [user?.id]);

  if (loading) {
    return (
      <main className="app">
        <p className="hint">Cargando…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="app app-login">
        <LoginScreen />
      </main>
    );
  }

  const current: View = view ?? (hasPermission(user, "remisiones_acceso") ? "remisiones" : "catalogo");

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onCatalogo={() => setView("catalogo")}
        onRemisiones={() => setView("remisiones")}
      />

      <main className="app app-content">
        {current === "catalogo" && <CatalogoSection />}
        {current === "remisiones" && <RemisionesSection />}
      </main>
    </div>
  );
}

export default App;

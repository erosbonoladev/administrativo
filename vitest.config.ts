import { defineConfig } from "vitest/config";

// Config de pruebas separada de vite.config.ts: el alias solo debe existir
// bajo `vitest`, nunca filtrarse al build real de Tauri. `src/db.ts` importa
// "@libsql/client/web" (solo HTTP/WebSocket, sin URLs "file:"); para correr
// las pruebas de integridad contra un SQLite local descartable (ver
// tests/setup.ts) se redirige únicamente aquí al cliente Node de
// @libsql/client, que implementa la misma interfaz.
export default defineConfig({
  resolve: {
    alias: {
      "@libsql/client/web": "@libsql/client",
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
  },
});

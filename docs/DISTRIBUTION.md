# Distribución y auto-update

Funciona como en Clio (ver `docs/DISTRIBUTION.md` de ese repo): GitHub Releases privados, un build firmado con minisign por `tauri-action`, y el **Update API** (Cloudflare Worker, `update-api/` en el repo de Clio) como intermediario para que ningún PAT de GitHub viaje en el binario. Una sola diferencia: **Administrativo no tiene activación de instalación**.

```
Administrativo (Tauri)                 Update API (Worker de Clio)            GitHub privado
──────────────────────                 ───────────────────────────            ──────────────
plugin-updater  ──GET──►  /updates/administrativo/latest   ──►  releases/latest (repo de Administrativo)
                          (reescribe URLs de latest.json)
downloadAndInstall ─GET─► /updates/administrativo/download/:id?token=…  ──►  releases/assets/:id
```

- Sin credencial de instalación: la ruta no pide `Authorization`/`X-Installation-Id`. El binario no contiene secretos y la app exige login igual. La descarga sí va con token HMAC de 10 min (el mismo `DOWNLOAD_TOKEN_SECRET`).
- Una instalación de Clio revocada **no** afecta a Administrativo (no comparten credencial).
- La firma del updater (minisign) es la misma clave que Clio: `pubkey` de `tauri.conf.json` es idéntica a la de Clio, y el repo de Administrativo necesita los mismos secrets `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Si se prefiere clave propia: `npm run tauri signer generate`, cambiar `pubkey` y los secrets (las versiones ya instaladas con la clave vieja no podrían actualizarse).

## Código

| Pieza | Dónde |
|---|---|
| Plugins Rust (`updater`, `process`) y capabilities (`updater:default`, `process:default`) | `src-tauri/src/lib.rs`, `Cargo.toml`, `capabilities/default.json` |
| Endpoint + `pubkey` + `createUpdaterArtifacts` | `src-tauri/tauri.conf.json` |
| Chequeo al arrancar (ya durante el login), instalación y relanzado | `src/updateContext.tsx` (`UpdateProvider`, montado en `main.tsx` por fuera de `AuthProvider`) |
| Botón de la barra lateral + versión | `src/components/UpdateChecker.tsx` (en `Sidebar`) |
| CI que compila/firma/publica | `.github/workflows/build.yml` |
| Rutas del Worker | repo Clio: `update-api/src/index.ts`, `logic/github.ts`, `logic/updateManifest.ts` |

## Configuración única (una sola vez)

1. Crear el repo **privado** de Administrativo en GitHub (el Worker espera `GITHUB_OWNER/GITHUB_REPO_ADMINISTRATIVO`; hoy `administrativo` en `update-api/wrangler.toml` — ajustar si el nombre real es otro).
2. Ampliar el PAT fine-grained del Worker (`GITHUB_TOKEN`, Contents: read-only) para que incluya también ese repo.
3. Secrets del repo de Administrativo: `VITE_TURSO_URL`, `VITE_TURSO_AUTH_TOKEN` (los de Clio), `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Desplegar el Worker con las rutas nuevas: `cd update-api && npm run deploy` (en el repo de Clio). Verificar: `curl -i https://clio-update-api.erosbonoladev.workers.dev/updates/administrativo/latest` → 204 mientras no haya release publicado, JSON después.

## Publicar una versión

1. Subir la versión en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`.
2. `git tag app-v<versión> && git push origin app-v<versión>` (o `gh workflow run build.yml`): compila Windows y macOS, firma y deja un Release en **draft** con instaladores + `latest.json`.
3. Publicar el release (sacarlo de draft). Desde ese momento las apps instaladas lo ofrecen.

La **primera** build con updater hay que instalarla a mano en cada equipo; las siguientes se actualizan solas (chequeo al abrir, o el botón de la barra lateral).

## Restauración de la BD

Es la misma BD que Clio, así que restaurar desde Clio (Configuraciones → Backups) ya restaura lo que ve esta app. La restauración reemplaza `users` (incluido `session_token`) y `user_sessions` con lo del backup: esta app detecta la sesión inválida en su siguiente revalidación/escritura (≤ 5 min) y vuelve al login. No hace falta ningún flujo de restauración propio.

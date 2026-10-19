#[tauri::command]
fn verify_password(password: String, hash: String) -> Result<bool, String> {
    bcrypt::verify(password, &hash).map_err(|e| e.to_string())
}

/// Extiende el scope de `fs` en runtime para un único path que el usuario
/// acaba de elegir en un diálogo nativo (save) — el scope estático de la app
/// es solo appData. Se llama justo después de cada diálogo, nunca con un path
/// arbitrario construido a mano en JS. Rechaza paths relativos o con
/// segmentos `..` como defensa adicional.
#[tauri::command]
fn allow_fs_path(app: tauri::AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    use std::path::{Component, Path};
    use tauri_plugin_fs::FsExt;

    let candidate = Path::new(&path);
    if !candidate.is_absolute() {
        return Err("Ruta rechazada: no es absoluta.".into());
    }
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Ruta rechazada: contiene un segmento '..'.".into());
    }

    let scope = app.fs_scope();
    let result = if is_dir {
        scope.allow_directory(&path, false)
    } else {
        scope.allow_file(&path)
    };
    result.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![verify_password, allow_fs_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

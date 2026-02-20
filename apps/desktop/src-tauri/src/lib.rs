use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

struct SidecarState {
    child: Option<std::process::Child>,
}

fn start_sidecar(sidecar_path: &str, port: u16) -> Option<std::process::Child> {
    let child = Command::new("node")
        .arg(sidecar_path)
        .env("PORT", port.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            println!("Sidecar started with PID: {}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("Failed to start sidecar: {}", e);
            None
        }
    }
}

#[tauri::command]
fn get_sidecar_url() -> String {
    "http://localhost:3001".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .setup(|app| {
            // Resolve the sidecar path relative to the app resource directory
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            // In development, use the desktop-sidecar from the workspace
            let sidecar_path = std::env::var("SIDECAR_PATH").unwrap_or_else(|_| {
                resource_dir
                    .join("sidecar")
                    .join("index.js")
                    .to_string_lossy()
                    .to_string()
            });

            let child = start_sidecar(&sidecar_path, 3001);

            let state = app.state::<Mutex<SidecarState>>();
            let mut state = state.lock().unwrap();
            state.child = child;

            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Kill sidecar on exit
                let state = app.state::<Mutex<SidecarState>>();
                if let Ok(mut state) = state.lock() {
                    if let Some(ref mut child) = state.child {
                        let _ = child.kill();
                        println!("Sidecar process killed");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_sidecar_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod claude;
mod zotero;

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
    // Load .env file (walks up from cwd to find it)
    let _ = dotenvy::dotenv();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .manage(claude::ClaudeProcessState::default())
        .manage(zotero::ZoteroOAuthState::default())
        .setup(|app| {
            // In dev mode, the sidecar is started separately (via pnpm dev:desktop)
            // In production, start the sidecar from the bundled resources
            let sidecar_path = if let Ok(path) = std::env::var("SIDECAR_PATH") {
                Some(path)
            } else if cfg!(not(debug_assertions)) {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                Some(
                    resource_dir
                        .join("sidecar")
                        .join("index.js")
                        .to_string_lossy()
                        .to_string(),
                )
            } else {
                // Dev mode: sidecar is managed by the dev script
                println!("Dev mode: expecting sidecar on port 3001 (start with pnpm dev:desktop)");
                None
            };

            if let Some(path) = sidecar_path {
                let child = start_sidecar(&path, 3001);
                let state = app.state::<Mutex<SidecarState>>();
                let mut state = state.lock().unwrap();
                state.child = child;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sidecar_url,
            claude::execute_claude_code,
            claude::continue_claude_code,
            claude::resume_claude_code,
            claude::cancel_claude_execution,
            claude::run_shell_command,
            zotero::zotero_start_oauth,
            zotero::zotero_complete_oauth,
            zotero::zotero_cancel_oauth,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Kill sidecar on exit
            let state = app_handle.state::<Mutex<SidecarState>>();
            if let Ok(mut guard) = state.lock() {
                if let Some(ref mut child) = guard.child {
                    let _ = child.kill();
                    println!("Sidecar process killed");
                }
            };
        }
    });
}

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct ClaudeProcessState {
    pub current_process: Arc<Mutex<Option<Child>>>,
}

impl Default for ClaudeProcessState {
    fn default() -> Self {
        Self {
            current_process: Arc::new(Mutex::new(None)),
        }
    }
}

/// Discover the claude binary on the system.
/// Checks: which claude → NVM paths → standard paths → bare fallback.
fn find_claude_binary() -> Result<String, String> {
    // 1. Try `which claude`
    if let Ok(output) = std::process::Command::new("which")
        .arg("claude")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Ok(path);
            }
        }
    }

    // 2. Check NVM directories
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm").join("versions").join("node");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                let mut candidates: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("bin").join("claude"))
                    .filter(|p| p.exists())
                    .collect();
                // Sort by version (directory name) descending to prefer latest
                candidates.sort();
                candidates.reverse();
                if let Some(path) = candidates.first() {
                    return Ok(path.to_string_lossy().to_string());
                }
            }
        }
    }

    // 3. Check standard paths
    let standard_paths = [
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        "/usr/bin/claude",
        "/bin/claude",
    ];
    for path in &standard_paths {
        if PathBuf::from(path).exists() {
            return Ok(path.to_string());
        }
    }

    // 4. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        let user_paths = [
            home.join(".claude").join("local").join("claude"),
            home.join(".local").join("bin").join("claude"),
            home.join(".npm-global").join("bin").join("claude"),
            home.join(".yarn").join("bin").join("claude"),
            home.join(".bun").join("bin").join("claude"),
            home.join("bin").join("claude"),
        ];
        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // 5. Bare fallback — hope it's in PATH
    Ok("claude".to_string())
}

/// Create a tokio Command with appropriate environment variables.
fn create_command(program: &str, args: Vec<String>, cwd: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(&args);
    cmd.current_dir(cwd);

    // Pipe stdout and stderr for streaming
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inherit essential environment variables
    for (key, value) in std::env::vars() {
        if key == "PATH"
            || key == "HOME"
            || key == "USER"
            || key == "SHELL"
            || key == "LANG"
            || key == "LC_ALL"
            || key.starts_with("LC_")
            || key == "NODE_PATH"
            || key == "NVM_DIR"
            || key == "NVM_BIN"
            || key == "HOMEBREW_PREFIX"
            || key == "HOMEBREW_CELLAR"
            || key == "HTTP_PROXY"
            || key == "HTTPS_PROXY"
            || key == "NO_PROXY"
            || key == "ALL_PROXY"
        {
            cmd.env(&key, &value);
        }
    }

    // Add NVM support if the program is in an NVM directory
    if program.contains("/.nvm/versions/node/") {
        if let Some(node_bin_dir) = std::path::Path::new(program).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let node_bin_str = node_bin_dir.to_string_lossy();
            if !current_path.contains(node_bin_str.as_ref()) {
                let new_path = format!("{}:{}", node_bin_str, current_path);
                cmd.env("PATH", new_path);
            }
        }
    }

    // Add Homebrew support
    if program.contains("/homebrew/") || program.contains("/opt/homebrew/") {
        if let Some(program_dir) = std::path::Path::new(program).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let homebrew_bin_str = program_dir.to_string_lossy();
            if !current_path.contains(homebrew_bin_str.as_ref()) {
                let new_path = format!("{}:{}", homebrew_bin_str, current_path);
                cmd.env("PATH", new_path);
            }
        }
    }

    cmd
}

/// Spawn the Claude CLI process and stream output via Tauri events.
async fn spawn_claude_process(
    app: AppHandle,
    mut cmd: Command,
) -> Result<(), String> {
    // Spawn the process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude process: {}. Is Claude Code CLI installed?", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Get a clone of the process state Arc before any moves
    let process_arc = app.state::<ClaudeProcessState>().inner().current_process.clone();

    // Store the child process in state (kill any existing process first)
    {
        let mut current_process = process_arc.lock().await;
        if let Some(mut existing) = current_process.take() {
            let _ = existing.kill().await;
        }
        *current_process = Some(child);
    }

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let session_id_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));

    // Spawn stdout streaming task
    let app_stdout = app.clone();
    let session_id_stdout = session_id_holder.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Parse for system:init to extract session_id
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                if msg["type"] == "system" && msg["subtype"] == "init" {
                    if let Some(sid) = msg["session_id"].as_str() {
                        let mut guard = session_id_stdout.lock().unwrap();
                        *guard = Some(sid.to_string());
                    }
                }
            }

            // Emit session-scoped event
            if let Some(ref sid) = *session_id_stdout.lock().unwrap() {
                let _ = app_stdout.emit(&format!("claude-output:{}", sid), &line);
            }
            // Always emit generic event (for initial listeners)
            let _ = app_stdout.emit("claude-output", &line);
        }
    });

    // Spawn stderr streaming task
    let app_stderr = app.clone();
    let session_id_stderr = session_id_holder.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(ref sid) = *session_id_stderr.lock().unwrap() {
                let _ = app_stderr.emit(&format!("claude-error:{}", sid), &line);
            }
            let _ = app_stderr.emit("claude-error", &line);
        }
    });

    // Spawn wait task — wait for process completion
    let process_arc_wait = process_arc.clone();
    let app_wait = app;
    let session_id_wait = session_id_holder.clone();
    tokio::spawn(async move {
        // Wait for stdout/stderr to finish
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Wait for process exit
        let mut current_process = process_arc_wait.lock().await;
        let success = if let Some(mut child) = current_process.take() {
            match child.wait().await {
                Ok(status) => status.success(),
                Err(_) => false,
            }
        } else {
            false
        };

        // Small delay to ensure all events are flushed
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Emit completion event
        if let Some(ref sid) = *session_id_wait.lock().unwrap() {
            let _ = app_wait.emit(&format!("claude-complete:{}", sid), success);
        }
        let _ = app_wait.emit("claude-complete", success);
    });

    Ok(())
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn execute_claude_code(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let args = vec![
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let cmd = create_command(&claude_path, args, &project_path);
    spawn_claude_process(app, cmd).await
}

#[tauri::command]
pub async fn continue_claude_code(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let args = vec![
        "-c".to_string(),
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let cmd = create_command(&claude_path, args, &project_path);
    spawn_claude_process(app, cmd).await
}

#[tauri::command]
pub async fn resume_claude_code(
    app: AppHandle,
    project_path: String,
    session_id: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let args = vec![
        "--resume".to_string(),
        session_id,
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let cmd = create_command(&claude_path, args, &project_path);
    spawn_claude_process(app, cmd).await
}

#[tauri::command]
pub async fn cancel_claude_execution(
    app: AppHandle,
) -> Result<(), String> {
    let claude_state = app.state::<ClaudeProcessState>();
    let mut current_process = claude_state.current_process.lock().await;
    if let Some(mut child) = current_process.take() {
        let _ = child.kill().await;
        // Emit completion with success=false
        let _ = app.emit("claude-complete", false);
    }
    Ok(())
}

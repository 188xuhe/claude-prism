use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const LICENSE_SECRET: &[u8] = b"L1C3NS3_S3CR3T_K3Y_2026_CL4UD3_PR1SM";

#[derive(serde::Serialize)]
pub struct LicenseStatus {
    activated: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LicenseData {
    key: String,
    mac: String,
}

/// Get the primary MAC address of this machine.
#[tauri::command]
pub fn get_machine_id() -> Result<String, String> {
    get_mac_address()
}

/// Check if a valid license is stored and matches the current machine.
#[tauri::command]
pub fn check_license() -> LicenseStatus {
    match verify_stored_license() {
        Ok(true) => LicenseStatus { activated: true },
        _ => LicenseStatus { activated: false },
    }
}

/// Activate a license key. Verifies it against the current MAC address.
/// If valid, persists the license to disk.
#[tauri::command]
pub fn activate_license(key: String) -> Result<(), String> {
    let mac = get_mac_address()?;
    let normalized_mac = normalize_mac(&mac);
    let expected = derive_license_key(&normalized_mac);

    if key.to_uppercase() == expected {
        let license_data = LicenseData {
            key: key.to_uppercase(),
            mac: normalized_mac,
        };
        save_license(&license_data)
    } else {
        Err("Invalid license key".to_string())
    }
}

/// Derive a license key from a normalized MAC address using HMAC-SHA256.
/// Takes the first 16 hex characters and formats as XXXX-XXXX-XXXX-XXXX.
fn derive_license_key(normalized_mac: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(LICENSE_SECRET)
        .expect("HMAC can take key of any size");
    mac.update(normalized_mac.as_bytes());
    let result = mac.finalize();
    let code_bytes = result.into_bytes();
    let hex_str: String = code_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // Take first 16 hex chars, format as XXXX-XXXX-XXXX-XXXX
    let short = &hex_str[..16];
    format!(
        "{}-{}-{}-{}",
        &short[0..4].to_uppercase(),
        &short[4..8].to_uppercase(),
        &short[8..12].to_uppercase(),
        &short[12..16].to_uppercase()
    )
}

/// Normalize a MAC address: lowercase, strip colons/dashes.
fn normalize_mac(mac: &str) -> String {
    mac.to_lowercase()
        .replace(':', "")
        .replace('-', "")
}

/// Get the MAC address of the primary network interface.
fn get_mac_address() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        get_mac_macos()
    }
    #[cfg(target_os = "linux")]
    {
        get_mac_linux()
    }
    #[cfg(target_os = "windows")]
    {
        get_mac_windows()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("Unsupported platform".to_string())
    }
}

#[cfg(target_os = "macos")]
fn get_mac_macos() -> Result<String, String> {
    // Try en0 first (usually the primary interface on macOS)
    for iface in &["en0", "en1"] {
        if let Ok(output) = std::process::Command::new("ifconfig")
            .arg(iface)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("ether ") {
                    let mac = trimmed.strip_prefix("ether ").unwrap_or("").trim();
                    if is_valid_mac(mac) {
                        return Ok(mac.to_string());
                    }
                }
            }
        }
    }
    Err("Could not determine MAC address".to_string())
}

#[cfg(target_os = "linux")]
fn get_mac_linux() -> Result<String, String> {
    // Try common interface paths
    for iface in &["eth0", "wlan0", "enp0s3", "wlp2s0"] {
        let path = format!("/sys/class/net/{}/address", iface);
        if let Ok(addr) = std::fs::read_to_string(&path) {
            let mac = addr.trim().to_string();
            if is_valid_mac(&mac) {
                return Ok(mac);
            }
        }
    }
    // Fallback: try ip link show
    if let Ok(output) = std::process::Command::new("ip")
        .args(["link", "show"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("link/ether ") {
                let mac = trimmed.strip_prefix("link/ether ").unwrap_or("");
                let mac = mac.split_whitespace().next().unwrap_or("");
                if is_valid_mac(mac) {
                    return Ok(mac.to_string());
                }
            }
        }
    }
    Err("Could not determine MAC address".to_string())
}

#[cfg(target_os = "windows")]
fn get_mac_windows() -> Result<String, String> {
    // Strategy 1: PowerShell Get-NetAdapter (most reliable, Win8+)
    if let Ok(mac) = get_mac_powershell() {
        return Ok(mac);
    }
    // Strategy 2: ipconfig /all — parse "Physical Address" lines
    if let Ok(mac) = get_mac_ipconfig() {
        return Ok(mac);
    }
    // Strategy 3: getmac /fo csv /nh
    if let Ok(mac) = get_mac_getmac() {
        return Ok(mac);
    }
    Err("Could not determine MAC address".to_string())
}

#[cfg(target_os = "windows")]
fn get_mac_powershell() -> Result<String, String> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1).MacAddress",
        ])
        .output()
        .map_err(|e| format!("PowerShell failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mac = stdout.trim().replace('-', ":");
    if is_valid_mac(&mac) {
        Ok(mac)
    } else {
        Err("No valid MAC from PowerShell".to_string())
    }
}

#[cfg(target_os = "windows")]
fn get_mac_ipconfig() -> Result<String, String> {
    let output = std::process::Command::new("ipconfig")
        .arg("/all")
        .output()
        .map_err(|e| format!("ipconfig failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Look for "Physical Address" or localized equivalent line
    for line in stdout.lines() {
        let line = line.trim();
        // Match "Physical Address . . . . . . . . . : A1-B2-C3-D4-E5-F6"
        if let Some(pos) = line.find(':') {
            let after = line[pos + 1..].trim();
            let mac = after.replace('-', ":");
            if is_valid_mac(&mac) {
                return Ok(mac);
            }
        }
    }
    Err("No valid MAC from ipconfig".to_string())
}

#[cfg(target_os = "windows")]
fn get_mac_getmac() -> Result<String, String> {
    let output = std::process::Command::new("getmac")
        .args(["/fo", "csv", "/nh"])
        .output()
        .map_err(|e| format!("getmac failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('"') {
            continue;
        }
        if let Some(end) = line[1..].find('"') {
            let raw_mac = &line[1..1 + end];
            let mac = raw_mac.replace('-', ":");
            if is_valid_mac(&mac) {
                return Ok(mac);
            }
        }
    }
    Err("No valid MAC from getmac".to_string())
}

/// Check if a MAC address looks valid (has colons, not all zeros).
fn is_valid_mac(mac: &str) -> bool {
    if !mac.contains(':') {
        return false;
    }
    let parts: Vec<&str> = mac.split(':').collect();
    if parts.len() != 6 {
        return false;
    }
    // Reject all-zero MAC
    !parts.iter().all(|p| *p == "00")
}

/// Get the path to the license file.
fn license_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".claudeprism");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .claudeprism: {}", e))?;
    }
    Ok(dir.join("license.json"))
}

/// Save license data to disk.
fn save_license(data: &LicenseData) -> Result<(), String> {
    let path = license_path()?;
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("JSON error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

/// Read license data from disk.
fn read_license() -> Result<LicenseData, String> {
    let path = license_path()?;
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))
}

/// Verify the stored license matches the current machine.
fn verify_stored_license() -> Result<bool, String> {
    let data = read_license()?;
    let current_mac = get_mac_address()?;
    let normalized_current = normalize_mac(&current_mac);

    // MAC must match current machine (prevents copying license file)
    if data.mac != normalized_current {
        return Ok(false);
    }

    // Key must be valid for this MAC
    let expected = derive_license_key(&normalized_current);
    Ok(data.key == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_license_key() {
        let mac = "a1b2c3d4e5f6";
        let key = derive_license_key(mac);
        // Should be in XXXX-XXXX-XXXX-XXXX format
        assert_eq!(key.len(), 19); // 16 chars + 3 dashes
        let parts: Vec<&str> = key.split('-').collect();
        assert_eq!(parts.len(), 4);
        for part in parts {
            assert_eq!(part.len(), 4);
        }
    }

    #[test]
    fn test_derive_license_key_deterministic() {
        let mac = "a1b2c3d4e5f6";
        let key1 = derive_license_key(mac);
        let key2 = derive_license_key(mac);
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_normalize_mac() {
        assert_eq!(normalize_mac("A1:B2:C3:D4:E5:F6"), "a1b2c3d4e5f6");
        assert_eq!(normalize_mac("a1-b2-c3-d4-e5-f6"), "a1b2c3d4e5f6");
        assert_eq!(normalize_mac("a1b2c3d4e5f6"), "a1b2c3d4e5f6");
    }

    #[test]
    fn test_activate_license_validates_key() {
        // A wrong key should be rejected
        let result = activate_license("0000-0000-0000-0000".to_string());
        // This will fail because the key doesn't match the current MAC
        // but we can't test the positive case without knowing the real MAC
        assert!(result.is_err());
    }
}

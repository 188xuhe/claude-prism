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
    machine_id: String,
}

/// Get the unique machine ID of this machine.
#[tauri::command]
pub fn get_machine_id() -> Result<String, String> {
    get_platform_machine_id()
}

/// Check if a valid license is stored and matches the current machine.
#[tauri::command]
pub fn check_license() -> LicenseStatus {
    match verify_stored_license() {
        Ok(true) => LicenseStatus { activated: true },
        _ => LicenseStatus { activated: false },
    }
}

/// Activate a license key. Verifies it against the current machine ID.
/// If valid, persists the license to disk.
#[tauri::command]
pub fn activate_license(key: String) -> Result<(), String> {
    let machine_id = get_platform_machine_id()?;
    let normalized_id = normalize_id(&machine_id);
    let expected = derive_license_key(&normalized_id);

    if key.to_uppercase() == expected {
        let license_data = LicenseData {
            key: key.to_uppercase(),
            machine_id: normalized_id,
        };
        save_license(&license_data)
    } else {
        Err("Invalid license key".to_string())
    }
}

/// Derive a license key from a normalized machine ID using HMAC-SHA256.
/// Takes the first 16 hex characters and formats as XXXX-XXXX-XXXX-XXXX.
fn derive_license_key(normalized_id: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(LICENSE_SECRET)
        .expect("HMAC can take key of any size");
    mac.update(normalized_id.as_bytes());
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

/// Normalize a machine ID: lowercase, strip non-hex characters.
fn normalize_id(id: &str) -> String {
    id.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect()
}

/// Get the platform-native machine ID.
fn get_platform_machine_id() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        get_machine_id_macos()
    }
    #[cfg(target_os = "linux")]
    {
        get_machine_id_linux()
    }
    #[cfg(target_os = "windows")]
    {
        get_machine_id_windows()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("Unsupported platform".to_string())
    }
}

/// macOS: read IOPlatformUUID from ioreg.
#[cfg(target_os = "macos")]
fn get_machine_id_macos() -> Result<String, String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("ioreg failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // Line format: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            if let Some(start) = line.find("= \"") {
                let rest = &line[start + 3..];
                if let Some(end) = rest.find('"') {
                    let uuid = &rest[..end];
                    if !uuid.is_empty() {
                        return Ok(uuid.to_string());
                    }
                }
            }
        }
    }
    Err("Could not determine machine ID (IOPlatformUUID)".to_string())
}

/// Linux: read /etc/machine-id.
#[cfg(target_os = "linux")]
fn get_machine_id_linux() -> Result<String, String> {
    let id = std::fs::read_to_string("/etc/machine-id")
        .map_err(|e| format!("Cannot read /etc/machine-id: {}", e))?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("machine-id is empty".to_string());
    }
    Ok(id)
}

/// Windows: read MachineGuid from registry.
#[cfg(target_os = "windows")]
fn get_machine_id_windows() -> Result<String, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ,
        )
        .map_err(|e| format!("Cannot open registry key: {}", e))?;
    let guid: String = key
        .get_value("MachineGuid")
        .map_err(|e| format!("Cannot read MachineGuid: {}", e))?;
    if guid.is_empty() {
        return Err("MachineGuid is empty".to_string());
    }
    Ok(guid)
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
    let current_id = get_platform_machine_id()?;
    let normalized_current = normalize_id(&current_id);

    // Machine ID must match current machine (prevents copying license file)
    if data.machine_id != normalized_current {
        return Ok(false);
    }

    // Key must be valid for this machine ID
    let expected = derive_license_key(&normalized_current);
    Ok(data.key == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_license_key() {
        let id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        let key = derive_license_key(id);
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
        let id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        let key1 = derive_license_key(id);
        let key2 = derive_license_key(id);
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_normalize_id() {
        // UUID format with dashes
        assert_eq!(
            normalize_id("A1B2C3D4-E5F6-A1B2-C3D4-E5F6A1B2C3D4"),
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        );
        // Already normalized
        assert_eq!(
            normalize_id("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"),
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        );
        // Strips non-hex chars
        assert_eq!(
            normalize_id("A1:B2:C3:D4:E5:F6"),
            "a1b2c3d4e5f6"
        );
    }

    #[test]
    fn test_activate_license_validates_key() {
        // A wrong key should be rejected
        let result = activate_license("0000-0000-0000-0000".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_cross_platform_consistency() {
        // Same machine ID should produce same key regardless of input format
        let key1 = derive_license_key("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
        let key2 = derive_license_key(&normalize_id("A1B2C3D4-E5F6-A1B2-C3D4-E5F6A1B2C3D4"));
        assert_eq!(key1, key2);
    }
}

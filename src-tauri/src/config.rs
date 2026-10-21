//! Настройки приложения.
//!
//! Файл настроек лежит рядом с тем же путём, что и в Electron-версии
//! (`%APPDATA%\soundwave\soundwave-config.json`), чтобы пользователю не
//! пришлось заново выставлять громкость, тему и порт локального API.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

/// Папка с данными приложения: конфиг, шрифты, логи.
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("APPDATA") {
        return PathBuf::from(dir).join("soundwave");
    }
    PathBuf::from(".")
}

fn config_dir() -> PathBuf {
    data_dir()
}

fn config_path() -> PathBuf {
    config_dir().join("soundwave-config.json")
}

/// Значения по умолчанию — совпадают с Electron-версией.
fn defaults() -> Value {
    serde_json::json!({
        "theme": "dark",
        "baseTheme": "",
        "volume": 0.8,
        "discordEnabled": false,
        "discordClientId": "1562164443893211307",
        "discordLargeImage": "wave",
        "agentApiEnabled": true,
        "agentApiPort": 4783,
        "customFonts": [],
        "scClientId": "",
        "actionLog": false
    })
}

/// Читает настройки, дополняя отсутствующие ключи значениями по умолчанию.
pub fn load() -> Value {
    let mut value = defaults();

    if let Ok(text) = fs::read_to_string(config_path()) {
        if let Ok(saved) = serde_json::from_str::<Value>(&text) {
            if let Some(obj) = saved.as_object() {
                for (key, val) in obj {
                    value[key] = val.clone();
                }
            }
        }
    }

    value
}

/// Сохраняет настройки на диск.
pub fn save(value: &Value) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку настроек: {e}"))?;

    let path = config_path();
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("не удалось сохранить настройки: {e}"))
}

/// Меняет один ключ и сохраняет файл.
pub fn set_value(key: &str, val: Value) -> Result<(), String> {
    let mut config = load();
    if let Some(obj) = config.as_object_mut() {
        obj.insert(key.to_string(), val);
    }
    save(&config)
}

/// Список своих шрифтов (пути к файлам).
#[allow(dead_code)]
pub fn custom_fonts() -> Vec<String> {
    let config = load();
    config
        .get("customFonts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Сохраняет список своих шрифтов.
#[allow(dead_code)]
pub fn set_custom_fonts(fonts: &[String]) -> Result<(), String> {
    set_value("customFonts", serde_json::json!(fonts))
}

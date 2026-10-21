//! Настройки приложения.
//!
//! Файл настроек лежит рядом с тем же путём, что и в Electron-версии
//! (`%APPDATA%\soundwave\soundwave-config.json`), чтобы пользователю не
//! пришлось заново выставлять громкость, тему и порт локального API.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("APPDATA") {
        return PathBuf::from(dir).join("soundwave");
    }
    PathBuf::from(".")
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

/// Плоский список «ключ → значение» — для передачи в интерфейс.
pub fn flatten(value: &Value) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    if let Some(obj) = value.as_object() {
        for (key, val) in obj {
            map.insert(key.clone(), val.clone());
        }
    }
    map
}

/// Читает список своих шрифтов (пути к файлам).
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
pub fn set_custom_fonts(fonts: &[String]) -> Result<(), String> {
    set_value("customFonts", serde_json::json!(fonts))
}

/// Настройки в виде структуры — для Rust-кода, которому нужен тип.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub base_theme: String,
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default)]
    pub discord_client_id: String,
    #[serde(default)]
    pub agent_api_port: u16,
    #[serde(default = "default_true")]
    pub agent_api_enabled: bool,
    #[serde(default)]
    pub custom_fonts: Vec<String>,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_volume() -> f64 {
    0.8
}

fn default_true() -> bool {
    true
}

impl AppConfig {
    pub fn from_value(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or(AppConfig {
            theme: default_theme(),
            base_theme: String::new(),
            volume: default_volume(),
            discord_client_id: "1562164443893211307".to_string(),
            agent_api_port: 4783,
            agent_api_enabled: true,
            custom_fonts: Vec::new(),
        })
    }
}

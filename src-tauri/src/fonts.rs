//! Свои шрифты: импорт файлов, разбор имени и регистрация в интерфейсе.
//!
//! Файлы шрифтов лежат в папке `fonts` рядом с конфигом. Интерфейс получает
//! их как data-URL и регистрирует через FontFace.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Расширения файлов шрифтов, которые мы умеем принимать.
pub const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

/// MIME-тип по расширению.
pub fn font_mime(ext: &str) -> &'static str {
    match ext {
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Шрифт, сохранённый на диске.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredFont {
    pub id: String,
    /// Название файла без начертания, напр. «Turret Road Bold».
    pub name: String,
    /// Название семейства, напр. «Turret Road».
    pub display: String,
    /// CSS-семейство, напр. «SWFontTurretRoad».
    pub family: String,
    pub file: String,
    /// Начертание 200–900.
    pub weight: u16,
}

/// Признаки начертания в имени файла: шаблон, вес, название.
const FONT_WEIGHTS: [(&str, u16, &str); 8] = [
    (r"(?i)-?(extralight|ultralight)$", 200, "ExtraLight"),
    (r"(?i)-?(extrabold|ultrabold)$", 800, "ExtraBold"),
    (r"(?i)-?(semibold|demibold)$", 600, "SemiBold"),
    (r"(?i)-?(black|heavy)$", 900, "Black"),
    (r"(?i)-?light$", 300, "Light"),
    (r"(?i)-?medium$", 500, "Medium"),
    (r"(?i)-?bold$", 700, "Bold"),
    (r"(?i)-?(regular|book|normal)$", 400, "Regular"),
];

/// Разбирает имя файла: семейство, начертание и вес.
///
/// «Turret Road Bold» → семейство «Turret Road», начертание «Bold», вес 700.
pub fn parse_font_name(base: &str) -> (String, u16, String) {
    for (pattern, weight, suffix) in FONT_WEIGHTS {
        let regex = once_cell::sync::Lazy::new(|| regex::Regex::new(pattern).unwrap());
        if regex.is_match(base) {
            let display = regex.replace(base, "").trim().to_string();
            let display = if display.is_empty() {
                base.to_string()
            } else {
                display
            };
            return (display, weight, suffix.to_string());
        }
    }

    (base.to_string(), 400, "Regular".to_string())
}

/// Папка со шрифтами.
pub fn fonts_dir() -> PathBuf {
    crate::config::data_dir().join("fonts")
}

/// Список сохранённых шрифтов — из настроек.
pub fn list_stored_fonts() -> Vec<StoredFont> {
    let config = crate::config::load();

    config
        .get("customFonts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| serde_json::from_value::<StoredFont>(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Сохраняет список шрифтов в настройках.
pub fn store_fonts(fonts: &[StoredFont]) -> Result<(), String> {
    let value = serde_json::to_value(fonts).map_err(|e| e.to_string())?;
    crate::config::set_value("customFonts", value)
}

/// Готовит описание шрифта для интерфейса: описание + data-URL.
pub fn font_entry(font: &StoredFont) -> Option<Value> {
    let ext = PathBuf::from(&font.file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = font_mime(&ext);
    let data = fs::read(fonts_dir().join(&font.file)).ok()?;
    let data_url = format!("data:{mime};base64,{}", base64_encode(&data));

    Some(json!({
        "id": font.id,
        "name": font.name,
        "display": font.display,
        "family": font.family,
        "weight": font.weight,
        "file": font.file,
        "mime": mime,
        "dataUrl": data_url,
    }))
}

/// Список шрифтов с data-URL — то, что ждёт интерфейс.
pub fn list_entries() -> Vec<Value> {
    list_stored_fonts()
        .iter()
        .filter_map(font_entry)
        .collect()
}

/// Импортирует файл шрифта: копирует в папку, записывает в настройки.
pub fn import_font(source: &PathBuf) -> Result<Value, String> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !FONT_EXTENSIONS.contains(&ext.as_str()) {
        return Err("Файл не похож на шрифт".to_string());
    }

    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("font")
        .to_string();

    let (display, weight, suffix) = parse_font_name(&stem);

    let id = random_id();
    let family = format!("SWFont{}", keep_word_chars(&display));
    let file = format!("{id}-{}.{ext}", keep_file_chars(&stem));

    fs::create_dir_all(fonts_dir()).map_err(|e| format!("не удалось создать папку шрифтов: {e}"))?;
    fs::copy(source, fonts_dir().join(&file)).map_err(|e| format!("не удалось скопировать шрифт: {e}"))?;

    let font = StoredFont {
        id: id.clone(),
        name: format!("{display} {suffix}"),
        display,
        family,
        file,
        weight,
    };

    let mut fonts = list_stored_fonts();
    fonts.retain(|item| item.id != id);
    fonts.push(font.clone());
    store_fonts(&fonts)?;

    font_entry(&font).ok_or_else(|| "не удалось прочитать импортированный шрифт".to_string())
}

/// Удаляет шрифт (все начертания семейства) с диска и из настроек.
pub fn remove_font(family: &str) -> bool {
    let fonts = list_stored_fonts();
    let doomed: Vec<&StoredFont> = fonts.iter().filter(|item| item.family == family).collect();

    if doomed.is_empty() {
        return false;
    }

    for font in doomed {
        let _ = fs::remove_file(fonts_dir().join(&font.file));
    }

    let rest: Vec<StoredFont> = fonts
        .iter()
        .filter(|item| item.family != family)
        .cloned()
        .collect();

    let _ = store_fonts(&rest);
    true
}

/// Оставляет в имени только буквы и цифры.
fn keep_word_chars(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect()
}

/// Оставляет в имени файла безопасные символы.
fn keep_file_chars(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Случайный идентификатор файла — как в Electron-версии (6 байт в hex).
fn random_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // Добавляем немного случайности из адреса счётчика.
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut value = nanos as u64 ^ (counter.wrapping_mul(0x9E37_79B9_7F4A_7C15));

    // Простой перемешиватель — нам не криптостойкость, а уникальность.
    for _ in 0..3 {
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
    }

    format!("{value:012x}")
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Кодирует данные в base64 — без внешних зависимостей.
pub fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;

        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_font_names() {
        let (display, weight, suffix) = parse_font_name("Turret Road Bold");
        assert_eq!(display, "Turret Road");
        assert_eq!(weight, 700);
        assert_eq!(suffix, "Bold");

        let (display, weight, _) = parse_font_name("Inter Regular");
        assert_eq!(display, "Inter");
        assert_eq!(weight, 400);

        let (display, weight, _) = parse_font_name("SomeFont");
        assert_eq!(display, "SomeFont");
        assert_eq!(weight, 400);
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}

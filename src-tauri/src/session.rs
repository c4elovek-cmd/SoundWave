//! Работа с cookies SoundCloud.
//!
//! Формат вставки повторяет Electron-версию: строка заголовка Cookie,
//! JSON из Cookie-Editor или Netscape cookies.txt.

use serde_json::Value;

/// Пара «имя → значение».
pub type CookiePair = (String, String);

/// Разбирает вставленные cookies. Возвращает список пар или None.
pub fn parse_cookie_input(raw: &str) -> Option<Vec<CookiePair>> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }

    // JSON: [{"name":"oauth_token","value":"…"}] или {"cookies":[…]}
    if text.starts_with('[') || text.starts_with('{') {
        if let Ok(data) = serde_json::from_str::<Value>(text) {
            let mut pairs: Vec<CookiePair> = Vec::new();

            if let Some(array) = data.as_array() {
                for item in array {
                    push_pair(item, &mut pairs);
                }
            } else if let Some(array) = data.get("cookies").and_then(|v| v.as_array()) {
                for item in array {
                    // Формат EditThisCookie: ["name","value"]
                    if let Some(pair) = item.as_array() {
                        if pair.len() >= 2 {
                            let name = pair[0].as_str().unwrap_or_default().to_string();
                            let value = match &pair[1] {
                                Value::String(s) => s.clone(),
                                other => other.to_string(),
                            };
                            pairs.push((name, value));
                            continue;
                        }
                    }
                    push_pair(item, &mut pairs);
                }
            } else if let Some(obj) = data.as_object() {
                for (key, value) in obj {
                    if let Some(inner) = value.get("value") {
                        let text = match inner {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        pairs.push((key.clone(), text));
                    } else if let Value::String(s) = value {
                        pairs.push((key.clone(), s.clone()));
                    }
                }
            }

            if !pairs.is_empty() {
                return Some(pairs);
            }
        }
    }

    // Netscape cookies.txt: домен \t флаг \t путь \t secure \t срок \t имя \t значение
    if text.contains('\t') {
        let mut pairs: Vec<CookiePair> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() >= 7 {
                pairs.push((fields[5].to_string(), fields[6].to_string()));
            }
        }
        if !pairs.is_empty() {
            return Some(pairs);
        }
    }

    // Строка заголовка Cookie: "oauth_token=abc; tz=Europe/Moscow"
    if text.contains('=') {
        let cleaned = text
            .trim_start_matches("cookie:")
            .trim_start()
            .replace(['\r', '\n'], "; ");

        let pairs: Vec<CookiePair> = cleaned
            .split(';')
            .map(|pair| pair.trim())
            .filter(|pair| pair.contains('='))
            .filter_map(|pair| {
                let index = pair.find('=')?;
                let name = pair[..index].trim();
                let value = pair[index + 1..].trim();
                if name.is_empty() {
                    return None;
                }
                Some((name.to_string(), value.to_string()))
            })
            .collect();

        if !pairs.is_empty() {
            return Some(pairs);
        }
    }

    None
}

/// Достаёт пару «имя → значение» из объекта JSON.
fn push_pair(item: &Value, pairs: &mut Vec<CookiePair>) {
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("key").and_then(|v| v.as_str()));

    let Some(name) = name else {
        return;
    };

    let Some(value) = item.get("value") else {
        return;
    };

    let value = match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };

    pairs.push((name.to_string(), value));
}

/// Собирает заголовок Cookie из пар.
pub fn build_header(pairs: &[CookiePair]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<String>>()
        .join("; ")
}

/// Достаёт OAuth-токен из заголовка или списка пар.
pub fn oauth_token(pairs: &[CookiePair]) -> Option<String> {
    pairs
        .iter()
        .find(|(name, _)| name == "oauth_token")
        .map(|(_, value)| value.clone())
}

/// Тот же поиск, но по готовому заголовку.
pub fn oauth_token_from_header(header: &str) -> Option<String> {
    header
        .split(';')
        .map(|pair| pair.trim())
        .find_map(|pair| {
            let index = pair.find('=')?;
            let name = pair[..index].trim();
            if name == "oauth_token" {
                Some(pair[index + 1..].trim().to_string())
            } else {
                None
            }
        })
}

/// Разбирает готовый заголовок в пары.
pub fn header_to_pairs(header: &str) -> Vec<CookiePair> {
    header
        .split(';')
        .map(|pair| pair.trim())
        .filter_map(|pair| {
            let index = pair.find('=')?;
            let name = pair[..index].trim();
            if name.is_empty() {
                return None;
            }
            Some((name.to_string(), pair[index + 1..].trim().to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_header_string() {
        let pairs = parse_cookie_input("oauth_token=abc; tz=Europe/Moscow").unwrap();
        assert_eq!(pairs.len(), 2);
        assert_eq!(oauth_token(&pairs).unwrap(), "abc");
    }

    #[test]
    fn parses_json_array() {
        let pairs =
            parse_cookie_input(r#"[{"name":"oauth_token","value":"xyz"},{"name":"sc","value":"1"}]"#)
                .unwrap();
        assert_eq!(pairs.len(), 2);
        assert_eq!(oauth_token(&pairs).unwrap(), "xyz");
    }

    #[test]
    fn parses_json_object() {
        let pairs = parse_cookie_input(r#"{"cookies":[{"name":"oauth_token","value":"qqq"}]}"#).unwrap();
        assert_eq!(oauth_token(&pairs).unwrap(), "qqq");
    }

    #[test]
    fn parses_netscape() {
        let raw = ".soundcloud.com\tTRUE\t/\tTRUE\t0\toauth_token\tzzz";
        let pairs = parse_cookie_input(raw).unwrap();
        assert_eq!(oauth_token(&pairs).unwrap(), "zzz");
    }

    #[test]
    fn ignores_garbage() {
        assert!(parse_cookie_input("   ").is_none());
        assert!(parse_cookie_input("просто текст").is_none());
    }
}

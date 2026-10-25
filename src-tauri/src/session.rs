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

/// Значение cookie с этим именем из заголовка.
pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header_to_pairs(header)
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, value)| value)
}

/// Заголовок с заменённой (или добавленной в конец) cookie.
pub fn with_cookie(header: &str, name: &str, value: &str) -> String {
    let mut pairs: Vec<CookiePair> = header_to_pairs(header)
        .into_iter()
        .filter(|(n, _)| n != name)
        .collect();
    pairs.push((name.to_string(), value.to_string()));
    build_header(&pairs)
}

/// Раскодирует payload JWT — часть между двумя точками.
fn jwt_payload(token: &str) -> Option<Value> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Сколько секунд осталось у access-токена. None — не JWT или нет exp.
pub fn token_expires_in(token: &str) -> Option<i64> {
    let exp = jwt_payload(token)?.get("exp")?.as_i64()?;
    Some(exp - now_secs())
}

/// Истёк ли access-токен (с запасом в минуту). Не-JWT считаем живым.
pub fn token_expired(token: &str) -> bool {
    matches!(token_expires_in(token), Some(secs) if secs < 60)
}

/// client_id из claims токена — нужен для обновления сессии.
pub fn token_client_id(token: &str) -> Option<String> {
    jwt_payload(token)?
        .get("client_id")?
        .as_str()
        .map(String::from)
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

    #[test]
    fn jwt_helpers() {
        use base64::Engine;
        // payload: {"exp":<сейчас-10>,"client_id":"abc"}
        let payload = format!(
            "{{\"exp\":{},\"client_id\":\"abc\"}}",
            now_secs() - 10
        );
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let token = format!("h.{encoded}.s");

        assert!(token_expired(&token), "просроченный токен распознан");
        assert!(!token_expired("not-a-jwt"), "не-JJWT считается живым");
        assert_eq!(token_client_id(&token).as_deref(), Some("abc"));
        assert!(token_expires_in(&token).unwrap() <= -10);
    }

    #[test]
    fn cookie_replace() {
        let header = "a=1; oauth_token=old; b=2";
        assert_eq!(cookie_value(header, "oauth_token").as_deref(), Some("old"));
        assert_eq!(cookie_value(header, "nope"), None);

        let replaced = with_cookie(header, "oauth_token", "new");
        assert_eq!(cookie_value(&replaced, "oauth_token").as_deref(), Some("new"));
        assert_eq!(cookie_value(&replaced, "a").as_deref(), Some("1"));
        assert_eq!(cookie_value(&replaced, "b").as_deref(), Some("2"));

        let added = with_cookie(header, "fresh", "yes");
        assert_eq!(cookie_value(&added, "fresh").as_deref(), Some("yes"));
    }
}

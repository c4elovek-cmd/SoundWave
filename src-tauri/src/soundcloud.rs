//! Клиент внутреннего API SoundCloud.
//!
//! Логика повторяетelectron-версию: тот же client_id из JS-бандлов сайта,
//! тот же выбор потока (fMP4 предпочтительнее MPEG-TS) и тот же разбор
//! манифеста.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, REFERER, USER_AGENT};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const API_V2: &str = "https://api-v2.soundcloud.com";

/// SoundCloud отдаёт 401 на запросы без «нормального» User-Agent.
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

static CLIENT_ID_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r#""client_id":"([A-Za-z0-9]{32})""#).unwrap(),
        Regex::new(r#"client_id[=:]"?([A-Za-z0-9]{32})"#).unwrap(),
        Regex::new(r#""client_id":"([^"]{8,64})""#).unwrap(),
    ]
});

static SCRIPT_SRC: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"src="([^"]+\.js)"#).unwrap());

/// Ссылка на аудио: подписанный URL с CDN.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub url: String,
    pub protocol: String,
    pub duration: u64,
}

pub struct SoundCloud {
    client: reqwest::Client,
    client_id: Mutex<Option<String>>,
    /// Cookies сессии пользователя: `name=value; name2=value2`.
    cookie: Mutex<String>,
    /// OAuth-токен для приватных коллекций и записи.
    access_token: Mutex<Option<String>>,
    /// Метка времени последнего запроса — чтобы не ловить 429.
    last_request: Mutex<Instant>,
}

/// Минимальный интервал между запросами к API (мс).
const THROTTLE_MS: u64 = 220;

impl SoundCloud {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .timeout(Duration::from_secs(20))
            .build()
            .expect("не удалось собрать HTTP-клиент");

        Self {
            client,
            client_id: Mutex::new(None),
            cookie: Mutex::new(String::new()),
            access_token: Mutex::new(None),
            last_request: Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    /// Выдерживает паузу между запросами, чтобы SoundCloud не отвечал 429.
    async fn wait_turn(&self) {
        let wait = {
            let mut last = match self.last_request.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let elapsed = last.elapsed();
            *last = Instant::now();
            if elapsed < Duration::from_millis(THROTTLE_MS) {
                Duration::from_millis(THROTTLE_MS) - elapsed
            } else {
                Duration::ZERO
            }
        };

        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    /// client_id веб-клиента: достаётся из JS-бандлов soundcloud.com и кэшируется.
    pub async fn client_id(&self) -> Result<String, String> {
        if let Some(id) = self.client_id.lock().ok().and_then(|v| v.clone()) {
            return Ok(id);
        }

        let html = self
            .client
            .get("https://soundcloud.com/")
            .send()
            .await
            .map_err(|e| format!("SoundCloud недоступен: {e}"))?
            .text()
            .await
            .map_err(|e| format!("не удалось прочитать soundcloud.com: {e}"))?;

        let scripts: Vec<String> = SCRIPT_SRC
            .captures_iter(&html)
            .map(|c| c[1].to_string())
            .take(15)
            .collect();

        for src in scripts {
            let js = match self.client.get(&src).send().await {
                Ok(res) => res.text().await.unwrap_or_default(),
                Err(_) => continue,
            };

            if let Some(id) = extract_client_id(&js) {
                *self.client_id.lock().unwrap() = Some(id.clone());
                return Ok(id);
            }
        }

        Err("Не удалось получить client_id SoundCloud".to_string())
    }

    /// Заголовки запросов к API: User-Agent, Referer, cookie и OAuth-токен.
    pub fn api_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_UA));
        headers.insert(REFERER, HeaderValue::from_static("https://soundcloud.com/"));
        headers.insert(
            "Accept",
            HeaderValue::from_static("application/json"),
        );

        let cookie = self.cookie.lock().map(|c| c.clone()).unwrap_or_default();
        if !cookie.is_empty() {
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                headers.insert("Cookie", value);
            }
        }

        let token = self.access_token.lock().ok().and_then(|t| t.clone());
        if let Some(token) = token {
            if let Ok(value) = HeaderValue::from_str(&format!("OAuth {token}")) {
                headers.insert("Authorization", value);
            }
        }

        headers
    }

    pub fn set_session(&self, cookie: String, token: Option<String>) {
        if let Ok(mut guard) = self.cookie.lock() {
            *guard = cookie;
        }
        if let Ok(mut guard) = self.access_token.lock() {
            *guard = token;
        }
    }

    pub fn session(&self) -> (String, Option<String>) {
        let cookie = self.cookie.lock().map(|c| c.clone()).unwrap_or_default();
        let token = self.access_token.lock().ok().and_then(|t| t.clone());
        (cookie, token)
    }

    /// Запрос к внутреннему API.
    pub async fn api(
        &self,
        method: Method,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, String> {
        let client_id = self.client_id().await?;
        let mut url = if path.starts_with("http") {
            reqwest::Url::parse(path).map_err(|e| e.to_string())?
        } else {
            reqwest::Url::parse(&format!(
                "{API_V2}{}{path}",
                if path.starts_with('/') { "" } else { "/" }
            ))
            .map_err(|e| e.to_string())?
        };

        {
            let has_client_id = url
                .query()
                .map(|q| q.split('&').any(|pair| pair.starts_with("client_id=")))
                .unwrap_or(false);

            let mut query = url.query_pairs_mut();
            if !has_client_id {
                query.append_pair("client_id", &client_id);
            }
            for (key, value) in params {
                query.append_pair(key, value);
            }
        }

        let (status, text) = self.send_with_retry(method, url).await?;

        if !status.is_success() {
            return Err(format!("SoundCloud API вернул ошибку {status}"));
        }

        serde_json::from_str(&text).map_err(|e| format!("непонятный ответ API: {e}"))
    }

    /// Отправка запроса с повторами при сетевых сбоях и ответах 5xx.
    pub async fn send_with_retry(
        &self,
        method: Method,
        url: reqwest::Url,
    ) -> Result<(reqwest::StatusCode, String), String> {
        let mut last_error = String::from("запрос не ушёл");

        for attempt in 0..3 {
            self.wait_turn().await;

            match self
                .client
                .request(method.clone(), url.clone())
                .headers(self.api_headers())
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();

                    if status.is_server_error() && attempt < 2 {
                        last_error = format!("SoundCloud API вернул ошибку {status}");
                        tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
                        continue;
                    }

                    return Ok((status, text));
                }
                Err(e) => {
                    last_error = format!("запрос не ушёл: {e}");
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
                    }
                }
            }
        }

        Err(last_error)
    }

    /// Подписанная ссылка на аудио.
    pub async fn resolve_stream(&self, track_id: u64) -> Result<StreamInfo, String> {
        let track = self
            .api(Method::GET, &format!("/tracks/{track_id}"), &[])
            .await?;

        let transcodings = track
            .get("media")
            .and_then(|m| m.get("transcodings"))
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        // HLS-потоки: fMP4 (audio/mp4) играется через MSE, MPEG-TS — нет.
        let chosen = transcodings
            .iter()
            .find(|t| {
                t.get("format")
                    .and_then(|f| f.get("protocol"))
                    .and_then(|p| p.as_str())
                    == Some("progressive")
            })
            .or_else(|| {
                transcodings.iter().find(|t| {
                    t.get("format")
                        .and_then(|f| f.get("mime_type"))
                        .and_then(|m| m.as_str())
                        .map(|m| m.contains("mp4"))
                        .unwrap_or(false)
                })
            })
            .or_else(|| {
                transcodings.iter().find(|t| {
                    t.get("format")
                        .and_then(|f| f.get("protocol"))
                        .and_then(|p| p.as_str())
                        == Some("hls")
                })
            })
            .or_else(|| transcodings.first())
            .cloned()
            .ok_or("У трека нет доступных потоков")?;

        let manifest_path = chosen
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or("SoundCloud не вернул ссылку на манифест")?;

        let manifest = self
            .api(Method::GET, manifest_path, &[])
            .await
            .map_err(|e| format!("Поток недоступен: {e}"))?;

        let url = manifest
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or("SoundCloud не вернул ссылку на аудио")?
            .to_string();

        let protocol = chosen
            .get("format")
            .and_then(|f| f.get("protocol"))
            .and_then(|p| p.as_str())
            .unwrap_or("progressive")
            .to_string();

        let duration = track
            .get("duration")
            .and_then(|d| d.as_u64())
            .unwrap_or(0);

        Ok(StreamInfo {
            url,
            protocol,
            duration,
        })
    }
}

/// Ищет client_id в тексте JS-бандла.
fn extract_client_id(js: &str) -> Option<String> {
    for pattern in CLIENT_ID_PATTERNS.iter() {
        if let Some(captures) = pattern.captures(js) {
            let value = captures.get(1)?.as_str();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

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

/// Источник аудио для скачивания.
///
/// Часть файлов — обычный mp3, а у потоков HLS это отдельные сегменты:
/// их нужно скачать по порядку и соединить в один файл.
#[derive(Debug, Clone)]
pub struct DownloadSource {
    /// Файлы по порядку: для mp3 он один, для HLS — init и сегменты.
    pub parts: Vec<String>,
    /// Расширение итогового файла.
    pub extension: String,
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
            // Просроченный OAuth-токен ломает даже публичные запросы (401),
            // поэтому его не отправляем: анонимные запросы работают и так.
            if !crate::session::token_expired(&token) {
                if let Ok(value) = HeaderValue::from_str(&format!("OAuth {token}")) {
                    headers.insert("Authorization", value);
                }
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

    /// Обновляет OAuth-сессию SoundCloud по refresh-токену.
    ///
    /// Access-токен живёт сутки; когда он истекает, даже поиск отвечает 401.
    /// SoundCloud отдаёт новую пару токенов стандартным OAuth-запросом,
    /// а client_id берём из claims старого токена — так делает веб-клиент.
    /// Возвращает обновлённый заголовок Cookie для сохранения в настройках.
    pub async fn refresh_session(&self) -> Result<String, String> {
        let (header, token) = self.session();
        let Some(token) = token else {
            return Err("нет access-токена".to_string());
        };
        let Some(refresh) = crate::session::cookie_value(&header, "oauth_refresh_token") else {
            return Err("в cookies нет oauth_refresh_token".to_string());
        };
        let Some(client_id) = crate::session::token_client_id(&token) else {
            return Err("не удалось прочитать client_id из токена".to_string());
        };

        let body = format!(
            "client_id={client_id}&grant_type=refresh_token&refresh_token={refresh}"
        );

        let response = self
            .client
            .post("https://secure.soundcloud.com/oauth/token")
            .header(USER_AGENT, HeaderValue::from_static(BROWSER_UA))
            .header(REFERER, HeaderValue::from_static("https://soundcloud.com/"))
            .header(
                "Content-Type",
                HeaderValue::from_static("application/x-www-form-urlencoded; charset=UTF-8"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| format!("запрос refresh: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("SoundCloud отклонил refresh: {}", response.status()));
        }

        let json: Value = response
            .json()
            .await
            .map_err(|e| format!("разбор ответа refresh: {e}"))?;

        let access = json
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or("в ответе refresh нет access_token")?;
        let new_refresh = json.get("refresh_token").and_then(|v| v.as_str());

        let mut new_header = crate::session::with_cookie(&header, "oauth_token", access);
        if let Some(new_refresh) = new_refresh {
            new_header =
                crate::session::with_cookie(&new_header, "oauth_refresh_token", new_refresh);
        }

        self.set_session(new_header.clone(), Some(access.to_string()));

        Ok(new_header)
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


    /// Источник аудио для скачивания.
    ///
    /// Для воспроизведения берётся любой играбельный поток (в том числе HLS
    /// с кусками), а для скачивания нужен цельный файл: обычный mp3 либо
    /// склеенные сегменты HLS.
    pub async fn resolve_download(&self, track_id: u64) -> Result<DownloadSource, String> {
        let track = self
            .api(Method::GET, &format!("/tracks/{track_id}"), &[])
            .await?;

        let transcodings = track
            .get("media")
            .and_then(|m| m.get("transcodings"))
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        // 1. Обычный mp3 — идеальный вариант, один файл.
        if let Some(progressive) = transcodings
            .iter()
            .find(|t| protocol_of(t) == "progressive")
        {
            let manifest = self.manifest_url(progressive).await?;
            return Ok(DownloadSource {
                parts: vec![manifest],
                extension: "mp3".to_string(),
            });
        }

        // 2. HLS с fMP4: init-сегмент плюс куски — из них получается .m4a.
        let hls = transcodings
            .iter()
            .find(|t| protocol_of(t) == "hls" && mime_of(t).contains("mp4"))
            .or_else(|| transcodings.iter().find(|t| protocol_of(t) == "hls"))
            .ok_or("У трека нет потока, который можно скачать".to_string())?;

        let playlist_url = self.manifest_url(hls).await?;
        let playlist = self.get_text(&playlist_url).await?;
        let parts = parse_hls_parts(&playlist, &playlist_url);

        if parts.is_empty() {
            return Err("Плейлист трека пустой — скачать нечего".to_string());
        }

        Ok(DownloadSource {
            parts,
            extension: "m4a".to_string(),
        })
    }

    /// Ссылка на сам файл: у транскодировки она лежит в JSON-манифесте.
    async fn manifest_url(&self, transcoding: &Value) -> Result<String, String> {
        let path = transcoding
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or("SoundCloud не вернул ссылку на манифест")?;

        let manifest = self
            .api(Method::GET, path, &[])
            .await
            .map_err(|e| format!("Поток недоступен: {e}"))?;

        manifest
            .get("url")
            .and_then(|u| u.as_str())
            .map(|u| u.to_string())
            .ok_or_else(|| "SoundCloud не вернул ссылку на аудио".to_string())
    }

    /// Простой GET без разбора JSON — для плейлистов HLS.
    async fn get_text(&self, url: &str) -> Result<String, String> {
        let response = self
            .client
            .get(url)
            .header(USER_AGENT, BROWSER_UA)
            .send()
            .await
            .map_err(|e| format!("Не удалось получить плейлист: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("Плейлист недоступен: {}", response.status()));
        }

        response
            .text()
            .await
            .map_err(|e| format!("Не удалось прочитать плейлист: {e}"))
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

        // Выбираем поток, который браузер действительно сможет сыграть.
        //
        // У SoundCloud бывают три вида:
        //   progressive        — обычный mp3, играет всегда;
        //   hls                — открытый HLS с сегментами fMP4;
        //   ctr-encrypted-hls  — HLS с ключом в data-URI (Common Encryption),
        //                        такой hls.js расшифровывает;
        //   cbc-encrypted-hls  — FairPlay (`skd://`, com.apple.streamingkeydelivery),
        //                        его не играет ни один браузер — только в последнюю
        //                        очередь, когда других вариантов нет.
        let chosen = transcodings
            .iter()
            .find(|t| protocol_of(t) == "progressive")
            .or_else(|| transcodings.iter().find(|t| protocol_of(t) == "hls"))
            .or_else(|| {
                transcodings
                    .iter()
                    .find(|t| protocol_of(t) == "ctr-encrypted-hls")
            })
            .or_else(|| {
                transcodings
                    .iter()
                    .find(|t| mime_of(t).contains("mp4") && !protocol_of(t).contains("encrypted"))
            })
            .or_else(|| {
                transcodings
                    .iter()
                    .find(|t| protocol_of(t) == "cbc-encrypted-hls")
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

        // Остались только зашифрованные потоки: такой трек закрыт DRM
        // (FairPlay или Common Encryption) и браузер его не расшифрует.
        // Лучше честно сказать об этом, чем молча стоять на 0:00.
        if protocol.contains("encrypted") {
            return Err("Трек защищён DRM — звук недоступен".to_string());
        }

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

/// Протокол потока из списка транскодировок.
fn protocol_of(transcoding: &Value) -> &str {
    transcoding
        .get("format")
        .and_then(|f| f.get("protocol"))
        .and_then(|p| p.as_str())
        .unwrap_or("")
}

/// MIME-тип потока из списка транскодировок.
fn mime_of(transcoding: &Value) -> &str {
    transcoding
        .get("format")
        .and_then(|f| f.get("mime_type"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
}

/// Зашифрован ли поток (FairPlay или Common Encryption).
fn is_encrypted(transcoding: &Value) -> bool {
    protocol_of(transcoding).contains("encrypted")
}

/// Помечает DRM-треки прямо в ответе API.
///
/// У SoundCloud для защищённых треков есть только зашифрованные потоки —
/// их не играет ни один браузер. Флаг ставит интерфейс, чтобы не пускать
/// такие треки в очередь.
pub fn mark_drm_tracks(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                mark_drm_tracks(item);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                mark_drm_tracks(item);
            }

            let transcodings = map
                .get("media")
                .and_then(|media| media.get("transcodings"))
                .and_then(|list| list.as_array())
                .cloned();

            if let Some(transcodings) = transcodings {
                if !transcodings.is_empty() && transcodings.iter().all(is_encrypted) {
                    map.insert("drm".to_string(), Value::Bool(true));
                }
            }
        }
        _ => {}
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

/// Файлы HLS-плейлиста: init-сегмент и куски, по порядку.
///
/// Возвращает абсолютные ссылки: в плейлисте они могут быть относительными.
fn parse_hls_parts(playlist: &str, base_url: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();

    for line in playlist.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // #EXT-X-MAP:URI="..." — init-сегмент fMP4.
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = extract_quoted(rest) {
                if let Some(url) = absolute_url(base_url, &uri) {
                    parts.push(url);
                }
            }
            continue;
        }

        // Обычные строки — это сегменты.
        if !line.starts_with('#') {
            if let Some(url) = absolute_url(base_url, line) {
                parts.push(url);
            }
        }
    }

    parts
}

/// Значение в кавычках: URI="...".
fn extract_quoted(text: &str) -> Option<String> {
    let start = text.find('"')? + 1;
    let end = text[start..].find('"')? + start;
    Some(text[start..end].to_string())
}

/// Абсолютная ссылка: относительные дополняем адресом плейлиста.
fn absolute_url(base_url: &str, link: &str) -> Option<String> {
    if link.starts_with("http://") || link.starts_with("https://") {
        return Some(link.to_string());
    }

    let base = reqwest::Url::parse(base_url).ok()?;
    base.join(link).ok().map(|u| u.to_string())
}
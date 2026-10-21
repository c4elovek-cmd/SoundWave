//! Локальный HTTP API для агентов.
//!
//! Сервер слушает только 127.0.0.1, требует Bearer-токен и проксирует
//! команды в интерфейс: там живут плеер, очередь, поиск и тексты.
//! Токен и порт сохраняются в настройках, а готовая информация для агента
//! пишется в `agent-api.json` в папке данных приложения.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4783;
const PORT_ATTEMPTS: u16 = 10;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Ошибка, которая уходит агенту в теле ответа.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl ApiError {
    fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (
            status,
            Json(json!({ "ok": false, "error": self.message, "code": self.code })),
        )
            .into_response()
    }
}

/// Ожидающий запрос к интерфейсу.
type Pending = oneshot::Sender<Result<Value, ApiError>>;

/// Состояние локального API.
#[derive(Default)]
pub struct AgentApi {
    pending: Mutex<HashMap<String, Pending>>,
    seq: AtomicU64,
    token: Mutex<String>,
    port: Mutex<u16>,
}

impl AgentApi {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(DEFAULT_PORT),
            ..Default::default()
        }
    }

    pub fn token(&self) -> String {
        self.token.lock().map(|t| t.clone()).unwrap_or_default()
    }

    pub fn set_token(&self, token: String) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = token;
        }
    }

    pub fn port(&self) -> u16 {
        self.port.lock().map(|p| *p).unwrap_or(DEFAULT_PORT)
    }

    fn set_port(&self, port: u16) {
        if let Ok(mut guard) = self.port.lock() {
            *guard = port;
        }
    }
}

/// Общее состояние для обработчиков.
#[derive(Clone)]
struct ApiState {
    api: Arc<AgentApi>,
    app: AppHandle,
}

/// Запущенный сервер.
pub struct AgentApiHandle {
    pub port: u16,
    pub url: String,
    task: tokio::task::JoinHandle<()>,
}

impl AgentApiHandle {
    pub fn close(self) {
        self.task.abort();
    }
}

/// Проверяет Host и Bearer-токен.
fn authorize(headers: &HeaderMap, state: &ApiState) -> Result<(), ApiError> {
    let port = state.api.port();
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let allowed = [
        format!("{HOST}:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ];

    if !allowed.contains(&host) {
        return Err(ApiError::new(
            403,
            "forbidden_host",
            "Неверный заголовок Host",
        ));
    }

    let header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    let bearer = header
        .strip_prefix("Bearer ")
        .unwrap_or("")
        .trim();

    if bearer.is_empty() || bearer != state.api.token() {
        return Err(ApiError::new(
            401,
            "unauthorized",
            format!(
                "Нужен заголовок Authorization: Bearer <token>. Токен: {}",
                info_path().display()
            ),
        ));
    }

    Ok(())
}

/// Отправляет команду в интерфейс и ждёт ответа.
async fn ask_renderer(
    state: &ApiState,
    kind: &str,
    payload: Value,
) -> Result<Value, ApiError> {
    let seq = state.api.seq.fetch_add(1, Ordering::Relaxed);
    let id = format!("a{}{}", now_millis(), to_base36(seq));

    let (sender, receiver) = oneshot::channel();

    {
        let mut pending = match state.api.pending.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return Err(ApiError::new(
                    503,
                    "renderer_unavailable",
                    "Приложение недоступно",
                ))
            }
        };
        pending.insert(id.clone(), sender);
    }

    let _ = state.app.emit_to(
        "main",
        "agent-request",
        json!({ "id": id, "type": kind, "payload": payload }),
    );

    match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(ApiError::new(
            503,
            "renderer_unavailable",
            "Приложение закрылось",
        )),
        Err(_) => {
            if let Ok(mut pending) = state.api.pending.lock() {
                pending.remove(&id);
            }
            Err(ApiError::new(
                504,
                "timeout",
                "Приложение не ответило за 20 секунд",
            ))
        }
    }
}

/// Текущее время в миллисекундах.
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Число в системе счисления по основанию 36 — как в Electron-версии.
fn to_base36(mut value: u64) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

    if value == 0 {
        return "0".to_string();
    }

    let mut out = Vec::new();
    while value > 0 {
        out.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();

    String::from_utf8(out).unwrap_or_default()
}

/// Путь к файлу с информацией для агента.
fn info_path() -> std::path::PathBuf {
    crate::config::data_dir().join("agent-api.json")
}

// --- Обработчики -----------------------------------------------------------

async fn health(State(state): State<ApiState>) -> Json<Value> {
    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Json(json!({
        "app": "SoundWave",
        "version": state.app.package_info().version.to_string(),
        "ready": state.app.get_webview_window("main").is_some(),
        "uptime": uptime,
        "serverTime": chrono_now(),
    }))
}

async fn openapi(State(state): State<ApiState>) -> Json<Value> {
    Json(open_api_schema(state.api.port()))
}

async fn root(State(state): State<ApiState>) -> Json<Value> {
    let port = state.api.port();

    Json(json!({
        "name": "SoundWave Agent API",
        "version": state.app.package_info().version.to_string(),
        "auth": "Authorization: Bearer <token>",
        "tokenFile": info_path().display().to_string(),
        "openapi": format!("http://{HOST}:{port}/api/openapi.json"),
        "endpoints": [
            "GET /api/health",
            "GET /api/state",
            "GET /api/search?q=...&type=tracks|users|playlists",
            "POST /api/play {id|url|query}",
            "POST /api/control {action, value?, seconds?}",
            "GET|POST /api/queue",
            "GET /api/lyrics?trackId=...&synced=1",
            "GET /api/likes?limit=20",
            "GET /api/playlists",
            "GET /api/playlist/{id}",
            "GET /api/track/{id}",
            "POST /api/navigate {view}",
            "POST /api/show",
            "POST /api/karaoke {enabled}",
        ],
    }))
}

async fn get_state(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "state", json!({})).await?))
}

async fn search(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    let query = params.get("q").cloned().unwrap_or_default().trim().to_string();
    if query.chars().count() < 2 {
        return Err(ApiError::new(
            400,
            "bad_request",
            "Параметр q должен быть не короче 2 символов",
        ));
    }

    let kind = params.get("type").cloned().unwrap_or_else(|| "tracks".to_string());
    if !["tracks", "users", "playlists"].contains(&kind.as_str()) {
        return Err(ApiError::new(
            400,
            "bad_request",
            "type: tracks, users или playlists",
        ));
    }

    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 50))
        .unwrap_or(10);

    Ok(Json(
        ask_renderer(&state, "search", json!({ "query": query, "type": kind, "limit": limit })).await?,
    ))
}

async fn play(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    let has_id = body.get("id").is_some();
    let has_url = body.get("url").is_some();
    let has_query = body.get("query").is_some();

    if !has_id && !has_url && !has_query {
        return Err(ApiError::new(400, "bad_request", "Нужен id, url или query"));
    }

    Ok(Json(ask_renderer(&state, "play", body).await?))
}

async fn control(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    if body.get("action").and_then(|v| v.as_str()).is_none() {
        return Err(ApiError::new(400, "bad_request", "Нужно поле action"));
    }

    Ok(Json(ask_renderer(&state, "control", body).await?))
}

async fn queue_get(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(
        ask_renderer(&state, "queue", json!({ "action": "list" })).await?,
    ))
}

async fn queue_post(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "queue", body).await?))
}

async fn lyrics(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    let track_id = params.get("trackId").cloned();
    if let Some(raw) = &track_id {
        if raw.parse::<i64>().is_err() {
            return Err(ApiError::new(
                400,
                "bad_request",
                "trackId должен быть числом",
            ));
        }
    }

    let synced = params.get("synced").map(|v| v != "0").unwrap_or(true);

    Ok(Json(
        ask_renderer(
            &state,
            "lyrics",
            json!({ "trackId": track_id, "synced": synced }),
        )
        .await?,
    ))
}

async fn likes(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 100))
        .unwrap_or(20);

    Ok(Json(ask_renderer(&state, "likes", json!({ "limit": limit })).await?))
}

async fn playlists(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "playlists", json!({})).await?))
}

async fn playlist(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<u64>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "playlist", json!({ "id": id })).await?))
}

async fn track(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<u64>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "track", json!({ "id": id })).await?))
}

async fn navigate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;

    if body.get("view").and_then(|v| v.as_str()).is_none() {
        return Err(ApiError::new(400, "bad_request", "Нужно поле view"));
    }

    Ok(Json(ask_renderer(&state, "navigate", body).await?))
}

async fn show(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "show", json!({})).await?))
}

async fn karaoke(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(ask_renderer(&state, "karaoke", body).await?))
}

/// Схема OpenAPI — описания всех маршрутов.
fn open_api_schema(port: u16) -> Value {
    let track = json!({
        "type": "object",
        "properties": {
            "id": { "type": "integer" },
            "title": { "type": "string" },
            "artist": { "type": ["string", "null"] },
            "artistId": { "type": ["integer", "null"] },
            "artwork": { "type": ["string", "null"] },
            "duration": { "type": "number", "description": "Длительность в секундах" },
            "genre": { "type": ["string", "null"] },
            "permalink": { "type": ["string", "null"] },
            "playable": { "type": "boolean" },
            "likes": { "type": ["integer", "null"] },
            "plays": { "type": ["integer", "null"] },
        }
    });

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "SoundWave Agent API",
            "version": "0.5.1",
            "description": "Локальное управление плеером SoundWave. Сервер слушает только 127.0.0.1. Все защищённые запросы требуют заголовок Authorization: Bearer <token>. Токен и фактический порт лежат в agent-api.json в папке данных приложения.",
        },
        "servers": [{ "url": format!("http://{HOST}:{port}") }],
        "components": {
            "securitySchemes": {
                "bearerAuth": { "type": "http", "scheme": "bearer" }
            },
            "schemas": { "Track": track }
        },
        "security": [{ "bearerAuth": [] }],
        "paths": {
            "/api/health": {
                "get": {
                    "summary": "Проверка доступности",
                    "security": [],
                    "responses": { "200": { "description": "Приложение запущено" } }
                }
            },
            "/api/state": {
                "get": {
                    "summary": "Текущее состояние плеера и интерфейса",
                    "responses": { "200": { "description": "Состояние" } }
                }
            },
            "/api/search": {
                "get": {
                    "summary": "Поиск в SoundCloud",
                    "parameters": [
                        { "name": "q", "in": "query", "required": true, "schema": { "type": "string" } },
                        {
                            "name": "type",
                            "in": "query",
                            "schema": { "type": "string", "enum": ["tracks", "users", "playlists"], "default": "tracks" }
                        },
                        {
                            "name": "limit",
                            "in": "query",
                            "schema": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
                        }
                    ],
                    "responses": { "200": { "description": "Результаты поиска" } }
                }
            },
            "/api/play": {
                "post": {
                    "summary": "Включить трек по id, ссылке или поисковому запросу",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "integer" },
                                        "url": { "type": "string" },
                                        "query": { "type": "string" }
                                    }
                                },
                                "examples": {
                                    "byQuery": { "value": { "query": "IC3PEAK Смерти больше нет" } },
                                    "byId": { "value": { "id": 123456789 } }
                                }
                            }
                        }
                    },
                    "responses": { "200": { "description": "Трек поставлен" } }
                }
            },
            "/api/control": {
                "post": {
                    "summary": "Управление воспроизведением",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["action"],
                                    "properties": {
                                        "action": {
                                            "type": "string",
                                            "enum": [
                                                "play", "pause", "toggle", "next", "prev",
                                                "seek", "volume", "mute", "unmute", "shuffle", "repeat"
                                            ]
                                        },
                                        "seconds": { "type": "number", "description": "Для seek — секунда трека" }
                                    }
                                }
                            }
                        }
                    },
                    "responses": { "200": { "description": "Состояние плеера" } }
                }
            },
            "/api/queue": {
                "get": {
                    "summary": "Текущая очередь",
                    "responses": { "200": { "description": "Очередь" } }
                },
                "post": {
                    "summary": "Изменить очередь",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "action": { "type": "string", "enum": ["list", "clear", "remove", "move", "add"] },
                                        "index": { "type": "integer" },
                                        "to": { "type": "integer" },
                                        "id": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    },
                    "responses": { "200": { "description": "Очередь" } }
                }
            },
            "/api/lyrics": {
                "get": {
                    "summary": "Текст песни и тайминги караоке",
                    "parameters": [
                        { "name": "trackId", "in": "query", "schema": { "type": "integer" } },
                        { "name": "synced", "in": "query", "schema": { "type": "boolean", "default": true } }
                    ],
                    "responses": { "200": { "description": "Текст песни" } }
                }
            },
            "/api/likes": {
                "get": {
                    "summary": "Любимые треки",
                    "parameters": [
                        { "name": "limit", "in": "query", "schema": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 } }
                    ],
                    "responses": { "200": { "description": "Список треков" } }
                }
            },
            "/api/playlists": {
                "get": {
                    "summary": "Плейлисты пользователя",
                    "responses": { "200": { "description": "Список плейлистов" } }
                }
            },
            "/api/playlist/{id}": {
                "get": {
                    "summary": "Треки плейлиста",
                    "parameters": [
                        { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }
                    ],
                    "responses": { "200": { "description": "Список треков" } }
                }
            },
            "/api/track/{id}": {
                "get": {
                    "summary": "Трек по идентификатору",
                    "parameters": [
                        { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }
                    ],
                    "responses": { "200": { "description": "Трек" } }
                }
            },
            "/api/navigate": {
                "post": {
                    "summary": "Переключить раздел интерфейса",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["view"],
                                    "properties": {
                                        "view": { "type": "string", "enum": ["home", "search", "library", "likes", "uploads", "wave"] }
                                    }
                                }
                            }
                        }
                    },
                    "responses": { "200": { "description": "Раздел открыт" } }
                }
            },
            "/api/show": {
                "post": {
                    "summary": "Показать окно приложения",
                    "responses": { "200": { "description": "Окно показано" } }
                }
            },
            "/api/karaoke": {
                "post": {
                    "summary": "Включить или выключить караоке",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "enabled": { "type": "boolean" }
                                    }
                                }
                            }
                        }
                    },
                    "responses": { "200": { "description": "Караоке переключено" } }
                }
            }
        }
    })
}

/// Время в ISO-8601 без внешних зависимостей.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let (year, month, day) = civil_from_days(days);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Дата Гринвича из числа дней с начала эпохи.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Случайный токен для локального API — 24 байта в hex, как в Electron-версии.
pub fn new_token() -> String {
    use rand::RngCore;

    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);

    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Поднимает сервер на свободном порту.
pub async fn start(
    app: AppHandle,
    api: Arc<AgentApi>,
    port: u16,
) -> Result<AgentApiHandle, String> {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/openapi.json", get(openapi))
        .route("/api", get(root))
        .route("/", get(root))
        .route("/api/state", get(get_state))
        .route("/api/search", get(search))
        .route("/api/play", post(play))
        .route("/api/control", post(control))
        .route("/api/queue", get(queue_get).post(queue_post))
        .route("/api/lyrics", get(lyrics))
        .route("/api/likes", get(likes))
        .route("/api/playlists", get(playlists))
        .route("/api/playlist/{id}", get(playlist))
        .route("/api/track/{id}", get(track))
        .route("/api/navigate", post(navigate))
        .route("/api/show", post(show))
        .route("/api/karaoke", post(karaoke))
        .with_state(ApiState { api: api.clone(), app });

    let mut last_error = String::from("не удалось занять порт");

    for offset in 0..PORT_ATTEMPTS {
        let candidate = port + offset;
        let address = format!("{HOST}:{candidate}");

        let listener = match tokio::net::TcpListener::bind(&address).await {
            Ok(listener) => listener,
            Err(e) => {
                last_error = format!("порт {candidate}: {e}");
                continue;
            }
        };

        api.set_port(candidate);
        let url = format!("http://{address}");
        let info_path = info_path();

        // Информация для агента: адрес, токен, порт.
        let info = json!({
            "name": "SoundWave Agent API",
            "url": url,
            "token": api.token(),
            "authHeader": "Authorization: Bearer <token>",
            "openapi": format!("{url}/api/openapi.json"),
            "health": format!("{url}/api/health"),
            "pid": std::process::id(),
            "startedAt": chrono_now(),
        });

        if let Some(parent) = info_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            &info_path,
            serde_json::to_string_pretty(&info).unwrap_or_default(),
        );

        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("Agent API: сервер остановился: {e}");
            }
        });

        return Ok(AgentApiHandle {
            port: candidate,
            url,
            task,
        });
    }

    Err(last_error)
}

/// Ответ интерфейса на команду агента.
pub fn resolve_response(api: &AgentApi, response: &Value) {
    let id = response
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let sender = api
        .pending
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));

    let Some(sender) = sender else {
        return;
    };

    let ok = response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    if ok {
        let data = response.get("data").cloned().unwrap_or(Value::Null);
        let _ = sender.send(Ok(data));
        return;
    }

    let code = response
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("error")
        .to_string();

    let message = response
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("Ошибка в приложении")
        .to_string();

    let status = match code.as_str() {
        "bad_request" => 400,
        "not_found" => 404,
        _ => 500,
    };

    let _ = sender.send(Err(ApiError {
        status,
        code,
        message,
    }));
}

/// Убирает файл с информацией — сервер остановился.
pub fn remove_info_file() {
    let _ = std::fs::remove_file(info_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_to_base36() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
    }

    #[test]
    fn formats_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
    }
}

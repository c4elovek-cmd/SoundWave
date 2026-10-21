//! Точка входа приложения SoundWave на Tauri v2.
//!
//! Интерфейс остаётся тем же React-кодом, что и в Electron-версии:
//! мост `window.electronAPI` реализован поверх Tauri-команд
//! (`src/lib/tauriBridge.ts`), поэтому компоненты не трогаем.

mod config;
pub mod discord;
pub mod fonts;
pub mod lyrics;
pub mod session;
pub mod soundcloud;

use std::collections::HashMap;

use reqwest::Method;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use soundcloud::{SoundCloud, StreamInfo};

/// Общее состояние приложения.
pub struct AppState {
    pub sc: SoundCloud,
    /// OAuth-токен, который был до начала входа — чтобы отличить
    /// удачный вход от редиректа на /discover (SoundCloud иначе сразу
    /// открывает свою страницу, не спрашивая пароль).
    pub token_before_login: std::sync::Mutex<Option<String>>,
}

// --- SoundCloud API -------------------------------------------------------

/// client_id веб-клиента SoundCloud (достаётся из JS-бандлов и кэшируется).
#[tauri::command]
async fn get_client_id(state: State<'_, AppState>) -> Result<String, String> {
    state.sc.client_id().await
}

/// Прямая подписанная ссылка на аудио: трек → манифест → файл на CDN.
#[tauri::command]
async fn resolve_stream(state: State<'_, AppState>, track_id: u64) -> Result<StreamInfo, String> {
    state.sc.resolve_stream(track_id).await
}

/// Прокси к внутреннему API SoundCloud (GET).
#[tauri::command]
async fn sc_request(
    state: State<'_, AppState>,
    path: String,
    params: HashMap<String, String>,
) -> Result<Value, String> {
    let params: Vec<(String, String)> = params.into_iter().collect();
    state.sc.api(Method::GET, &path, &params).await
}

/// Прокси к внутреннему API SoundCloud (POST / PUT / DELETE).
#[tauri::command]
async fn sc_write(
    state: State<'_, AppState>,
    method: String,
    path: String,
    params: HashMap<String, String>,
) -> Result<Value, String> {
    let method = Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("неизвестный метод {method}"))?;

    let mut url = if path.starts_with("http") {
        reqwest::Url::parse(&path).map_err(|e| e.to_string())?
    } else {
        reqwest::Url::parse(&format!(
            "{}{}{path}",
            soundcloud::API_V2,
            if path.starts_with('/') { "" } else { "/" }
        ))
        .map_err(|e| e.to_string())?
    };

    {
        let client_id = state.sc.client_id().await?;
        let has_client_id = url
            .query()
            .map(|q| q.split('&').any(|pair| pair.starts_with("client_id=")))
            .unwrap_or(false);

        let mut query = url.query_pairs_mut();
        if !has_client_id {
            query.append_pair("client_id", &client_id);
        }
        for (key, value) in &params {
            query.append_pair(key, value);
        }
    }

    let (status, text) = state.sc.send_with_retry(method, url).await?;

    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!(
            "SoundCloud API вернул ошибку {status} ({snippet})"
        ));
    }

    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// Лайк / снятие лайка трека.
#[tauri::command]
async fn toggle_like(
    state: State<'_, AppState>,
    track_id: u64,
    like: bool,
) -> Result<Value, String> {
    let (cookie, token) = state.sc.session();

    let user_id = match state
        .sc
        .api(Method::GET, "/me", &[])
        .await
        .ok()
        .and_then(|me| me.get("id").and_then(|v| v.as_u64()))
    {
        Some(id) => id,
        None => return Err("Нужен вход в аккаунт SoundCloud".to_string()),
    };

    let urn = format!("soundcloud:system-playlists:personalized-tracks:{user_id}:{track_id}");
    let path = format!("/users/{user_id}/system_playlist_likes/{urn}");

    let params: Vec<(String, String)> = vec![
        ("app_version".to_string(), "1792400581".to_string()),
        ("app_locale".to_string(), "ru".to_string()),
    ];

    let method = if like { Method::PUT } else { Method::DELETE };
    let _ = (cookie, token);

    match state.sc.api(method, &path, &params).await {
        Ok(_) => Ok(serde_json::json!({ "ok": true, "liked": like })),
        Err(err) => Ok(serde_json::json!({ "ok": false, "error": err })),
    }
}

// --- Настройки -------------------------------------------------------------

/// Все настройки приложения.
#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Value {
    let mut config = config::load();

    if let Some(obj) = config.as_object_mut() {
        obj.insert("loggedIn".to_string(), Value::Bool(false));
        obj.insert(
            "version".to_string(),
            Value::String(app.package_info().version.to_string()),
        );
    }

    config
}

/// Меняет один параметр настроек.
#[tauri::command]
fn set_config_value(key: String, value: Value) -> Result<(), String> {
    config::set_value(&key, value)
}

/// Тема оформления.
#[tauri::command]
fn set_theme(theme: String, base: String) -> Result<bool, String> {
    config::set_value("theme", Value::String(theme))?;
    if !base.is_empty() {
        config::set_value("baseTheme", Value::String(base))?;
    }
    Ok(true)
}

/// Громкость плеера.
#[tauri::command]
fn set_volume(volume: f64) -> Result<bool, String> {
    config::set_value("volume", Value::from(volume))?;
    Ok(true)
}

/// Открыть ссылку в системном браузере.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Лог действий пользователя — помогает воспроизводить ошибки.
#[tauri::command]
fn log_action(action: String, details: Value) -> Result<(), String> {
    use std::io::Write;

    let dir = std::env::var("APPDATA")
        .map(|d| std::path::PathBuf::from(d).join("soundwave").join("logs"))
        .unwrap_or_else(|_| std::path::PathBuf::from("logs"));

    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("actions.log"))
        .map_err(|e| e.to_string())?;

    let mut file = file;
    let stamp = chrono_now();
    let line = serde_json::json!({
        "time": stamp,
        "action": action,
        "details": details,
    });

    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Время в ISO-8601 без внешних зависимостей.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Разложение по дате Гринвича без зависимостей.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let (year, month, day) = civil_from_days(days);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Дата Гринвича из числа дней с начала эпохи (алгоритм Howard Hinnant).
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

// --- Вход -----------------------------------------------------------------

/// Метка окна входа.
const AUTH_WINDOW: &str = "auth";

/// Адрес, с которого открыто главное окно: нужен для кнопок на странице
/// SoundCloud, чтобы «Назад» вернул нас в приложение.
fn app_origin(app: &AppHandle) -> String {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = win.url() {
            let mut origin = format!(
                "{}://{}",
                url.scheme(),
                url.host_str().unwrap_or("localhost")
            );
            if let Some(port) = url.port() {
                origin.push_str(&format!(":{port}"));
            }
            return origin;
        }
    }

    match app.config().build.dev_url.clone() {
        Some(url) => url.to_string().trim_end_matches('/').to_string(),
        None => "http://tauri.localhost".to_string(),
    }
}

/// Скрипт для страницы soundcloud.com: кнопки «Назад» и «Закрыть».
///
/// В Electron их рисовал preload; здесь — initialization_script, который
/// выполняется при каждой загрузке страницы, включая переходы внутри
/// SoundCloud.
fn login_helpers_script(origin: &str) -> String {
    format!(
        r#"
(function () {{
  var APP_ORIGIN = "{origin}";

  function mount() {{
    if (!document.body) return;
    if (document.getElementById("sw-login-helpers")) return;

    var box = document.createElement("div");
    box.id = "sw-login-helpers";
    box.style.cssText =
      "position:fixed;left:14px;bottom:14px;z-index:2147483647;display:flex;gap:8px;align-items:center;font:12px system-ui";

    var back = document.createElement("button");
    back.textContent = "← Назад";
    back.title = "Вернуться к выбору способа входа";
    back.style.cssText =
      "background:#ff5500;color:#fff;border:0;border-radius:10px;padding:9px 14px;cursor:pointer;font:600 12px system-ui";
    back.addEventListener("click", function () {{
      window.location.href = APP_ORIGIN + "/index.html#/auth";
    }});

    var close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Закрыть окно входа";
    close.style.cssText =
      "background:#1a1a1a;color:#bbb;border:1px solid #3a3a3a;border-radius:10px;padding:9px 12px;cursor:pointer;font:12px system-ui";
    close.addEventListener("click", function () {{
      try {{
        if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
          window.__TAURI_INTERNALS__.invoke("close_login_window");
          return;
        }}
      }} catch (e) {{}}
      window.location.href = APP_ORIGIN + "/index.html#/auth";
    }});

    box.appendChild(back);
    box.appendChild(close);
    document.body.appendChild(box);
  }}

  function start() {{
    mount();
    var observer = new MutationObserver(function () {{
      if (!document.getElementById("sw-login-helpers")) mount();
    }});
    observer.observe(document.documentElement, {{ childList: true, subtree: true }});
    var timer = window.setInterval(function () {{
      if (!document.getElementById("sw-login-helpers")) mount();
    }}, 1500);
    window.setTimeout(function () {{ window.clearInterval(timer); }}, 300000);
  }}

  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", start, {{ once: true }});
  }} else {{
    start();
  }}
}})();
"#
    )
}

/// Создаёт окно входа (или приводит его в порядок) и возвращает его.
fn ensure_auth_window(app: &AppHandle, route: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(AUTH_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(win);
    }

    let origin = app_origin(app);
    let script = login_helpers_script(&origin);

    WebviewWindowBuilder::new(
        app,
        AUTH_WINDOW,
        WebviewUrl::App(format!("index.html{route}").into()),
    )
    .title("Вход в SoundCloud")
    .inner_size(520.0, 700.0)
    .initialization_script(&script)
    .build()
    .map_err(|e| e.to_string())
}

/// Читает cookies SoundCloud из хранилища WebView2.
fn read_sc_cookies(win: &tauri::WebviewWindow) -> Vec<session::CookiePair> {
    let url = match reqwest::Url::parse("https://soundcloud.com/") {
        Ok(url) => url,
        Err(_) => return Vec::new(),
    };

    match win.cookies_for_url(url) {
        Ok(cookies) => cookies
            .iter()
            .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Сохраняет сессию в настройках и сообщает интерфейсу об успешном входе.
fn finish_login(app: &AppHandle, pairs: &[session::CookiePair]) -> Result<(), String> {
    let header = session::build_header(pairs);
    let token = session::oauth_token(pairs);

    if let Some(state) = app.try_state::<AppState>() {
        state.sc.set_session(header.clone(), token);
    }

    let _ = config::set_value("scCookies", Value::String(header.clone()));
    let _ = config::set_value("loggedIn", Value::Bool(true));

    let _ = app.emit("auth-success", header);
    Ok(())
}

/// Окно выбора способа входа.
#[tauri::command]
fn open_auth_window(app: AppHandle) -> Result<bool, String> {
    ensure_auth_window(&app, "#/auth")?;
    Ok(true)
}

/// Ручной вход: окно с полем для cookies.
#[tauri::command]
fn open_manual_login(app: AppHandle) -> Result<bool, String> {
    ensure_auth_window(&app, "#/auth/manual")?;
    Ok(true)
}

/// Настоящая страница входа SoundCloud.
#[tauri::command]
async fn open_real_login(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let win = ensure_auth_window(&app, "#/auth")?;

    // Токен до входа: если он не изменился, значит SoundCloud просто
    // редиректнул на свою страницу, а пользователь не входил.
    let current = state.sc.session().1;
    if let Ok(mut guard) = state.token_before_login.lock() {
        *guard = current;
    }

    let url = reqwest::Url::parse("https://soundcloud.com/signin").map_err(|e| e.to_string())?;
    win.navigate(url).map_err(|e| e.to_string())?;

    start_login_watcher(app, win);
    Ok(true)
}

/// Следит за cookies: как только появился новый oauth_token — вход состоялся.
fn start_login_watcher(app: AppHandle, win: tauri::WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        let mut empty_rounds = 0u32;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

            let pairs = read_sc_cookies(&win);
            let token = session::oauth_token(&pairs);

            let Some(token) = token else {
                empty_rounds += 1;
                if empty_rounds > 400 {
                    break;
                }
                continue;
            };

            // Токен должен отличаться от того, что был до входа.
            let before = app
                .try_state::<AppState>()
                .and_then(|state| {
                    state
                        .token_before_login
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone())
                });

            if before.as_deref() == Some(token.as_str()) {
                continue;
            }

            if finish_login(&app, &pairs).is_ok() {
                let _ = win.close();
            }
            break;
        }
    });
}

/// Закрыть окно входа.
#[tauri::command]
fn close_login_window(app: AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window(AUTH_WINDOW) {
        let _ = win.close();
    }
    Ok(true)
}

/// Ручной импорт cookies из браузера.
#[tauri::command]
async fn import_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
) -> Result<Value, String> {
    let Some(pairs) = session::parse_cookie_input(&raw) else {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Не удалось распознать cookies",
        }));
    };

    if pairs.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Cookies не распознаны или их нет",
        }));
    }

    let header = session::build_header(&pairs);
    let token = session::oauth_token(&pairs);

    state.sc.set_session(header.clone(), token.clone());

    // Кладём cookies в хранилище WebView2 — тогда повторный вход
    // на soundcloud.com не потребует пароля.
    if let Some(win) = app.get_webview_window("main") {
        for (name, value) in &pairs {
            let cookie = tauri::webview::cookie::Cookie::build((name.as_str(), value.as_str()))
                .domain(".soundcloud.com")
                .path("/")
                .secure(true)
                .build();
            let _ = win.set_cookie(cookie);
        }
    }

    // Проверяем, что SoundCloud нас узнал.
    if let Ok(check) = state.sc.api(Method::GET, "/me", &[]).await {
        if check.get("id").is_some() {
            finish_login(&app, &pairs)?;
            if let Some(win) = app.get_webview_window(AUTH_WINDOW) {
                let _ = win.close();
            }
            return Ok(serde_json::json!({ "ok": true, "count": pairs.len() }));
        }
    }

    Ok(serde_json::json!({
        "ok": false,
        "error": "SoundCloud не узнал эти cookies — проверьте, что вход выполнен",
    }))
}

/// Восстановление сессии при запуске.
#[tauri::command]
fn restore_session(state: State<'_, AppState>) -> Value {
    let config = config::load();
    let header = config
        .get("scCookies")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if header.is_empty() {
        return serde_json::json!({ "loggedIn": false, "cookies": "" });
    }

    let pairs = session::header_to_pairs(&header);
    let token = session::oauth_token(&pairs);

    state.sc.set_session(header.clone(), token);

    serde_json::json!({ "loggedIn": true, "cookies": header })
}

/// Есть ли активная сессия SoundCloud.
#[tauri::command]
fn has_session(state: State<'_, AppState>) -> bool {
    if state.sc.session().1.is_some() {
        return true;
    }

    let config = config::load();
    config
        .get("scCookies")
        .and_then(|v| v.as_str())
        .map(|header| session::oauth_token_from_header(header).is_some())
        .unwrap_or(false)
}

/// Проверка входа (для совместимости с Electron-версией).
#[tauri::command]
fn check_login(state: State<'_, AppState>) -> bool {
    has_session(state)
}

/// Текущие cookies сессии.
#[tauri::command]
fn dump_session_cookies(state: State<'_, AppState>) -> String {
    state.sc.session().0
}

/// Выход: чистим cookies и хранилище WebView2.
#[tauri::command]
fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    state.sc.set_session(String::new(), None);

    let _ = config::set_value("scCookies", Value::String(String::new()));
    let _ = config::set_value("loggedIn", Value::Bool(false));

    if let Some(win) = app.get_webview_window("main") {
        for (name, _) in read_sc_cookies(&win) {
            let cookie = tauri::webview::cookie::Cookie::build((name.as_str(), ""))
                .domain(".soundcloud.com")
                .path("/")
                .build();
            let _ = win.delete_cookie(cookie);
        }
    }

    let _ = app.emit("logged-out", ());
    Ok(true)
}

// --- Тексты песен ----------------------------------------------------------

/// Текст песни: Genius, при неудаче — LRCLIB.
#[tauri::command]
async fn get_lyrics(title: String, artist: String, description: String) -> Value {
    let result = lyrics::get_lyrics(&title, &artist, &description).await;
    serde_json::to_value(result).unwrap_or(Value::Null)
}

/// Тайминги строк для караоке — из открытого каталога LRCLIB.
#[tauri::command]
async fn get_synced_lyrics(title: String, artist: String, duration: f64) -> Value {
    let result = lyrics::get_synced_lyrics(&title, &artist, duration).await;
    serde_json::to_value(result).unwrap_or(Value::Null)
}

/// Закрывать окно в трей или выходить из приложения.
#[tauri::command]
fn set_close_to_tray(value: bool) -> Result<bool, String> {
    config::set_value("closeToTray", Value::Bool(value))?;
    Ok(true)
}

// --- Свои шрифты -----------------------------------------------------------

/// Список своих шрифтов с data-URL — их регистрирует интерфейс.
#[tauri::command]
fn list_custom_fonts() -> Vec<Value> {
    fonts::list_entries()
}

/// Импорт шрифта: диалог выбора файла, копирование, запись в настройки.
#[tauri::command]
async fn import_custom_font(app: AppHandle) -> Option<Value> {
    use tauri_plugin_dialog::DialogExt;

    let (sender, receiver) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Выбери файл шрифта")
        .add_filter("Шрифты", &fonts::FONT_EXTENSIONS)
        .pick_file(move |path| {
            let _ = sender.send(path);
        });

    let path = receiver.await.ok().flatten()?;
    let path = path.into_path().ok()?;

    fonts::import_font(&path).ok()
}

/// Удаление шрифта: все начертания семейства.
#[tauri::command]
fn remove_custom_font(family: String) -> bool {
    fonts::remove_font(&family)
}

// --- Discord Rich Presence -------------------------------------------------

/// Текущий Client ID: свой из настроек или вшитый в сборку.
fn discord_client_id(config: &Value) -> String {
    let custom = config
        .get("discordClientId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if custom.is_empty() {
        discord::DEFAULT_DISCORD_CLIENT_ID.to_string()
    } else {
        custom
    }
}

/// Статус Discord Rich Presence.
#[tauri::command]
fn discord_status(app: AppHandle) -> Value {
    let config = config::load();
    let custom = config
        .get("discordClientId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .is_empty();

    let connected = app
        .try_state::<discord::DiscordRpc>()
        .map(|rpc| rpc.is_connected())
        .unwrap_or(false);

    serde_json::json!({
        "enabled": config.get("discordEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
        "clientId": discord_client_id(&config),
        "builtIn": custom,
        "largeImage": config.get("discordLargeImage").and_then(|v| v.as_str()).unwrap_or(""),
        "connected": connected,
    })
}

/// Настройки Discord: включение, Client ID, обложка.
#[tauri::command]
fn set_discord_config(app: AppHandle, payload: Value) -> Result<Value, String> {
    if let Some(enabled) = payload.get("enabled").and_then(|v| v.as_bool()) {
        config::set_value("discordEnabled", Value::Bool(enabled))?;
    }
    if let Some(client_id) = payload.get("clientId").and_then(|v| v.as_str()) {
        config::set_value("discordClientId", Value::String(client_id.trim().to_string()))?;
    }
    if let Some(large_image) = payload.get("largeImage").and_then(|v| v.as_str()) {
        config::set_value(
            "discordLargeImage",
            Value::String(large_image.trim().to_string()),
        )?;
    }

    let config = config::load();
    let enabled = config
        .get("discordEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let client_id = discord_client_id(&config);

    if let Some(rpc) = app.try_state::<discord::DiscordRpc>() {
        if enabled && !client_id.is_empty() {
            rpc.connect(&client_id);
        } else {
            rpc.stop();
        }
    }

    Ok(discord_status(app))
}

/// Показывает активность в профиле Discord.
#[tauri::command]
fn set_discord_presence(app: AppHandle, presence: Option<Value>) -> Result<bool, String> {
    let config = config::load();

    // Выключено пользователем — не отправляем ничего.
    if config.get("discordEnabled").and_then(|v| v.as_bool()) == Some(false) {
        return Ok(false);
    }

    let Some(rpc) = app.try_state::<discord::DiscordRpc>() else {
        return Ok(false);
    };

    let Some(presence) = presence else {
        rpc.set_activity(None);
        return Ok(true);
    };

    let large_image = config
        .get("discordLargeImage")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let activity = discord::DiscordActivity {
        details: presence
            .get("details")
            .and_then(|v| v.as_str())
            .map(String::from),
        state: presence.get("state").and_then(|v| v.as_str()).map(String::from),
        large_text: presence
            .get("largeText")
            .and_then(|v| v.as_str())
            .map(String::from),
        small_text: presence
            .get("smallText")
            .and_then(|v| v.as_str())
            .map(String::from),
        large_image_key: Some(if large_image.is_empty() {
            discord::DEFAULT_DISCORD_ASSET.to_string()
        } else {
            large_image
        }),
        large_image_text: presence
            .get("largeText")
            .and_then(|v| v.as_str())
            .map(String::from),
        start_timestamp: presence.get("startTimestamp").and_then(|v| v.as_i64()),
    };

    rpc.set_activity(Some(activity));
    Ok(true)
}

/// Создаёт иконку в трее: управление воспроизведением и выход.
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Показать SoundWave", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play", "Воспроизвести / Пауза", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующий трек", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Предыдущий трек", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &play, &next, &prev, &quit])?;

    let mut builder = TrayIconBuilder::with_id("soundwave")
        .tooltip("SoundWave")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let handle = app.clone();
            match event.id().as_ref() {
                "show" => focus_main_window(handle),
                "play" => {
                    let _ = handle.emit("tray-play-pause", ());
                }
                "next" => {
                    let _ = handle.emit("tray-next", ());
                }
                "prev" => {
                    let _ = handle.emit("tray-prev", ());
                }
                "quit" => handle.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Левый клик — показать окно, как в остальных плеерах.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let handle = tray.app_handle().clone();
                focus_main_window(handle);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;

    Ok(())
}

/// Показывает главное окно и ставит его на передний план.
fn focus_main_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// --- Окно ------------------------------------------------------------------

fn main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.minimize();
    }
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) {
    if let Some(win) = main_window(&app) {
        if win.is_maximized().unwrap_or(false) {
            let _ = win.unmaximize();
        } else {
            let _ = win.maximize();
        }
    }
}

#[tauri::command]
fn window_is_maximized(app: tauri::AppHandle) -> bool {
    main_window(&app)
        .and_then(|win| win.is_maximized().ok())
        .unwrap_or(false)
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.close();
    }
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    focus_main_window(app);
}

#[tauri::command]
fn set_fullscreen(app: tauri::AppHandle, value: bool) {
    if let Some(win) = main_window(&app) {
        let _ = win.set_fullscreen(value);
        let _ = app.emit("app-fullscreen-changed", value);
    }
}

/// Перетаскивание окна мышью — аналог `-webkit-app-region: drag`.
#[tauri::command]
fn window_start_dragging(app: tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.start_dragging();
        }
    });
}

// --- Запуск ----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(AppState {
            sc: SoundCloud::new(),
            token_before_login: std::sync::Mutex::new(None),
        })
        .manage(discord::DiscordRpc::new())
        .setup(|app| {
            // Иконка в трее: из неё приложение возвращается и выходит.
            if let Err(e) = create_tray(app.handle()) {
                eprintln!("Не удалось создать трей: {e}");
            }

            // Discord Rich Presence подключаем сразу, если он включён.
            let config = config::load();
            let enabled = config
                .get("discordEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let client_id = discord_client_id(&config);

            if enabled && !client_id.is_empty() {
                if let Some(rpc) = app.try_state::<discord::DiscordRpc>() {
                    rpc.connect(&client_id);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_client_id,
            resolve_stream,
            sc_request,
            sc_write,
            toggle_like,
            get_lyrics,
            get_synced_lyrics,
            list_custom_fonts,
            import_custom_font,
            remove_custom_font,
            discord_status,
            set_discord_config,
            set_discord_presence,
            open_auth_window,
            open_manual_login,
            open_real_login,
            close_login_window,
            import_cookies,
            restore_session,
            has_session,
            check_login,
            dump_session_cookies,
            logout,
            get_config,
            set_config_value,
            set_close_to_tray,
            set_theme,
            set_volume,
            open_external,
            log_action,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            window_start_dragging,
            show_window,
            set_fullscreen,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }

                // По настройке: крестик либо сворачивает в трей, либо выходит.
                let close_to_tray = config::load()
                    .get("closeToTray")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    let handle = window.app_handle().clone();
                    let _ = window.destroy();
                    handle.exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}

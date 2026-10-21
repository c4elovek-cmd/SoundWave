//! Синхронизация сессии между версиями приложения (Rust и Electron).
//!
//! Cookies у Electron лежат в разделе сессии Chromium, у Rust — в хранилище
//! WebView2. Общий файл настроек (`soundwave-config.json`) связывает их:
//! в нём лежит строка cookies, которую записывает версия, где был вход.
//!
//! Здесь следим за этим файлом: вход в одной версии подхватывается в другой
//! сразу, а не после перезапуска.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::{config, session, AppState};

/// Как часто проверяем файл настроек.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Следит за сессией в общем файле настроек.
pub fn watch_session(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last = current_cookies();

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            let current = current_cookies();
            if current == last {
                continue;
            }
            last = current.clone();

            apply_session(&app, &current);
        }
    });
}

/// Текущая строка cookies из файла настроек.
fn current_cookies() -> String {
    config::load()
        .get("scCookies")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

/// Применяет сессию: обновляем клиент SoundCloud, кладём cookies в WebView2
/// и сообщаем интерфейсу.
fn apply_session(app: &AppHandle, cookies: &str) {
    let pairs = session::header_to_pairs(cookies);
    let token = session::oauth_token(&pairs);

    let changed = match app.try_state::<AppState>() {
        Some(state) => {
            let (current, _) = state.sc.session();
            current != cookies
        }
        None => false,
    };

    if let Some(state) = app.try_state::<AppState>() {
        state.sc.set_session(cookies.to_string(), token);
    }

    // Cookies в хранилище WebView2: окно входа на soundcloud.com должно
    // показывать уже выполненный вход.
    if let Some(win) = app.get_webview_window("main") {
        for (name, value) in &pairs {
            // Старый cookie с тем же именем убираем: два oauth_token в
            // заголовке — это запрос с неверным токеном.
            let stale = tauri::webview::cookie::Cookie::build((name.as_str(), ""))
                .domain(".soundcloud.com")
                .path("/")
                .build();
            let _ = win.delete_cookie(stale);

            let cookie = tauri::webview::cookie::Cookie::build((name.as_str(), value.as_str()))
                .domain(".soundcloud.com")
                .path("/")
                .secure(true)
                .build();
            let _ = win.set_cookie(cookie);
        }
    }

    // Если сессия не изменилась (например, файл переписали мы сами) —
    // интерфейс заново переспрашивать не нужно.
    if !changed {
        return;
    }

    if cookies.is_empty() {
        let _ = app.emit("logged-out", ());
    } else {
        let _ = app.emit("auth-success", cookies.to_string());
    }
}

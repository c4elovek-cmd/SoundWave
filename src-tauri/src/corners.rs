//! Скруглённые углы окна на Windows.
//!
//! В Windows окно Tauri не слоёное, поэтому прозрачные угли CSS не дают
//! эффекта: под ними всё равно фон окна. Решение — обрезать окно регионом
//! `CreateRoundRectRgn`: окно принимает скруглённую форму, и в углах
//! видно рабочий стол.

use tauri::{WebviewWindow, Window};

/// Радиус скругления в пикселях.
pub const CORNER_RADIUS: i32 = 12;

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    unsafe extern "system" {
        /// Прямоугольный регион со скруглёнными углами.
        pub fn CreateRoundRectRgn(
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            width: i32,
            height: i32,
        ) -> *mut c_void;

        /// Назначает окну регион: окно обрезается по этой форме.
        pub fn SetWindowRgn(hwnd: *mut c_void, hreg: *mut c_void, b_redraw: i32) -> i32;
    }
}

/// Применяет скругление к окну.
#[cfg(windows)]
pub fn apply(window: &Window, radius: i32) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // Регион задаётся для всего окна, поэтому берём внешний размер:
    // у frameless-окна Windows оставляет по 8 пикселей под изменение размера.
    let Ok(size) = window.outer_size() else {
        return;
    };

    let width = size.width as i32;
    let height = size.height as i32;
    if width <= 0 || height <= 0 {
        return;
    }

    unsafe {
        // Регион передаётся системе целиком: после SetWindowRgn удалять его нельзя.
        let region = ffi::CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
        if !region.is_null() {
            ffi::SetWindowRgn(hwnd.0, region, 1);
        }
    }
}

/// Применяет скругление к окну с webview.
#[cfg(windows)]
pub fn apply_webview(window: &WebviewWindow, radius: i32) {
    apply(&window.as_ref().window(), radius);
}

/// На других платформах ничего делать не нужно.
#[cfg(not(windows))]
pub fn apply(_window: &Window, _radius: i32) {}

/// На других платформах ничего делать не нужно.
#[cfg(not(windows))]
pub fn apply_webview(_window: &WebviewWindow, _radius: i32) {}

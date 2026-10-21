//! Прозрачное окно на Windows.
//!
//! Tauri рисует фон окна сам (softbuffer) и делает webview прозрачным, но
//! само окно остаётся без WS_EX_LAYERED. Поэтому прозрачные углы и края
//! закрываются чёрным. Добавляем флаг слоя — и окно становится по-настоящему
//! прозрачным: скруглённые углы показывают рабочий стол, а рамка под
//! изменение размера исчезает.

/// Делает окно слоёным: прозрачные участки показывают то, что под окном.
#[cfg(windows)]
pub fn make_layered(window: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
        if style & WS_EX_LAYERED as isize == 0 {
            SetWindowLongPtrW(hwnd.0, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
        }
    }
}

/// На других платформах окно и так прозрачное.
#[cfg(not(windows))]
pub fn make_layered(_window: &tauri::Window) {}

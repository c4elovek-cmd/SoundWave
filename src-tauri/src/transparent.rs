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

/// Убирает рамку окна, которую Windows оставляет под изменение размера.
///
/// У frameless-окна с WS_THICKFRAME клиентская область на 8 пикселей меньше
/// окна, и эта полоска видна по краю. Убираем флаг — окно занимает всю
/// площадь, и webview её перекрывает. Изменение размера мышью работает и
/// так: за это отвечает отдельное окно-перехватчик у Tauri.
#[cfg(windows)]
pub fn remove_resize_border(window: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WS_CAPTION, WS_THICKFRAME,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd.0, GWL_STYLE);
        let cleaned = style & !(WS_THICKFRAME as isize | WS_CAPTION as isize);
        if cleaned != style {
            SetWindowLongPtrW(hwnd.0, GWL_STYLE, cleaned);
        }
    }
}

/// На других платформах рамки нет.
#[cfg(not(windows))]
pub fn remove_resize_border(_window: &tauri::Window) {}

/// Красит рамку окна в цвет приложения.
///
/// Windows рисует неклиентскую область (полосу под изменение размера)
/// цветом кисти класса окна. По умолчанию она белая — на тёмном
/// приложении это заметная полоса. Меняем кисть на цвет фона.
#[cfg(windows)]
pub fn paint_frame(window: &tauri::Window, rgb: u32) {
    use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetClassLongPtrW, GCLP_HBRBACKGROUND,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let brush = CreateSolidBrush(rgb);
        if !brush.is_null() {
            SetClassLongPtrW(hwnd.0, GCLP_HBRBACKGROUND, brush as isize);
        }
    }
}

/// На других платформах рамки рисует система.
#[cfg(not(windows))]
pub fn paint_frame(_window: &tauri::Window, _rgb: u32) {}

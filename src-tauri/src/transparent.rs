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

/// Убирает светлую кайму по краю окна.
///
/// Windows 11 рисует рамку вокруг окна отдельным цветом (DWMWA_BORDER_COLOR).
/// У frameless-окна она остаётся, хотя окно без заголовка. Отключаем её.
#[cfg(windows)]
pub fn hide_border(window: &tauri::Window) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let none: u32 = DWMWA_COLOR_NONE as u32;

    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_BORDER_COLOR as u32,
            &none as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// На других платформах рамки нет.
#[cfg(not(windows))]
pub fn hide_border(_window: &tauri::Window) {}

/// Убирает рамку окна, которую Windows оставляет под изменение размера.
///
/// У frameless-окна с WS_THICKFRAME клиентская область на 8 пикселей меньше
/// окна, и эта полоска видна по краю. Убираем флаг и просим систему пересчитать
/// рамку — после этого клиентская область становится размером с окно, и
/// содержимое закрывает всю площадь.
#[cfg(windows)]
pub fn remove_resize_border(window: &tauri::Window) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, HWND_TOP,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SWP_FRAMECHANGED, WS_THICKFRAME,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd.0, GWL_STYLE);
        let cleaned = style & !(WS_THICKFRAME as isize);
        if cleaned != style {
            SetWindowLongPtrW(hwnd.0, GWL_STYLE, cleaned);

            // Система пересчитывает неклиентскую область только по запросу.
            // Задаём тот же размер окна: без рамки клиентская область
            // становится размером с окно, и содержимое закрывает всю площадь.
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(hwnd.0, &mut rect) != 0 {
                SetWindowPos(
                    hwnd.0,
                    HWND_TOP,
                    0,
                    0,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
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
    use windows_sys::Win32::Graphics::Gdi::{
        CreateSolidBrush, RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetClassLongPtrW, GCLP_HBRBACKGROUND};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let brush = CreateSolidBrush(rgb);
        if !brush.is_null() {
            SetClassLongPtrW(hwnd.0, GCLP_HBRBACKGROUND, brush as isize);

            // Кисть читается при перерисовке окна — просим её.
            RedrawWindow(
                hwnd.0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN,
            );
        }
    }
}

/// На других платформах рамки рисует система.
#[cfg(not(windows))]
pub fn paint_frame(_window: &tauri::Window, _rgb: u32) {}

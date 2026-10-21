// Точка входа приложения. Вся логика живёт в lib.rs — так она переиспользуется
// и в мобильных сборках Tauri.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    soundwave_lib::run()
}

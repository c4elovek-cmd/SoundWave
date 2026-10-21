/**
 * Какая оболочка запустила приложение.
 *
 * Под Tauri интерфейс работает в WebView2, под Electron — в Chromium.
 * Пользователю полезно знать, какую версию он запустил.
 */
export type Runtime = "Rust" | "Electron";

export function runtimeName(): Runtime {
  if (typeof window === "undefined") return "Electron";
  return "__TAURI_INTERNALS__" in window ? "Rust" : "Electron";
}

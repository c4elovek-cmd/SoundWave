/**
 * Мост между интерфейсом и Rust-бэкендом Tauri.
 *
 * Интерфейс написан под Electron и обращается к `window.electronAPI`.
 * Здесь тот же самый интерфейс собирается поверх Tauri-команд (`invoke`),
 * поэтому компоненты React не пришлось переписывать.
 *
 * Функции, которые ещё не перенесены на Rust, отдают безопасные заглушки:
 * интерфейс не падает, а журнал действий показывает, чего не хватает.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Запущено ли приложение внутри Tauri. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Подписка на событие Tauri с синхронной отпиской.
 * Tauri's listen возвращает Promise, а интерфейс ждёт функцию сразу.
 */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  void listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Значения параметров приходят как строки или числа — приводим к стокам. */
function toParams(
  params?: Record<string, string | number>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = String(value);
  }
  return out;
}

/**
 * Перетаскивание окна мышью.
 * В Electron за это отвечал CSS `-webkit-app-region: drag`; в WebView2 его нет,
 * поэтому ловим нажатие сами и зовём Rust-команду.
 */
function enableWindowDragging(): void {
  document.addEventListener(
    "mousedown",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const dragRegion = target.closest<HTMLElement>(".titlebar");
      if (!dragRegion) return;

      // Кнопки управления окном не должны двигать окно.
      if (target.closest(".titlebar-controls")) return;

      void invoke("window_start_dragging").catch(() => {});
    },
    true
  );
}

/** Собирает объект `window.electronAPI` поверх Tauri-команд. */
export function createTauriBridge(): Window["electronAPI"] {
  const notPorted = async (what: string) => {
    await invoke("log_action", {
      action: "not_ported",
      details: { feature: what },
    }).catch(() => {});
    return false;
  };

  const bridge = {
    // --- Настройки ---
    getConfig: () =>
      invoke<{
        theme: string;
        volume: number;
        loggedIn: boolean;
        version?: string;
      }>("get_config"),
    setTheme: (theme: string, base?: string) =>
      invoke<boolean>("set_theme", { theme, base: base ?? "" }),
    setVolume: (volume: number) => invoke<boolean>("set_volume", { volume }),

    // --- Авторизация ---
    openAuthWindow: () => invoke<boolean>("open_auth_window"),
    openRealLogin: () => invoke<boolean>("open_real_login"),
    openManualLogin: () => invoke<boolean>("open_manual_login"),
    showAuthChoice: () => invoke<boolean>("open_auth_window"),
    closeLoginWindow: () => invoke<boolean>("close_login_window"),
    importCookies: (raw: string) =>
      invoke<{ ok: boolean; count?: number; error?: string }>("import_cookies", {
        raw,
      }),
    dumpSessionCookies: () => invoke<string>("dump_session_cookies"),
    restoreSession: () =>
      invoke<{ loggedIn: boolean; cookies: string }>("restore_session"),
    checkLogin: () => invoke<boolean>("check_login"),
    hasSession: () => invoke<boolean>("has_session"),
    logout: () => invoke<boolean>("logout"),

    // --- Внутренний API SoundCloud ---
    scRequest: (path: string, params?: Record<string, string | number>) =>
      invoke<unknown>("sc_request", { path, params: toParams(params) }),
    resolveStream: (trackId: number) =>
      invoke<{ url: string; protocol: string; duration: number }>(
        "resolve_stream",
        { trackId }
      ),
    getClientId: () => invoke<string>("get_client_id"),
    scWrite: (
      method: string,
      path: string,
      params?: Record<string, string | number>
    ) =>
      invoke<unknown>("sc_write", { method, path, params: toParams(params) }),
    toggleLike: (trackId: number, like: boolean) =>
      invoke<{ ok: boolean; liked?: boolean; error?: string }>("toggle_like", {
        trackId,
        like,
      }),

    // --- Тексты песен ---
    getLyrics: async () => ({
      found: false,
      error: "Поиск текста ещё не перенесён на Rust",
    }),
    getSyncedLyrics: async () => ({
      found: false,
      error: "Поиск текста ещё не перенесён на Rust",
    }),
    openExternal: (url: string) => invoke<boolean>("open_external", { url }),

    // --- Локальный API для агентов ---
    onAgentRequest: () => () => {},
    sendAgentResponse: () => {},

    // --- Свои шрифты ---
    listCustomFonts: async () => [],
    importCustomFont: async () => null,
    removeCustomFont: async () => false,

    // --- Discord Rich Presence ---
    discordStatus: async () => ({
      enabled: false,
      clientId: "1562164443893211307",
      builtIn: true,
      largeImage: "wave",
      connected: false,
    }),
    setDiscordConfig: async () => ({
      enabled: false,
      clientId: "1562164443893211307",
      builtIn: true,
      largeImage: "wave",
      connected: false,
    }),
    setDiscordPresence: async () => false,

    // --- Настройки локального API ---
    agentApiConfig: async () => ({
      enabled: false,
      port: 4783,
      token: "",
      url: null,
    }),

    // --- Папка с данными ---
    openUserData: async () => false,

    // --- Журнал действий ---
    logAction: (action: string, details?: Record<string, unknown>) =>
      invoke<boolean>("log_action", { action, details: details ?? {} }),

    // --- Окно ---
    showWindow: () => invoke<boolean>("show_window"),
    minimizeToTray: async () => false,
    setFullscreen: (value: boolean) =>
      invoke<boolean>("set_fullscreen", { value }),
    onFullscreenChanged: (callback: (value: boolean) => void) =>
      subscribe<boolean>("app-fullscreen-changed", callback),

    windowMinimize: () => invoke<boolean>("window_minimize"),
    windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
    windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
    windowClose: () => invoke<boolean>("window_close"),
    onWindowMaximizedChanged: (callback: (value: boolean) => void) =>
      subscribe<boolean>("window-maximized-changed", callback),

    // --- События от бэкенда ---
    onAuthSuccess: (callback: (cookies: string) => void) => {
      void subscribe<string>("auth-success", callback);
    },
    onLoggedOut: (callback: () => void) => {
      void subscribe<null>("logged-out", () => callback());
    },
    onTrayPlayPause: (callback: () => void) => {
      void subscribe<null>("tray-play-pause", () => callback());
    },
    onTrayNext: (callback: () => void) => {
      void subscribe<null>("tray-next", () => callback());
    },
    onTrayPrev: (callback: () => void) => {
      void subscribe<null>("tray-prev", () => callback());
    },
    onMediaPlayPause: (callback: () => void) => {
      void subscribe<null>("media-play-pause", () => callback());
    },
    onMediaNext: (callback: () => void) => {
      void subscribe<null>("media-next", () => callback());
    },
    onMediaPrev: (callback: () => void) => {
      void subscribe<null>("media-prev", () => callback());
    },

    removeAllListeners: () => {},
  };

  return bridge as Window["electronAPI"];
}

/**
 * Ставит мост, если приложение запущено под Tauri.
 * Под Electron мост уже есть — его создаёт preload, ничего не трогаем.
 */
export function installTauriBridge(): void {
  if (!isTauri()) return;
  if (!window.electronAPI) {
    window.electronAPI = createTauriBridge();
  }
  enableWindowDragging();
}

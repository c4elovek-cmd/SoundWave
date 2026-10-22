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
 * Подписки на события: по имени канала храним функции отписки.
 *
 * Это нужно, чтобы `removeAllListeners` действительно отписывал слушателя.
 * Иначе в режиме разработки React вызывает эффект дважды, и команда
 * (например, play/pause) срабатывает дважды — то есть никак.
 */
const subscriptions = new Map<string, Set<() => void>>();

/**
 * Подписка на событие Tauri с синхронной отпиской.
 * Tauri's listen возвращает Promise, а интерфейс ждёт функцию сразу.
 */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  const off = () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
    subscriptions.get(event)?.delete(off);
  };

  const set = subscriptions.get(event);
  if (set) {
    set.add(off);
  } else {
    subscriptions.set(event, new Set([off]));
  }

  void listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return off;
}

/** Снимает все подписки на канал. */
function removeAllListeners(channel: string): void {
  const set = subscriptions.get(channel);
  if (!set) return;

  for (const off of [...set]) {
    off();
  }
  subscriptions.delete(channel);
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
    getLyrics: (title: string, artist: string, description?: string) =>
      invoke<{
        found: boolean;
        title?: string;
        artist?: string;
        url?: string;
        lyrics?: string;
        error?: string;
      }>("get_lyrics", { title, artist, description: description ?? "" }),
    getSyncedLyrics: (title: string, artist: string, duration: number) =>
      invoke<{
        found: boolean;
        syncedLyrics?: string;
        title?: string;
        artist?: string;
        duration?: number;
        error?: string;
      }>("get_synced_lyrics", { title, artist, duration }),
    openExternal: (url: string) => invoke<boolean>("open_external", { url }),

    // --- Автообновление ---
    checkForUpdates: () =>
      invoke<{
        ok: boolean;
        upToDate?: boolean;
        version?: string;
        current?: string;
        error?: string;
      }>("check_for_updates"),
    installUpdate: () =>
      invoke<{ ok: boolean; error?: string }>("install_update"),
    onUpdateAvailable: (callback: (info: { version: string }) => void) =>
      subscribe<{ version: string }>("update-available", callback),
    onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
      subscribe<{ version: string }>("update-downloaded", callback),
    onUpdateError: (callback: (info: { message: string }) => void) =>
      subscribe<{ message: string }>("update-error", callback),

    // --- Локальный API для агентов ---
    onAgentRequest: (callback: (request: { id: string; type: string; payload?: unknown }) => void) =>
      subscribe<{ id: string; type: string; payload?: unknown }>(
        "agent-request",
        callback
      ),
    sendAgentResponse: (response: {
      id: string;
      ok: boolean;
      data?: unknown;
      error?: string;
      code?: string;
    }) => {
      void invoke("send_agent_response", { response });
    },

    // --- Свои шрифты ---
    listCustomFonts: () =>
      invoke<
        {
          id: string;
          name: string;
          family: string;
          display: string;
          weight: number;
          file: string;
          mime: string;
          dataUrl: string;
        }[]
      >("list_custom_fonts"),
    importCustomFont: () =>
      invoke<{
        id: string;
        name: string;
        family: string;
        display: string;
        weight: number;
        file: string;
        mime: string;
        dataUrl: string;
      } | null>("import_custom_font"),
    removeCustomFont: (family: string) =>
      invoke<boolean>("remove_custom_font", { family }),

    // --- Discord Rich Presence ---
    discordStatus: () =>
      invoke<{
        enabled: boolean;
        clientId: string;
        builtIn: boolean;
        largeImage: string;
        connected: boolean;
      }>("discord_status"),
    setDiscordConfig: (config: {
      enabled?: boolean;
      clientId?: string;
      largeImage?: string;
    }) =>
      invoke<{
        enabled: boolean;
        clientId: string;
        builtIn: boolean;
        largeImage: string;
        connected: boolean;
      }>("set_discord_config", { payload: config }),
    setDiscordPresence: (presence: {
      details?: string;
      state?: string;
      largeText?: string;
      smallText?: string;
      startTimestamp?: number;
    } | null) => invoke<boolean>("set_discord_presence", { presence }),

    // --- Настройки локального API ---
    agentApiConfig: (config?: {
      enabled?: boolean;
      port?: number;
      regenerateToken?: boolean;
    }) =>
      invoke<{
        enabled: boolean;
        port: number;
        token: string;
        url: string | null;
      }>("agent_api_config", { config: config ?? null }),

    // --- Папка с данными ---
    openUserData: () => invoke<boolean>("open_user_data"),

    // Закрывать окно в трей или выходить из приложения
    setCloseToTray: (value: boolean) =>
      invoke<boolean>("set_close_to_tray", { value }),

    // --- Журнал действий ---
    logAction: (action: string, details?: Record<string, unknown>) =>
      invoke<boolean>("log_action", { action, details: details ?? {} }),

    // --- Окно ---
    showWindow: () => invoke<boolean>("show_window"),
    minimizeToTray: () => invoke<boolean>("minimize_to_tray"),
    setFullscreen: (value: boolean) =>
      invoke<boolean>("set_fullscreen", { value }),
    onFullscreenChanged: (callback: (value: boolean) => void) =>
      subscribe<boolean>("app-fullscreen-changed", callback),

    windowMinimize: () => invoke<boolean>("window_minimize"),
    // --- Скачивание ---
    downloadTrack: (trackId: number, title: string, artist: string) =>
      invoke<{ ok: boolean; path?: string; error?: string }>("download_track", {
        trackId,
        title,
        artist,
      }),
    openPath: (target: string) =>
      invoke<{ ok: boolean; error?: string }>("open_path", { path: target }),
    onDownloadProgress: (
      callback: (info: {
        trackId: number;
        percent: number;
        state: string;
        path?: string;
        error?: string;
      }) => void
    ) =>
      subscribe<{
        trackId: number;
        percent: number;
        state: string;
        path?: string;
        error?: string;
      }>("download-progress", callback),

    windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
    windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
    windowClose: () => invoke<boolean>("window_close"),
    onWindowMaximizedChanged: (callback: (value: boolean) => void) =>
      subscribe<boolean>("window-maximized-changed", callback),

    // --- События от бэкенда ---
    onAuthSuccess: (callback: (cookies: string) => void) =>
      subscribe<string>("auth-success", callback),
    onLoggedOut: (callback: () => void) =>
      subscribe<null>("logged-out", () => callback()),
    onTrayPlayPause: (callback: () => void) =>
      subscribe<null>("tray-play-pause", () => callback()),
    onTrayNext: (callback: () => void) =>
      subscribe<null>("tray-next", () => callback()),
    onTrayPrev: (callback: () => void) =>
      subscribe<null>("tray-prev", () => callback()),
    onMediaPlayPause: (callback: () => void) =>
      subscribe<null>("media-play-pause", () => callback()),
    onMediaNext: (callback: () => void) =>
      subscribe<null>("media-next", () => callback()),
    onMediaPrev: (callback: () => void) =>
      subscribe<null>("media-prev", () => callback()),

    removeAllListeners: (channel: string) => removeAllListeners(channel),
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

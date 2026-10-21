import { contextBridge, ipcRenderer } from "electron";

// На странице SoundCloud отдаём минимум: только две безобидные команды.
// Полный API приложения доступен только на собственных страницах.
const isExternalPage = /^https:\/\/(www\.)?soundcloud\.com\//i.test(window.location.href);

if (isExternalPage) {
  contextBridge.exposeInMainWorld("electronAPI", {
    showAuthChoice: () => ipcRenderer.invoke("show-auth-choice"),
    closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),
  });

  // Кнопки «Назад» и «Закрыть» рисуем прямо отсюда. Раньше это делал
  // main-процесс через webContents.executeJavaScript, но на тяжёлых
  // SPA-страницах SoundCloud тот промис так и не резолвился — кнопок
  // на экране не появлялось. Preload выполняется сразу при загрузке
  // документа, поэтому кнопки всегда успевают нарисоваться.
  const mountHelpers = () => {
    if (!document.body || document.getElementById("sw-login-helpers")) return;

    const box = document.createElement("div");
    box.id = "sw-login-helpers";
    box.style.cssText =
      "position:fixed;left:14px;bottom:14px;z-index:2147483647;display:flex;gap:8px;align-items:center;font:12px system-ui";

    const back = document.createElement("button");
    back.textContent = "← Назад";
    back.title = "Вернуться к выбору способа входа";
    back.style.cssText =
      "background:#ff5500;color:#fff;border:0;border-radius:10px;padding:9px 14px;cursor:pointer;font:600 12px system-ui";
    // В изолированном мире window.electronAPI недоступен — зовём IPC напрямую
    back.addEventListener("click", () => void ipcRenderer.invoke("show-auth-choice"));

    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Закрыть окно входа";
    close.style.cssText =
      "background:#1a1a1a;color:#bbb;border:1px solid #3a3a3a;border-radius:10px;padding:9px 12px;cursor:pointer;font:12px system-ui";
    close.addEventListener("click", () => void ipcRenderer.invoke("close-login-window"));

    box.appendChild(back);
    box.appendChild(close);
    document.body.appendChild(box);
  };

  const startHelpers = () => {
    mountHelpers();

    // SPA перерисовывает страницу и может убрать наши кнопки —
    // наблюдатель возвращает их на место.
    const observer = new MutationObserver(() => {
      if (!document.getElementById("sw-login-helpers")) mountHelpers();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Страховка: если разметка перестроилась целиком
    const timer = window.setInterval(() => {
      if (!document.getElementById("sw-login-helpers")) mountHelpers();
    }, 1500);
    window.setTimeout(() => window.clearInterval(timer), 120_000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startHelpers, { once: true });
  } else {
    startHelpers();
  }
} else {
  // Пробрасываем безопасные API в рендерер
  contextBridge.exposeInMainWorld("electronAPI", {
    // Конфигурация
    getConfig: () => ipcRenderer.invoke("get-config"),
    setTheme: (theme: string, base?: string) =>
      ipcRenderer.invoke("set-theme", theme, base ?? ""),
    setVolume: (volume: number) => ipcRenderer.invoke("set-volume", volume),

    // Авторизация
    openAuthWindow: () => ipcRenderer.invoke("open-auth-window"),
    openRealLogin: () => ipcRenderer.invoke("open-real-login"),
    openManualLogin: () => ipcRenderer.invoke("open-manual-login"),
    showAuthChoice: () => ipcRenderer.invoke("show-auth-choice"),
    closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),
    importCookies: (raw: string) => ipcRenderer.invoke("import-cookies", raw),
    dumpSessionCookies: () => ipcRenderer.invoke("dump-session-cookies"),
    restoreSession: () => ipcRenderer.invoke("restore-session"),
    checkLogin: () => ipcRenderer.invoke("check-login"),
    hasSession: () => ipcRenderer.invoke("has-session"),
    logout: () => ipcRenderer.invoke("logout"),

    // Внутренний API SoundCloud — запросы идут через main-процесс
    scRequest: (path: string, params?: Record<string, string | number>) =>
      ipcRenderer.invoke("sc-request", path, params ?? {}),
    resolveStream: (trackId: number) => ipcRenderer.invoke("sc-resolve-stream", trackId),
    getClientId: () => ipcRenderer.invoke("get-client-id"),
    scWrite: (
      method: string,
      path: string,
      params?: Record<string, string | number>
    ) => ipcRenderer.invoke("sc-write", method, path, params ?? {}),
    toggleLike: (trackId: number, like: boolean) =>
      ipcRenderer.invoke("sc-toggle-like", trackId, like),

    // Тексты песен с Genius и внешние ссылки
    getLyrics: (title: string, artist: string, description?: string) =>
      ipcRenderer.invoke("genius-lyrics", {
        title,
        artist,
        description: description ?? "",
      }),
    getSyncedLyrics: (title: string, artist: string, duration: number) =>
      ipcRenderer.invoke("synced-lyrics", { title, artist, duration }),
    openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

    // Локальный API для агентов: main присылает команду, renderer отвечает
    onAgentRequest: (
      callback: (request: { id: string; type: string; payload?: unknown }) => void
    ) => {
      const listener = (_event: unknown, request: { id: string; type: string; payload?: unknown }) =>
        callback(request);
      ipcRenderer.on("agent-request", listener);
      return () => {
        ipcRenderer.removeListener("agent-request", listener);
      };
    },
    sendAgentResponse: (response: {
      id: string;
      ok: boolean;
      data?: unknown;
      error?: string;
      code?: string;
    }) => ipcRenderer.send("agent-response", response),

    // Свои шрифты
    listCustomFonts: () => ipcRenderer.invoke("fonts-list"),
    importCustomFont: () => ipcRenderer.invoke("fonts-import"),
    removeCustomFont: (family: string) => ipcRenderer.invoke("fonts-remove", family),

    // Discord Rich Presence
    discordStatus: () => ipcRenderer.invoke("discord-status"),
    setDiscordConfig: (config: {
      enabled?: boolean;
      clientId?: string;
      largeImage?: string;
    }) => ipcRenderer.invoke("discord-config", config),
    setDiscordPresence: (
      presence: {
        details?: string;
        state?: string;
        largeText?: string;
        smallText?: string;
        startTimestamp?: number;
      } | null
    ) => ipcRenderer.invoke("discord-presence", presence),

    // Настройки локального API
    agentApiConfig: (config?: {
      enabled?: boolean;
      port?: number;
      regenerateToken?: boolean;
    }) => ipcRenderer.invoke("agent-api-config", config),

    // Папка с данными приложения
    openUserData: () => ipcRenderer.invoke("open-user-data"),

    // Закрывать окно в трей или выходить из приложения
    setCloseToTray: (value: boolean) =>
      ipcRenderer.invoke("set-close-to-tray", value),

    // Журнал действий пользователя (для разбора багов)
    logAction: (action: string, details?: Record<string, unknown>) =>
      ipcRenderer.invoke("log-action", action, details ?? {}),

    // Окно
    showWindow: () => ipcRenderer.invoke("show-window"),
    minimizeToTray: () => ipcRenderer.invoke("minimize-to-tray"),
    setFullscreen: (value: boolean) => ipcRenderer.invoke("set-fullscreen", value),
    onFullscreenChanged: (callback: (value: boolean) => void) => {
      const listener = (_event: unknown, value: boolean) => callback(value);
      ipcRenderer.on("app-fullscreen-changed", listener);
      return () => {
        ipcRenderer.removeListener("app-fullscreen-changed", listener);
      };
    },

    // Свои кнопки окна
    windowMinimize: () => ipcRenderer.invoke("window-minimize"),
    windowToggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
    windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
    windowClose: () => ipcRenderer.invoke("window-close"),
    onWindowMaximizedChanged: (callback: (value: boolean) => void) => {
      const listener = (_event: unknown, value: boolean) => callback(value);
      ipcRenderer.on("window-maximized-changed", listener);
      return () => {
        ipcRenderer.removeListener("window-maximized-changed", listener);
      };
    },

    // События от main-процесса
    onAuthSuccess: (callback: (cookies: string) => void) => {
      ipcRenderer.on("auth-success", (_event, cookies) => callback(cookies));
    },
    onLoggedOut: (callback: () => void) => {
      ipcRenderer.on("logged-out", () => callback());
    },
    onTrayPlayPause: (callback: () => void) => {
      ipcRenderer.on("tray-play-pause", () => callback());
    },
    onTrayNext: (callback: () => void) => {
      ipcRenderer.on("tray-next", () => callback());
    },
    onTrayPrev: (callback: () => void) => {
      ipcRenderer.on("tray-prev", () => callback());
    },
    onMediaPlayPause: (callback: () => void) => {
      ipcRenderer.on("media-play-pause", () => callback());
    },
    onMediaNext: (callback: () => void) => {
      ipcRenderer.on("media-next", () => callback());
    },
    onMediaPrev: (callback: () => void) => {
      ipcRenderer.on("media-prev", () => callback());
    },

    // Убрать слушатели
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    },
  });
}

import { contextBridge, ipcRenderer } from "electron";

// На странице SoundCloud отдаём минимум: только две безобидные команды.
// Полный API приложения доступен только на собственных страницах.
const isExternalPage = /^https:\/\/(www\.)?soundcloud\.com\//i.test(window.location.href);

if (isExternalPage) {
  contextBridge.exposeInMainWorld("electronAPI", {
    showAuthChoice: () => ipcRenderer.invoke("show-auth-choice"),
    closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),
  });
} else {
  // Пробрасываем безопасные API в рендерер
  contextBridge.exposeInMainWorld("electronAPI", {
    // Конфигурация
    getConfig: () => ipcRenderer.invoke("get-config"),
    setTheme: (theme: string) => ipcRenderer.invoke("set-theme", theme),
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
    logout: () => ipcRenderer.invoke("logout"),

    // Внутренний API SoundCloud — запросы идут через main-процесс
    scRequest: (path: string, params?: Record<string, string | number>) =>
      ipcRenderer.invoke("sc-request", path, params ?? {}),
    resolveStream: (trackId: number) => ipcRenderer.invoke("sc-resolve-stream", trackId),
    getClientId: () => ipcRenderer.invoke("get-client-id"),

    // Окно
    showWindow: () => ipcRenderer.invoke("show-window"),
    minimizeToTray: () => ipcRenderer.invoke("minimize-to-tray"),

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

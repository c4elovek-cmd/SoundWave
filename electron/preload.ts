import { contextBridge, ipcRenderer } from "electron";

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
  importCookies: (raw: string) => ipcRenderer.invoke("import-cookies", raw),
  dumpSessionCookies: () => ipcRenderer.invoke("dump-session-cookies"),
  restoreSession: () => ipcRenderer.invoke("restore-session"),
  closeAuthWindow: (cookies: string) =>
    ipcRenderer.invoke("close-auth-window", cookies),
  checkLogin: () => ipcRenderer.invoke("check-login"),
  logout: () => ipcRenderer.invoke("logout"),

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

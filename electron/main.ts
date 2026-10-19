import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  session,
} from "electron";
import path from "path";
import { fileURLToPath } from "url";
import Store from "electron-store";
import log from "electron-log";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Логирование
log.transports.file.level = "info";
log.info("SoundWave запущен");

const store = new Store({
  name: "soundwave-config",
  defaults: {
    theme: "dark",
    volume: 0.8,
    windowBounds: { width: 1280, height: 800 },
    loggedIn: false,
    scCookies: null as string | null,
  },
});

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const DIST = path.join(__dirname, "../dist");
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const bounds = store.get("windowBounds") as { width: number; height: number };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    title: "SoundWave",
    backgroundColor: "#121212",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: "persist:soundcloud",
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    log.info("Главное окно показано");
  });

  // Сворачивание в трей
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });

  mainWindow.on("resize", () => {
    if (mainWindow) {
      const [width, height] = mainWindow.getSize();
      store.set("windowBounds", { width, height });
    }
  });

  // Загрузка
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(DIST, "index.html"));
  }

  log.info("Окно создано, загрузка...");
}

/**
 * Открывает окно входа с настоящей страницей SoundCloud.
 * Пароль вводится на soundcloud.com и не проходит через приложение.
 * Когда SoundCloud перебрасывает пользователя со /login на /discover (успешный вход),
 * мы забираем cookie сессии и передаём их в главное окно.
 */
function openRealLoginWindow(parent: BrowserWindow | null) {
  const loginWin = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Вход в SoundCloud",
    backgroundColor: "#121212",
    parent: parent || undefined,
    modal: Boolean(parent),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:soundcloud",
    },
  });

  loginWin.once("ready-to-show", () => loginWin.show());
  loginWin.loadURL("https://soundcloud.com/signin");

  let handled = false;

  const finishLogin = async () => {
    if (handled) return;
    handled = true;
    try {
      const cookies = await loginWin.webContents.session.cookies.get({
        domain: ".soundcloud.com",
      });
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const hasAuth = cookies.some(
        (c) => c.name === "oauth_token" || c.name === "SC_REF" || c.name.indexOf("oauth") === 0,
      );

      if (!cookieHeader) {
        handled = false;
        return;
      }

      store.set("scCookies", cookieHeader);
      store.set("loggedIn", true);
      mainWindow?.webContents.send("auth-success", cookieHeader);
      log.info(`Вход выполнен, cookies получены (auth=${hasAuth})`);
      loginWin.close();
      mainWindow?.show();
      mainWindow?.focus();
    } catch (e) {
      log.error("Не удалось забрать cookies", e);
      handled = false;
    }
  };

  // SoundCloud после входа редиректит на /discover, /stream или /you
  loginWin.webContents.on("did-navigate", (_event, url) => {
    log.info(`Auth navigate: ${url}`);
    if (
      /soundcloud\.com\/(discover|stream|you|feed)/.test(url) &&
      !/\/signin/.test(url)
    ) {
      setTimeout(finishLogin, 800);
    }
  });

  loginWin.webContents.on("did-navigate-in-page", (_event, url) => {
    if (/soundcloud\.com\/(discover|stream|you|feed)/.test(url)) {
      setTimeout(finishLogin, 800);
    }
  });

  loginWin.on("closed", () => {
    log.info("Окно входа закрыто");
  });

  return loginWin;
}

function createAuthWindow() {
  authWindow = new BrowserWindow({
    width: 500,
    height: 700,
    title: "SoundWave — Вход в SoundCloud",
    backgroundColor: "#121212",
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  authWindow.once("ready-to-show", () => {
    authWindow?.show();
  });

  authWindow.on("closed", () => {
    authWindow = null;
  });

  if (VITE_DEV_SERVER_URL) {
    authWindow.loadURL(`${VITE_DEV_SERVER_URL}#/auth`);
  } else {
    authWindow.loadFile(path.join(DIST, "index.html"), {
      hash: "/auth",
    });
  }

  log.info("Окно авторизации создано");
}

/**
 * Окно ручного импорта cookies.
 * Пользователь открывает soundcloud.com у себя в браузере (или через расширение
 * вроде EditThisCookie / Cookie-Editor), копирует cookie-строку и вставляет сюда.
 */
function createManualAuthWindow() {
  if (authWindow) {
    authWindow.focus();
    return;
  }
  authWindow = new BrowserWindow({
    width: 520,
    height: 640,
    title: "SoundWave — Ручной вход",
    backgroundColor: "#121212",
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  authWindow.once("ready-to-show", () => authWindow?.show());
  authWindow.on("closed", () => {
    authWindow = null;
  });

  if (VITE_DEV_SERVER_URL) {
    authWindow.loadURL(`${VITE_DEV_SERVER_URL}#/auth/manual`);
  } else {
    authWindow.loadFile(path.join(DIST, "index.html"), { hash: "/auth/manual" });
  }
}

function createTray() {
  // Иконка трея — создаём программно оранжевый круг
  const iconSize = 16;
  const canvas = nativeImage.createEmpty();
  
  // Простая иконка: оранжевый круг
  const trayIcon = nativeImage.createFromBuffer(
    Buffer.from(
      `iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA
      GXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyJpVFh0WE1MOmNvbS5hZG9iZS54
      bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlk
      Ij8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhN
      UCBDb3JlIDUuMy1jMDExIDY2LjE0NTY2MSwgMjAxMi8wMi8wNi0xNDo1NjoyNyAgICAgICAgIj4g
      PHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50
      Yy1jZWMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIi8+IDwvcmRmOlJERj4gPC94Onht
      cG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz6qKp3zAAAASklEQVR42mL8//8/AyWYgQETIP7//39G
      Dg4OBg4ODgZOTk4GTk5OBi4uLgZubu4/+Pj4GPj5+Rn4+fkZ+Pj4GPj5+Rn4+PgY+Pn5Gfj5+Rn4
      +fkZ+Pn5Gfj5+Rn+AUDpFxkMAHqsGAAAAABJRU5ErkJggg==`,
      "base64"
    )
  );

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "🎵 SoundWave",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Воспроизвести / Пауза",
      click: () => mainWindow?.webContents.send("tray-play-pause"),
    },
    {
      label: "Следующий трек",
      click: () => mainWindow?.webContents.send("tray-next"),
    },
    {
      label: "Предыдущий трек",
      click: () => mainWindow?.webContents.send("tray-prev"),
    },
    { type: "separator" },
    {
      label: "Показать SoundWave",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: "Выйти",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("SoundWave");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function registerGlobalShortcuts() {
  // Глобальный хоткей play/pause
  globalShortcut.register("MediaPlayPause", () => {
    mainWindow?.webContents.send("media-play-pause");
  });

  globalShortcut.register("MediaNextTrack", () => {
    mainWindow?.webContents.send("media-next");
  });

  globalShortcut.register("MediaPreviousTrack", () => {
    mainWindow?.webContents.send("media-prev");
  });

  // Также Space когда окно в фокусе
  log.info("Глобальные горячие клавиши зарегистрированы");
}

/**
 * Разбирает ручной ввод cookies в трёх форматах:
 * 1. Строка заголовка:  "oauth_token=abc; tz=Europe/Moscow"
 * 2. JSON из расширения Cookie-Editor: [{name, value}, ...]
 * 3. Netscape / JSON из EditThisCookie: {"oauth_token":{"value":"..."}} и т.п.
 */
function parseCookieInput(
  raw: string,
): { cookieHeader: string; count: number } | null {
  const text = (raw || "").trim();
  if (!text) return null;

  // JSON
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const pairs: Array<[string, string]> = [];

      const push = (item: any) => {
        if (!item || typeof item !== "object") return;
        const name = item.name ?? item.key;
        const value = item.value;
        if (typeof name === "string" && value != null) {
          pairs.push([name, String(value)]);
        }
      };

      if (Array.isArray(data)) {
        data.forEach(push);
      } else if (Array.isArray(data.cookies)) {
        data.cookies.forEach((c: any) => {
          if (Array.isArray(c)) pairs.push([String(c[0]), String(c[1])]);
          else push(c);
        });
      } else {
        Object.entries(data).forEach(([k, v]) => {
          if (v && typeof v === "object") push({ name: k, value: (v as any).value });
          else pairs.push([k, String(v)]);
        });
      }

      if (pairs.length) {
        return {
          cookieHeader: pairs.map(([k, v]) => `${k}=${v}`).join("; "),
          count: pairs.length,
        };
      }
    } catch {
      // не JSON — пойдём как строка
    }
  }

  // Netscape cookies.txt: строки через табуляцию, имя в 6-й колонке, значение в 7-й
  if (/^#?\s*(HttpOnly_)?\.?soundcloud\.com\t/m.test(text) || text.includes("\t")) {
    const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    const pairs: string[] = [];
    for (const line of lines) {
      const cols = line.split("\t");
      if (cols.length >= 7) pairs.push(`${cols[5]}=${cols[6]}`);
    }
    if (pairs.length) return { cookieHeader: pairs.join("; "), count: pairs.length };
  }

  // Обычная строка заголовка Cookie
  if (text.includes("=")) {
    const cleaned = text.replace(/^cookie:\s*/i, "").replace(/\r?\n/g, "; ");
    const pairs = cleaned
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.includes("="));
    if (pairs.length) return { cookieHeader: pairs.join("; "), count: pairs.length };
  }

  return null;
}

function setupIPC() {  // Получить сохранённые настройки
  ipcMain.handle("get-config", () => {
    return {
      theme: store.get("theme"),
      volume: store.get("volume"),
      loggedIn: store.get("loggedIn"),
    };
  });

  // Сохранить тему
  ipcMain.handle("set-theme", (_event, theme: string) => {
    store.set("theme", theme);
    return true;
  });

  // Сохранить громкость
  ipcMain.handle("set-volume", (_event, volume: number) => {
    store.set("volume", volume);
    return true;
  });

  // Открыть окно авторизации
  ipcMain.handle("open-auth-window", () => {
    if (!authWindow) {
      createAuthWindow();
    } else {
      authWindow.focus();
    }
    return true;
  });

  // Закрыть окно авторизации и сообщить результат
  ipcMain.handle("close-auth-window", (_event, cookies: string) => {
    // Специальный сигнал: пользователь хочет открыть настоящую страницу SoundCloud
    if (cookies === "open-real-login") {
      authWindow?.close();
      authWindow = null;
      openRealLoginWindow(mainWindow);
      return true;
    }

    store.set("scCookies", cookies);
    store.set("loggedIn", true);
    authWindow?.close();
    authWindow = null;
    mainWindow?.webContents.send("auth-success", cookies);
    log.info("Авторизация завершена");
    return true;
  });

  // Прямой вход: сразу открыть настоящую страницу SoundCloud
  ipcMain.handle("open-real-login", () => {
    openRealLoginWindow(mainWindow);
    return true;
  });

  // Ручной вход: окно для вставки cookie-строки
  ipcMain.handle("open-manual-login", () => {
    createManualAuthWindow();
    return true;
  });

  // Текущий session cookie главного окна (чтобы показать, что реально есть)
  ipcMain.handle("dump-session-cookies", async () => {
    const ses = mainWindow?.webContents.session ?? session.defaultSession;
    const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });
    if (!cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  });

  // После рестарта — отдать сохранённые cookies в рендерер
  ipcMain.handle("restore-session", () => {
    const cookies = store.get("scCookies") as string | null;
    const loggedIn = store.get("loggedIn") as boolean;
    if (loggedIn && cookies) {
      mainWindow?.webContents.send("auth-success", cookies);
    }
    return { loggedIn, cookies: cookies || "" };
  });

  // Ручной импорт cookies: строка вида "key=value; key2=value2" или JSON-экспорт
  ipcMain.handle("import-cookies", (_event, raw: string) => {
    const parsed = parseCookieInput(raw);
    if (!parsed) {
      return { ok: false, error: "Не удалось распознать cookies" };
    }
    store.set("scCookies", parsed.cookieHeader);
    store.set("loggedIn", true);
    mainWindow?.webContents.send("auth-success", parsed.cookieHeader);
    authWindow?.close();
    authWindow = null;
    log.info(`Ручной вход: импортировано ${parsed.count} cookies`);
    return { ok: true, count: parsed.count };
  });

  ipcMain.handle("get-cookies", () => store.get("scCookies") || "");

  // Проверить статус входа
  ipcMain.handle("check-login", () => {
    return store.get("loggedIn");
  });

  // Закрыть окно авторизации и сообщить результат
  ipcMain.handle("logout", () => {
    store.set("loggedIn", false);
    store.set("scCookies", null);
    // Чистим cookie сессии SoundCloud, чтобы «Выйти» действительно разлогинивал
    try {
      session.defaultSession.clearStorageData({ storages: ["cookies"] });
    } catch (e) {
      log.warn("Не удалось очистить cookies", e);
    }
    mainWindow?.webContents.send("logged-out");
    return true;
  });

  // Показать/скрыть окно
  ipcMain.handle("show-window", () => {
    mainWindow?.show();
    mainWindow?.focus();
    return true;
  });

  // Минимизировать в трей
  ipcMain.handle("minimize-to-tray", () => {
    mainWindow?.hide();
    return true;
  });

  log.info("IPC handlers зарегистрированы");
}

// App events
app.whenReady().then(() => {
  log.info("Приложение готово");
  createWindow();
  createTray();
  registerGlobalShortcuts();
  setupIPC();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  log.info("Приложение закрывается");
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

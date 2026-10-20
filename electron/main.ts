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

// Раздел сессии, где живут cookies SoundCloud.
// Главное окно и окно входа используют один и тот же раздел — поэтому
// вход, сделанный в окне входа, сразу виден главному окну.
const SC_PARTITION = "persist:soundcloud";

// Внутренний API веб-версии SoundCloud
const API_V2 = "https://api-v2.soundcloud.com";

// SoundCloud отдаёт 401 на запросы без нормального User-Agent
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * client_id SoundCloud — публичный идентификатор веб-клиента.
 * Он периодически меняется, поэтому вытаскиваем его из JS-бандлов soundcloud.com
 * и кешируем на время работы приложения.
 */
let clientId: string | null = null;
let clientIdPromise: Promise<string> | null = null;

async function getClientId(): Promise<string> {
  if (clientId) return clientId;

  if (!clientIdPromise) {
    clientIdPromise = (async () => {
      const html = await fetch("https://soundcloud.com/", {
        headers: { "User-Agent": BROWSER_UA },
      }).then((r) => r.text());

      const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);

      for (const src of scripts.slice(0, 15)) {
        try {
          const js = await fetch(src, { headers: { "User-Agent": BROWSER_UA } }).then((r) => r.text());
          const match =
            js.match(/"client_id":"([A-Za-z0-9]{32})"/) ||
            js.match(/client_id[=:]"?([A-Za-z0-9]{32})"/) ||
            js.match(/"client_id":"([^"]{8,64})"/);
          if (match) {
            clientId = match[1];
            log.info(`client_id SoundCloud получен`);
            return clientId;
          }
        } catch {
          continue;
        }
      }

      const inHtml = html.match(/"client_id":"([A-Za-z0-9]{32})"/);
      if (inHtml) {
        clientId = inHtml[1];
        return clientId;
      }

      throw new Error("Не удалось получить client_id SoundCloud");
    })().catch((e) => {
      clientIdPromise = null;
      throw e;
    });
  }

  return clientIdPromise;
}

/** Текущие cookies сессии SoundCloud одной строкой — для заголовка Cookie. */
async function getCookieHeader(): Promise<string> {
  try {
    const ses = session.fromPartition(SC_PARTITION);
    const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });
    if (!cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    log.warn("Не удалось прочитать cookies сессии", e);
    return "";
  }
}

/**
 * OAuth-токен из cookies сессии.
 *
 * Важный нюанс: внутренний API SoundCloud (api-v2) принимает авторизацию
 * только через заголовок `Authorization: OAuth <access_token>`.
 * Одной cookie-шапки мало: `/me` отдаёт 401, а приватные коллекции — 404.
 */
async function getAccessToken(): Promise<string | null> {
  try {
    const ses = session.fromPartition(SC_PARTITION);
    const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });
    return cookies.find((c) => c.name === "oauth_token")?.value ?? null;
  } catch (e) {
    log.warn("Не удалось прочитать access token", e);
    return null;
  }
}

/** Есть ли активная сессия SoundCloud (в разделе уже лежит access token). */
async function hasActiveSession(): Promise<boolean> {
  return Boolean(await getAccessToken());
}

/**
 * Токен, который был в сессии до открытия настоящей страницы входа.
 * Нужен, чтобы отличить успешный вход от мгновенного редиректа
 * уже авторизованного пользователя (signin -> /discover).
 */
let tokenBeforeLogin: string | null = null;

/**
 * fetch с повторами для коротких сетевых сбоев.
 *
 * При старте приложения первые запросы к SoundCloud иногда падают
 * с «fetch failed» (ECONNRESET при установке соединения) — один-два
 * повтора это лечат, и главная не остаётся пустой.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }

  throw lastError;
}

/**
 * Заголовки для запросов к SoundCloud из main-процесса.
 * Там нет CORS-ограничений, и Cookie можно передавать свободно.
 *
 * Плюс OAuth-токен: без него приватные коллекции пользователя
 * (лайки, подписки, плейлисты) недоступны.
 */
async function apiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    Referer: "https://soundcloud.com/",
  };

  const token = await getAccessToken();
  if (token) headers.Authorization = `OAuth ${token}`;

  const cookie = await getCookieHeader();
  if (cookie) headers.Cookie = cookie;

  return headers;
}

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
      partition: SC_PARTITION,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    log.info("Главное окно показано");
  });

  // Если рендерер всё-таки упал, окно иначе останется чёрным без объяснений
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error("Рендерер упал:", details.reason, details.exitCode);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
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
 * Окно входа — единственное дополнительное окно приложения (вместе с главным).
 *
 * Внутри него два пути, и оба живут в этом же окне:
 *  1) настоящая страница soundcloud.com/signin — пароль вводится на самом SoundCloud;
 *  2) ручной импорт cookies из браузера.
 *
 * Никаких третьих окон приложение не создаёт.
 */

/** Загружает в окно наш собственный интерфейс по маршруту (hash). */
function loadAppRoute(win: BrowserWindow, hash: string) {
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(`${VITE_DEV_SERVER_URL}#${hash}`);
  } else {
    win.loadFile(path.join(DIST, "index.html"), { hash });
  }
}

/** Создаёт окно входа (или возвращает уже открытое). */
function createAuthWindow(hash = "/auth"): BrowserWindow {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return authWindow;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 700,
    title: "SoundWave — Вход в SoundCloud",
    backgroundColor: "#121212",
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Общий с главным окном раздел сессии: вход виден обоим сразу
      partition: SC_PARTITION,
    },
  });

  authWindow.once("ready-to-show", () => authWindow?.show());
  authWindow.on("closed", () => {
    log.info("Окно входа закрыто");
    authWindow = null;
  });

  // После успешного входа SoundCloud уводит на /discover, /you или /
  // В этот момент забираем cookies сессии.
  const onNavigate = (_event: Electron.Event, url: string) => {
    void handleLoginNavigation(url);
  };
  authWindow.webContents.on("did-navigate", onNavigate);
  authWindow.webContents.on("did-navigate-in-page", onNavigate);

  loadAppRoute(authWindow, hash);
  log.info("Окно входа создано");

  return authWindow;
}

/** Пользователь ушёл со страницы входа — значит вход выполнен. */
async function handleLoginNavigation(url: string) {
  if (!/^https:\/\/(www\.)?soundcloud\.com\//i.test(url)) return;
  if (/\/(signin|signup|forgot-password|reset-password)/i.test(url)) return;

  const tokenNow = await getAccessToken();

  // Токен не изменился — это не вход, а редирект уже авторизованного
  // пользователя (signin -> /discover). Окно не закрываем: даём выйти из
  // аккаунта прямо на странице SoundCloud.
  if (!tokenNow || tokenNow === tokenBeforeLogin) {
    log.info("Сессия SoundCloud уже активна — ждём подтверждения входа");
    return;
  }

  // Даём SoundCloud время выставить cookies
  setTimeout(() => void finishLogin(), 900);
}

/** Забирает cookies сессии и сообщает главному окну об успешном входе. */
async function finishLogin() {
  if (!authWindow || authWindow.isDestroyed()) return;

  const ses = session.fromPartition(SC_PARTITION);
  const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });
  const hasToken = cookies.some((c) => c.name === "oauth_token");

  if (!hasToken) {
    log.info("Вход пока не подтверждён — ждём cookies");
    return;
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  store.set("scCookies", cookieHeader);
  store.set("loggedIn", true);

  mainWindow?.webContents.send("auth-success", cookieHeader);
  authWindow.close();
  authWindow = null;
  mainWindow?.show();
  mainWindow?.focus();
  log.info("Вход выполнен, cookies сессии получены");
}

/** Переключает окно входа на наш собственный маршрут (hash). */
function navigateAuthWindow(hash: string) {
  const win = createAuthWindow(hash);
  const current = win.webContents.getURL();
  const isOurApp =
    current.startsWith("file://") || (VITE_DEV_SERVER_URL ? current.startsWith(VITE_DEV_SERVER_URL) : false);

  if (isOurApp) {
    win.webContents
      .executeJavaScript(`window.location.hash = ${JSON.stringify(hash)}`)
      .catch(() => loadAppRoute(win, hash));
  } else {
    loadAppRoute(win, hash);
  }

  return true;
}

/** Открывает настоящую страницу входа SoundCloud в том же окне. */
async function startSoundCloudLogin() {
  const win = createAuthWindow("/auth");

  // Запоминаем токен до входа: после успешного входа он изменится,
  // а при редиректе уже авторизованного пользователя останется прежним.
  tokenBeforeLogin = await getAccessToken();

  win.loadURL("https://soundcloud.com/signin");
  return true;
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

  // Окно входа — единственное дополнительное окно приложения
  ipcMain.handle("open-auth-window", () => {
    return navigateAuthWindow("/auth");
  });

  // Вход через настоящую страницу soundcloud.com/signin (в том же окне)
  ipcMain.handle("open-real-login", () => {
    return startSoundCloudLogin();
  });

  // Ручной вход: тот же экран, но во вкладке с вводом cookies
  ipcMain.handle("open-manual-login", () => {
    return navigateAuthWindow("/auth/manual");
  });

  // Вернуться к выбору способа входа (из страницы SoundCloud)
  ipcMain.handle("show-auth-choice", () => {
    log.info("IPC: show-auth-choice");
    return navigateAuthWindow("/auth");
  });

  // Закрыть окно входа
  ipcMain.handle("close-login-window", () => {
    log.info("IPC: close-login-window");
    authWindow?.close();
    authWindow = null;
    return true;
  });

  /**
   * Прокси к внутреннему API SoundCloud.
   * Запросы идут из main-процесса: там нет CORS-ограничений и можно передать Cookie,
   * который браузер в renderer обрезает как запрещённый заголовок.
   */
  ipcMain.handle(
    "sc-request",
    async (_event, path: string, params: Record<string, string | number> = {}) => {
      const id = await getClientId();

      const url = path.startsWith("http")
        ? new URL(path)
        : new URL(`${API_V2}${path.startsWith("/") ? path : `/${path}`}`);

      if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", id);
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, String(value));
      }

      const res = await fetchWithRetry(url.toString(), { headers: await apiHeaders() });
      const text = await res.text();

      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "SoundCloud требует входа в аккаунт"
            : `SoundCloud API вернул ошибку ${res.status} (${url.pathname})`,
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  );

  // Прямая ссылка на аудио: трек -> манифест -> файл на CDN
  ipcMain.handle("sc-resolve-stream", async (_event, trackId: number) => {
    const id = await getClientId();
    const headers = await apiHeaders();

    const trackRes = await fetchWithRetry(`${API_V2}/tracks/${trackId}?client_id=${id}`, { headers });
    if (!trackRes.ok) throw new Error(`SoundCloud API вернул ошибку ${trackRes.status}`);

    const track = await trackRes.json();
    const transcodings: Array<{
      url: string;
      format?: { protocol?: string; mime_type?: string };
    }> = track?.media?.transcodings ?? [];

    // SoundCloud отдаёт потоки в HLS. Выбираем fMP4 (audio/mp4) — такие
    // сегменты MediaSource в Chromium понимает, а MPEG-TS (audio/mpegurl)
    // через MSE не воспроизводится.
    const chosen =
      transcodings.find((t) => t.format?.protocol === "progressive") ??
      transcodings.find((t) => (t.format?.mime_type ?? "").includes("mp4")) ??
      transcodings.find((t) => t.format?.protocol === "hls") ??
      transcodings[0];

    if (!chosen) {
      throw new Error("У трека нет доступных потоков");
    }

    const manifestUrl = `${chosen.url}${chosen.url.includes("?") ? "&" : "?"}client_id=${id}`;
    const manifestRes = await fetchWithRetry(manifestUrl, { headers });
    if (!manifestRes.ok) throw new Error(`Поток недоступен (${manifestRes.status})`);

    const manifest = await manifestRes.json();
    if (!manifest?.url) throw new Error("SoundCloud не вернул ссылку на аудио");

    return {
      url: manifest.url,
      protocol: chosen.format?.protocol ?? "progressive",
      duration: track.duration ?? 0,
    };
  });

  // client_id — нужен рендереру для построения ссылок
  ipcMain.handle("get-client-id", () => getClientId());

  // Текущие cookies сессии (чтобы показать, что реально есть)
  ipcMain.handle("dump-session-cookies", async () => {
    return getCookieHeader();
  });

  // После рестарта — проверяем, жила ли сессия в разделе persist:soundcloud
  ipcMain.handle("restore-session", async () => {
    const cookies = await session.fromPartition(SC_PARTITION).cookies.get({ domain: ".soundcloud.com" });
    const hasToken = cookies.some((c) => c.name === "oauth_token");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const loggedIn = hasToken && Boolean(cookieHeader);

    if (loggedIn) {
      store.set("loggedIn", true);
      store.set("scCookies", cookieHeader);
      mainWindow?.webContents.send("auth-success", cookieHeader);
    } else {
      store.set("loggedIn", false);
      store.set("scCookies", null);
    }

    return { loggedIn, cookies: loggedIn ? cookieHeader : "" };
  });

  // Ручной импорт cookies: строка вида "key=value; key2=value2" или JSON-экспорт
  ipcMain.handle("import-cookies", async (_event, raw: string) => {
    const parsed = parseCookieInput(raw);
    if (!parsed) {
      return { ok: false, error: "Не удалось распознать cookies" };
    }

    const ses = session.fromPartition(SC_PARTITION);
    const pairs = parsed.cookieHeader
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.includes("="));

    let count = 0;
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;

      try {
        await ses.cookies.set({
          url: "https://soundcloud.com",
          name,
          value,
          domain: ".soundcloud.com",
          path: "/",
          secure: true,
          sameSite: "no_restriction",
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        });
        count++;
      } catch (e) {
        log.warn(`Cookie ${name} не записан`, e);
      }
    }

    if (!count) {
      return { ok: false, error: "Cookies не удалось записать в сессию" };
    }

    // Проверяем, что SoundCloud принял сессию
    try {
      const id = await getClientId();
      const check = await fetch(`${API_V2}/me?client_id=${id}`, { headers: await apiHeaders() });
      if (check.status === 401) {
        return { ok: false, error: "SoundCloud не принял эти cookies — нужен полный набор из браузера" };
      }
    } catch (e) {
      log.warn("Не удалось проверить cookies", e);
    }

    const cookieHeader = await getCookieHeader();
    store.set("scCookies", cookieHeader);
    store.set("loggedIn", true);
    mainWindow?.webContents.send("auth-success", cookieHeader);
    authWindow?.close();
    authWindow = null;
    log.info(`Ручной вход: импортировано ${count} cookies`);
    return { ok: true, count };
  });

  ipcMain.handle("get-cookies", () => store.get("scCookies") || "");

  // Проверить статус входа
  ipcMain.handle("check-login", () => {
    return store.get("loggedIn");
  });

  // Есть ли живая сессия SoundCloud (нужна для экрана «Вы уже вошли»)
  ipcMain.handle("has-session", async () => {
    return hasActiveSession();
  });

  // Выход: чистим cookies именно нашего раздела сессии
  ipcMain.handle("logout", async () => {
    store.set("loggedIn", false);
    store.set("scCookies", null);
    try {
      const ses = session.fromPartition(SC_PARTITION);
      await ses.clearStorageData({ storages: ["cookies"] });
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

// Только первый экземпляр создаёт главное окно.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    log.info("Приложение готово");
    createWindow();
    createTray();
    registerGlobalShortcuts();
    setupIPC();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!hasSingleInstanceLock) return;
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

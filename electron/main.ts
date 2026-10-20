import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  session,
  shell,
} from "electron";
import path from "path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import Store from "electron-store";
import log from "electron-log";
import { AgentApiHandle, startAgentApi } from "./agent-api";
import { DiscordRpc } from "./discord-rpc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform === "win32") {
  // Без AppUserModelID Windows иногда показывает пустую иконку в трее
  // и не группирует окна приложения на панели задач.
  app.setAppUserModelId("com.c4elovek.soundwave");
}

/** Путь к ресурсу: в dev — из папки проекта, в сборке — из resources. */
function resourcePath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, "..", "resources", name);
}

function appIconPath(): string {
  return resourcePath(process.platform === "win32" ? "icon.ico" : "icon.png");
}

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
    agentApiPort: 4783,
    agentApiToken: "",
    agentApiEnabled: true,
    customFonts: [] as StoredFont[],
    discordEnabled: false,
    discordClientId: "",
    discordLargeImage: "",
  },
});

/** Токен локального API создаётся один раз и хранится в конфиге. */
function getAgentToken(): string {
  let token = String(store.get("agentApiToken") ?? "");
  if (!token) {
    token = randomBytes(24).toString("hex");
    store.set("agentApiToken", token);
  }
  return token;
}

/* ==================== Свои шрифты ==================== */

const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];
const FONT_MIME: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

interface StoredFont {
  id: string;
  name: string;
  family: string;
  file: string;
}

function fontsDir(): string {
  return path.join(app.getPath("userData"), "fonts");
}

function listStoredFonts(): StoredFont[] {
  return (store.get("customFonts") as StoredFont[]) ?? [];
}

/** Готовая запись шрифта: метаданные + data-URL, который понимает FontFace. */
function fontEntry(font: StoredFont) {
  const ext = path.extname(font.file).slice(1).toLowerCase();
  const mime = FONT_MIME[ext] ?? "application/octet-stream";

  try {
    const data = readFileSync(path.join(fontsDir(), font.file));
    return {
      ...font,
      mime,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
    };
  } catch {
    return null;
  }
}

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentApiHandle: AgentApiHandle | null = null;
const discord = new DiscordRpc();
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

/* ==================== Тексты песен (Genius) ==================== */

/**
 * У Genius нет публичного API для текстов: официальный api.genius.com
 * отдаёт только метаданные, а сам текст лежит на странице песни.
 * Поэтому ищем через открытый эндпоинт поиска и разбираем HTML.
 */
const GENIUS_ORIGIN = "https://genius.com";
const GENIUS_TIMEOUT = 12_000;
const GENIUS_CACHE_TTL = 6 * 60 * 60 * 1000;
const GENIUS_CACHE_LIMIT = 200;

const GENIUS_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
  Referer: "https://genius.com/",
};

// Аккаунты переводов и романизаций — это не оригинальный текст песни.
const GENIUS_TRANSLATION_MARKERS = [
  "translation",
  "translations",
  "romanization",
  "romanizations",
  "перевод",
  "переклад",
  "çeviri",
  "traducción",
  "tradução",
  "übersetzung",
  "překlad",
];

interface GeniusLyricsResult {
  found: boolean;
  title?: string;
  artist?: string;
  url?: string;
  lyrics?: string;
  error?: string;
}

const geniusCache = new Map<string, { value: GeniusLyricsResult; at: number }>();

/** Приводит название и имя артиста к сравнимому виду. */
function normalizeGeniusText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Декодирует HTML-сущности, которые Genius использует в текстах. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Вырезает блоки `<div data-lyrics-container="true">…</div>`.
 *
 * Простой регуляркой это не сделать: внутри контейнера бывают вложенные
 * div (заголовок с авторами и описанием). Поэтому идём по HTML и считаем
 * открывающие/закрывающие теги, чтобы найти парный `</div>`.
 */
function extractGeniusLyrics(html: string): string {
  const marker = 'data-lyrics-container="true"';
  const chunks: string[] = [];
  let from = 0;

  while (true) {
    const start = html.indexOf(marker, from);
    if (start === -1) break;

    const tagStart = html.lastIndexOf("<div", start);
    if (tagStart === -1) break;

    let depth = 0;
    let i = tagStart;
    let end = -1;

    while (i < html.length) {
      const open = html.indexOf("<div", i);
      const close = html.indexOf("</div>", i);
      if (close === -1) break;

      if (open !== -1 && open < close) {
        depth++;
        i = open + 4;
      } else {
        depth--;
        i = close + 6;
        if (depth === 0) {
          end = close + 6;
          break;
        }
      }
    }

    if (end === -1) break;
    chunks.push(html.slice(tagStart, end));
    from = end;
  }

  let text = chunks
    .join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  text = decodeHtmlEntities(text);

  // Перед текстом Genius печатает «N Contributors… Read More».
  // Отрезаем служебную шапку до первой секции [Intro] / [Куплет] / [Chorus].
  const firstSection = text.search(/^[ \t]*\[[^\]\n]+\][ \t]*$/m);
  if (firstSection > 0) {
    text = text.slice(firstSection);
  } else {
    // Если секций нет, хотя бы убираем шапку до «Read More».
    const readMore = text.indexOf("Read More");
    if (readMore !== -1 && readMore < 800) {
      const lineEnd = text.indexOf("\n", readMore);
      if (lineEnd !== -1) text = text.slice(lineEnd + 1);
    }
  }

  return text
    .replace(/^[ \t]*You might also like[ \t]*$/gim, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Насколько результат поиска похож на нужный трек. */
function scoreGeniusSong(song: any, title: string, artist: string): number {
  const wantTitle = normalizeGeniusText(title);
  const wantArtist = normalizeGeniusText(artist);
  const songTitle = normalizeGeniusText(song?.title);
  const songArtist = normalizeGeniusText(song?.primary_artist?.name);

  if (!songTitle || !songArtist) return -100;

  const isTranslation =
    songArtist.startsWith("genius ") &&
    GENIUS_TRANSLATION_MARKERS.some((marker) => songArtist.includes(marker));
  if (isTranslation && songArtist !== wantArtist) return -100;

  let score = 0;

  if (songTitle === wantTitle) {
    score += 10;
  } else if (songTitle.includes(wantTitle) || wantTitle.includes(songTitle)) {
    score += 6;
  } else {
    // Названия в SoundCloud часто содержат лишние приписки — сравниваем по словам.
    const words = wantTitle.split(" ").filter((word) => word.length > 1);
    if (words.length > 0) {
      const matched = words.filter((word) => songTitle.includes(word)).length;
      score += (matched / words.length) * 3;
    }
  }

  if (wantArtist && songArtist) {
    if (songArtist === wantArtist) {
      score += 8;
    } else if (songArtist.includes(wantArtist) || wantArtist.includes(songArtist)) {
      score += 4;
    }
  }

  return score;
}

async function fetchGenius(url: string, asJson: boolean): Promise<any> {
  const res = await fetch(url, {
    headers: {
      ...GENIUS_HEADERS,
      Accept: asJson ? "application/json" : "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(GENIUS_TIMEOUT),
  });

  if (!res.ok) throw new Error(`Genius ответил ${res.status}`);
  return asJson ? res.json() : res.text();
}

/** Ищет песню на Genius и достаёт из её страницы текст. */
async function findGeniusLyrics(title: string, artist: string): Promise<GeniusLyricsResult> {
  const query = `${title} ${artist}`.trim();
  const search = await fetchGenius(
    `${GENIUS_ORIGIN}/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`,
    true
  );

  const rawHits: any[] = (search?.response?.sections ?? []).flatMap(
    (section: any) => section?.hits ?? []
  );

  // Genius иногда отдаёт один и тот же результат дважды.
  const seen = new Set<number | string>();
  const songs = rawHits
    .map((hit) => hit?.result)
    .filter((song) => song && song.url && song.title)
    .filter((song) => {
      const key = song.id ?? song.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const ranked = songs
    .map((song) => ({ song, score: scoreGeniusSong(song, title, artist) }))
    .sort((a, b) => b.score - a.score);

  // Слишком слабые совпадения пропускаем: лучше честное «не найдено»,
  // чем текст совсем другой песни.
  for (const { song, score } of ranked.slice(0, 3)) {
    if (score < 4) continue;

    try {
      const html = await fetchGenius(song.url, false);
      const lyrics = extractGeniusLyrics(html);
      if (lyrics.length >= 80) {
        return {
          found: true,
          title: song.title,
          artist: song.primary_artist?.name ?? artist,
          url: song.url,
          lyrics,
        };
      }
    } catch (e) {
      log.warn(`Genius: не удалось открыть ${song.url}`, e);
    }
  }

  return { found: false };
}

/** Кэш на 6 часов: тексты не меняются, а Genius не любит частые запросы. */
async function getGeniusLyrics(title: string, artist: string): Promise<GeniusLyricsResult> {
  const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  const cached = geniusCache.get(key);

  if (cached && Date.now() - cached.at < GENIUS_CACHE_TTL) {
    return cached.value;
  }

  let result: GeniusLyricsResult;

  try {
    result = await findGeniusLyrics(title, artist);
  } catch (e) {
    log.warn("Genius: поиск не удался", e);
    // Ошибку сети не кэшируем — при следующем открытии попробуем снова.
    return {
      found: false,
      error: e instanceof Error ? e.message : "Не удалось обратиться к Genius",
    };
  }

  geniusCache.set(key, { value: result, at: Date.now() });

  while (geniusCache.size > GENIUS_CACHE_LIMIT) {
    const oldest = geniusCache.keys().next().value;
    if (oldest === undefined) break;
    geniusCache.delete(oldest);
  }

  return result;
}

/* ==================== Синхронизация текста (LRCLIB) ==================== */

/**
 * Genius не отдаёт тайминги строк. Для караоке берём их из LRCLIB —
 * открытого каталога LRC-текстов. Если там ничего нет, панель
 * раскладывает строки по длительности трека сама.
 */
const LRCLIB_API = "https://lrclib.net/api/search";
const LRCLIB_UA = "SoundWave/0.1 (https://github.com/c4elovek-cmd/SoundWave)";
const LRCLIB_TIMEOUT = 10_000;
const LRCLIB_CACHE_TTL = 6 * 60 * 60 * 1000;
const LRCLIB_CACHE_LIMIT = 200;

interface SyncedLyricsResult {
  found: boolean;
  syncedLyrics?: string;
  title?: string;
  artist?: string;
  duration?: number;
  error?: string;
}

const lrclibCache = new Map<string, { value: SyncedLyricsResult; at: number }>();

function scoreLrcTrack(entry: any, title: string, artist: string, durationMs: number): number {
  const wantTitle = normalizeGeniusText(title);
  const wantArtist = normalizeGeniusText(artist);
  const trackTitle = normalizeGeniusText(entry?.trackName);
  const trackArtist = normalizeGeniusText(entry?.artistName);

  if (!trackTitle) return -100;

  let score = 0;

  if (trackTitle === wantTitle) {
    score += 10;
  } else if (trackTitle.includes(wantTitle) || wantTitle.includes(trackTitle)) {
    score += 6;
  } else {
    const words = wantTitle.split(" ").filter((word) => word.length > 1);
    if (words.length > 0) {
      const matched = words.filter((word) => trackTitle.includes(word)).length;
      score += (matched / words.length) * 3;
    }
  }

  if (wantArtist && trackArtist) {
    if (trackArtist === wantArtist) {
      score += 8;
    } else if (trackArtist.includes(wantArtist) || wantArtist.includes(trackArtist)) {
      score += 4;
    }
  }

  // Длительность помогает выбрать нужную версию среди ремиксов.
  if (durationMs > 0 && entry?.duration) {
    const diff = Math.abs(entry.duration * 1000 - durationMs);
    if (diff <= 3000) score += 4;
    else if (diff <= 10_000) score += 2;
    else if (diff > 45_000) score -= 3;
  }

  return score;
}

async function getSyncedLyrics(
  title: string,
  artist: string,
  durationMs: number
): Promise<SyncedLyricsResult> {
  const cacheKey = `${title.toLowerCase()}|${artist.toLowerCase()}|${Math.round(durationMs / 1000)}`;
  const cached = lrclibCache.get(cacheKey);

  if (cached && Date.now() - cached.at < LRCLIB_CACHE_TTL) {
    return cached.value;
  }

  let result: SyncedLyricsResult;

  try {
    const url =
      `${LRCLIB_API}?track_name=${encodeURIComponent(title)}` +
      `&artist_name=${encodeURIComponent(artist)}`;

    const res = await fetch(url, {
      headers: { "User-Agent": LRCLIB_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(LRCLIB_TIMEOUT),
    });

    if (!res.ok) throw new Error(`LRCLIB ответил ${res.status}`);

    const list = await res.json();
    if (!Array.isArray(list)) throw new Error("LRCLIB вернул неожиданный ответ");

    const candidates = list
      .filter((entry) => entry && typeof entry.syncedLyrics === "string")
      .filter((entry) => entry.syncedLyrics.trim().length > 20)
      .map((entry) => ({
        entry,
        score: scoreLrcTrack(entry, title, artist, durationMs),
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];

    if (best && best.score >= 6) {
      result = {
        found: true,
        syncedLyrics: best.entry.syncedLyrics,
        title: best.entry.trackName,
        artist: best.entry.artistName,
        duration: best.entry.duration,
      };
    } else {
      result = { found: false };
    }
  } catch (e) {
    log.warn("LRCLIB: не удалось получить синхронизацию", e);
    // Ошибку не кэшируем: при следующем включении караоке попробуем снова.
    return {
      found: false,
      error: e instanceof Error ? e.message : "Не удалось обратиться к LRCLIB",
    };
  }

  lrclibCache.set(cacheKey, { value: result, at: Date.now() });

  while (lrclibCache.size > LRCLIB_CACHE_LIMIT) {
    const oldest = lrclibCache.keys().next().value;
    if (oldest === undefined) break;
    lrclibCache.delete(oldest);
  }

  return result;
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

/** Поднимает локальный API для агентов, если он включён в настройках. */
async function startAgentApiIfEnabled(): Promise<void> {
  if (!store.get("agentApiEnabled")) {
    log.info("Agent API выключен в настройках");
    return;
  }

  try {
    agentApiHandle = await startAgentApi({
      getWindow: () => mainWindow,
      port: Number(store.get("agentApiPort") ?? 4783),
      token: getAgentToken(),
    });
  } catch (error) {
    log.error("Agent API не запустился:", error);
  }
}

/** Перезапускает API — после смены порта, токена или включения. */
async function restartAgentApi(): Promise<void> {
  agentApiHandle?.close();
  agentApiHandle = null;
  await startAgentApiIfEnabled();
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
    icon: appIconPath(),
    autoHideMenuBar: true,
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

  // Полноэкранный режим: сообщаем рендереру, чтобы он мог закрыть караоке
  // или восстановить окно, если пользователь вышел через Esc.
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("app-fullscreen-changed", true);
  });

  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("app-fullscreen-changed", false);
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
    icon: appIconPath(),
    autoHideMenuBar: true,
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
  // Иконка берётся из resources: ICO содержит размеры 16–256 px,
  // поэтому Windows сам выбирает нужный вариант для панели задач.
  const iconPath = appIconPath();

  if (!existsSync(iconPath)) {
    log.warn("Иконка трея не найдена:", iconPath);
    return;
  }

  try {
    tray = new Tray(iconPath);
  } catch (e) {
    log.error("Не удалось создать иконку трея:", e);
    return;
  }

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
      version: app.getVersion(),
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

  // Текст песни с Genius: официального API у них нет, поэтому ищем
  // через публичный поиск и разбираем страницу.
  ipcMain.handle(
    "genius-lyrics",
    async (_event, payload: { title?: string; artist?: string }) => {
      const title = String(payload?.title ?? "").trim();
      const artist = String(payload?.artist ?? "").trim();

      if (!title) return { found: false, error: "Не указано название трека" };
      return getGeniusLyrics(title, artist);
    }
  );

  // Тайминги строк для караоке — из открытого каталога LRCLIB.
  ipcMain.handle(
    "synced-lyrics",
    async (_event, payload: { title?: string; artist?: string; duration?: number }) => {
      const title = String(payload?.title ?? "").trim();
      const artist = String(payload?.artist ?? "").trim();
      const duration = Number(payload?.duration ?? 0) || 0;

      if (!title) return { found: false };
      return getSyncedLyrics(title, artist, duration);
    }
  );

  // Внешние ссылки открываем в системном браузере, а не в новом окне Electron.
  // Разрешаем только https и только Genius — мало ли что придёт из рендерера.
  ipcMain.handle("open-external", async (_event, rawUrl: string) => {
    try {
      const url = new URL(String(rawUrl));
      if (url.protocol !== "https:") return false;
      if (!/(^|\.)genius\.com$/i.test(url.hostname)) return false;
      await shell.openExternal(url.toString());
      return true;
    } catch {
      return false;
    }
  });

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

  // Полноэкранный режим окна — для караоке на весь экран
  ipcMain.handle("set-fullscreen", (_event, value: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(Boolean(value));
    return mainWindow.isFullScreen();
  });

  /* ==================== Свои шрифты ==================== */

  ipcMain.handle("fonts-list", () => {
    return listStoredFonts()
      .map((font) => fontEntry(font))
      .filter((font): font is NonNullable<typeof font> => Boolean(font));
  });

  ipcMain.handle("fonts-import", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Выберите файл шрифта",
      properties: ["openFile"],
      filters: [{ name: "Шрифты", extensions: FONT_EXTENSIONS }],
    };

    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) return null;

    const source = result.filePaths[0];
    const ext = path.extname(source).slice(1).toLowerCase();
    if (!FONT_EXTENSIONS.includes(ext)) return null;

    const base = path.basename(source, path.extname(source));
    const id = randomBytes(6).toString("hex");
    const file = `${id}-${base.replace(/[^\w.-]+/g, "_")}.${ext}`;

    mkdirSync(fontsDir(), { recursive: true });
    copyFileSync(source, path.join(fontsDir(), file));

    const font: StoredFont = { id, name: base, family: `SWFont${id}`, file };
    store.set("customFonts", [
      ...listStoredFonts().filter((item) => item.id !== id),
      font,
    ]);

    return fontEntry(font);
  });

  ipcMain.handle("fonts-remove", (_event, id: string) => {
    const fonts = listStoredFonts();
    const font = fonts.find((item) => item.id === id);
    if (!font) return false;

    try {
      unlinkSync(path.join(fontsDir(), font.file));
    } catch {
      // Файла уже нет — не страшно.
    }

    store.set("customFonts", fonts.filter((item) => item.id !== id));
    return true;
  });

  /* ==================== Discord Rich Presence ==================== */

  ipcMain.handle("discord-status", () => ({
    enabled: Boolean(store.get("discordEnabled")),
    clientId: String(store.get("discordClientId") ?? ""),
    largeImage: String(store.get("discordLargeImage") ?? ""),
    connected: discord.isConnected,
  }));

  ipcMain.handle(
    "discord-config",
    async (
      _event,
      payload?: { enabled?: boolean; clientId?: string; largeImage?: string }
    ) => {
      if (payload?.enabled !== undefined) {
        store.set("discordEnabled", Boolean(payload.enabled));
      }
      if (payload?.clientId !== undefined) {
        store.set("discordClientId", String(payload.clientId).trim());
      }
      if (payload?.largeImage !== undefined) {
        store.set("discordLargeImage", String(payload.largeImage).trim());
      }

      const enabled = Boolean(store.get("discordEnabled"));
      const clientId = String(store.get("discordClientId") ?? "");

      if (enabled && clientId) {
        await discord.connect(clientId);
      } else {
        discord.stop();
      }

      return {
        enabled,
        clientId,
        largeImage: String(store.get("discordLargeImage") ?? ""),
        connected: discord.isConnected,
      };
    }
  );

  ipcMain.handle(
    "discord-presence",
    (
      _event,
      presence?:
        | {
            details?: string;
            state?: string;
            largeText?: string;
            smallText?: string;
            startTimestamp?: number;
          }
        | null
    ) => {
      if (!store.get("discordEnabled")) return false;

      if (!presence) {
        discord.setActivity(null);
        return true;
      }

      discord.setActivity({
        details: presence.details,
        state: presence.state,
        largeText: presence.largeText,
        smallText: presence.smallText,
        largeImageKey: String(store.get("discordLargeImage") ?? "") || undefined,
        largeImageText: presence.largeText,
        startTimestamp: presence.startTimestamp,
      });

      return true;
    }
  );

  /* ==================== Настройки локального API ==================== */

  ipcMain.handle(
    "agent-api-config",
    async (
      _event,
      payload?: { enabled?: boolean; port?: number; regenerateToken?: boolean }
    ) => {
      if (payload?.enabled !== undefined) {
        store.set("agentApiEnabled", Boolean(payload.enabled));
      }

      if (payload?.port !== undefined) {
        const port = Number(payload.port);
        if (Number.isFinite(port) && port > 1024 && port < 65536) {
          store.set("agentApiPort", Math.round(port));
        }
      }

      if (payload?.regenerateToken) {
        store.set("agentApiToken", randomBytes(24).toString("hex"));
      }

      await restartAgentApi();

      return {
        enabled: Boolean(store.get("agentApiEnabled")),
        port: Number(store.get("agentApiPort") ?? 4783),
        token: getAgentToken(),
        url: agentApiHandle?.url ?? null,
      };
    }
  );

  // Открыть папку с данными приложения
  ipcMain.handle("open-user-data", () => {
    void shell.openPath(app.getPath("userData"));
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
    // Убираем стандартное меню File / Edit / View / Window / Help.
    // Контекстное меню трея задаётся отдельно и продолжает работать.
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    registerGlobalShortcuts();
    setupIPC();

    // Локальный HTTP API для агентов. Порт по умолчанию 4783,
    // если занят — берётся следующий свободный.
    void startAgentApiIfEnabled();

    // Discord Rich Presence — если включён и задан Client ID.
    if (store.get("discordEnabled")) {
      const clientId = String(store.get("discordClientId") ?? "");
      if (clientId) void discord.connect(clientId);
    }
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
  agentApiHandle?.close();
  agentApiHandle = null;
  discord.stop();
  globalShortcut.unregisterAll();
  log.info("Приложение закрывается");
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

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
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import os from "os";
import Store from "electron-store";
import log from "electron-log";
import { autoUpdater } from "electron-updater";
import { AgentApiHandle, startAgentApi } from "./agent-api";
import { DiscordRpc } from "./discord-rpc";
import {
  clearSessionCookies,
  importCookiesFromConfig,
  setConfigValue,
  watchSessionFile,
} from "./session-sync";

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
    scClientId: "",
    customFonts: [] as StoredFont[],
    discordEnabled: true,
    discordClientId: "",
    discordLargeImage: "",
  },
});

/**
 * Запись в настройки.
 *
 * Файл настроек общий с Rust-версией, поэтому перед записью подтягиваем
 * его свежее содержимое — иначе electron-store затрёт то, что изменила
 * другая версия (например, сессию после входа там).
 */
function setStore(key: string, value: unknown): void {
  setConfigValue(store, key, value);
}

/** Токен локального API создаётся один раз и хранится в конфиге. */
function getAgentToken(): string {
  let token = String(store.get("agentApiToken") ?? "");
  if (!token) {
    token = randomBytes(24).toString("hex");
    setStore("agentApiToken", token);
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
  /** Название файла для интерфейса, напр. Turret Road Bold */
  name: string;
  /** Название семейства, напр. Turret Road */
  display: string;
  /** CSS-семейство, напр. SWFontTurretRoad */
  family: string;
  file: string;
  /** Начертание 200–900 */
  weight: number;
}

/** Порядок важен: «ExtraBold» должен проверяться раньше «Bold». */
const FONT_WEIGHTS: [RegExp, number, string][] = [
  [/-?(extralight|ultralight)$/i, 200, "ExtraLight"],
  [/-?(extrabold|ultrabold)$/i, 800, "ExtraBold"],
  [/-?(semibold|demibold)$/i, 600, "SemiBold"],
  [/-?(black|heavy)$/i, 900, "Black"],
  [/-?light$/i, 300, "Light"],
  [/-?medium$/i, 500, "Medium"],
  [/-?bold$/i, 700, "Bold"],
  [/-?(regular|book|normal)$/i, 400, "Regular"],
];

/** Разбирает имя файла: семейство и начертание. */
function parseFontName(base: string): { display: string; weight: number; suffix: string } {
  for (const [re, weight, suffix] of FONT_WEIGHTS) {
    if (re.test(base)) {
      const display = base.replace(re, "").trim() || base;
      return { display, weight, suffix };
    }
  }

  return { display: base, weight: 400, suffix: "Regular" };
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

/**
 * Client ID приложения Discord «SoundWave».
 *
 * Rich Presence без зарегистрированного приложения не работает, поэтому
 * идентификатор вшит в сборку: пользователю не нужно ничего настраивать —
 * как в обычных клиентах. Свой Client ID можно указать в настройках.
 */
const DEFAULT_DISCORD_CLIENT_ID = "1562164443893211307";
const DEFAULT_DISCORD_ASSET = "soundwave";

/** Client ID для Discord: свой из настроек, иначе встроенный. */
function getDiscordClientId(): string {
  const custom = String(store.get("discordClientId") ?? "").trim();
  return custom || DEFAULT_DISCORD_CLIENT_ID;
}

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentApiHandle: AgentApiHandle | null = null;

/** Файл обновления уже скачан — можно ставить. */
let updateDownloaded = false;
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
 * и кешируем: в памяти на время работы и в конфиге между запусками.
 *
 * Кэш в конфиге важен: если soundcloud.com недоступен (или отдаёт таймаут),
 * приложение всё равно должно работать с уже известным идентификатором.
 */
let clientId: string | null = null;
let clientIdPromise: Promise<string> | null = null;

async function getClientId(): Promise<string> {
  if (clientId) return clientId;

  const saved = String(store.get("scClientId") ?? "");
  if (saved) clientId = saved;

  if (!clientIdPromise) {
    clientIdPromise = (async () => {
      const html = await fetch("https://soundcloud.com/", {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(12_000),
      }).then((r) => r.text());

      const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);

      for (const src of scripts.slice(0, 15)) {
        try {
          const js = await fetch(src, {
            headers: { "User-Agent": BROWSER_UA },
            signal: AbortSignal.timeout(12_000),
          }).then((r) => r.text());
          const match =
            js.match(/"client_id":"([A-Za-z0-9]{32})"/) ||
            js.match(/client_id[=:]"?([A-Za-z0-9]{32})"/) ||
            js.match(/"client_id":"([^"]{8,64})"/);
          if (match) {
            clientId = match[1];
            setStore("scClientId", clientId);
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
        setStore("scClientId", clientId);
        return clientId;
      }

      throw new Error("Не удалось получить client_id SoundCloud");
    })().catch((e) => {
      clientIdPromise = null;

      // Сайт недоступен — берём идентификатор из прошлого раза.
      const savedId = String(store.get("scClientId") ?? "");
      if (savedId) {
        log.warn("client_id не удалось обновить, берём сохранённый");
        clientId = savedId;
        return savedId;
      }

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
 * Мягкий лимитер запросов к SoundCloud: не больше трёх одновременных и
 * не чаще одного запроса в 150 мс. Так клиент не выглядит для API
 * агрессивным и не упирается в серверные ограничения.
 */
const SC_MAX_PARALLEL = 3;
const SC_MIN_INTERVAL = 150;

let scInFlight = 0;
let scLastRequest = 0;
const scQueue: (() => void)[] = [];

function withScThrottle<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      const wait = Math.max(0, scLastRequest + SC_MIN_INTERVAL - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      scLastRequest = Date.now();
      scInFlight += 1;

      try {
        resolve(await task());
      } catch (e) {
        reject(e);
      } finally {
        scInFlight -= 1;
        scQueue.shift()?.();
      }
    };

    if (scInFlight < SC_MAX_PARALLEL) void run();
    else scQueue.push(() => void run());
  });
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
  /** Откуда взят текст: Genius или запасной LRCLIB. */
  source?: "genius" | "lrclib";
  /**
   * Трек — версия с изменённым темпом (speed up, slowed и т. п.).
   *
   * Тайминги оригинала не подходят: строки караоке разъезжаются со звуком.
   * Флаг говорит интерфейсу не включать караоке.
   */
  tempoModified?: boolean;
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

/**
 * Приписки, которыми перезаливают трек с изменённым темпом или частотой.
 *
 * Для таких версий караоке бессмысленно: LRC ищется по оригиналу, у
 * которого другая длительность, и строки разъезжаются со звуком. Текст
 * при этом ищем как обычно — он нужен.
 */
const TEMPO_MARK_RE =
  /\s*[([{]\s*(?:speed\s*up|sped\s*up|speedup|slowed(?:\s+(?:and|&|n)\s*reverb|\s+down|\s*\+)?|ultra\s+slowed|super\s+slowed|daycore|nightcore|reverb|bass\s+boost(?:ed)?|8d|\d+(?:\.\d+)?x|\d+\s*%)\s*[)\]}]|\s*\b(?:speed\s*up|sped\s*up|speedup|slowed|nightcore|daycore)\b/gi;

/** Трек — переработанная версия (speed up, slowed, reverb и т. п.). */
function isTempoModified(title: string): boolean {
  TEMPO_MARK_RE.lastIndex = 0;
  return TEMPO_MARK_RE.test(title);
}

const VERSION_MARKERS = [
  "remix", "mix", "edit", "version", "live", "bootleg", "acoustic",
  "instrumental", "radio", "extended", "slowed", "sped", "reverb",
  "nightcore", "boosted", "cover", "acapella", "mashup", "flip",
];

function versionMarkers(title: string): string[] {
  const lowered = title.toLowerCase();
  return VERSION_MARKERS.filter((m) => lowered.includes(m));
}

function versionMarkersCompatible(wantTitle: string, trackTitle: string): boolean {
  const want = versionMarkers(wantTitle);
  if (want.length === 0) return true;
  const track = versionMarkers(trackTitle);
  return want.every((m) => track.includes(m));
}

/** Название без приписок про темп и частоту. */
function stripTempoMarks(title: string): string {
  return title
    .replace(TEMPO_MARK_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[-–—_]+|[-–—_]+$/g, "")
    .trim();
}

/**
 * Два слова отличаются не больше чем на одну опечатку.
 *
 * Перезаливы часто содержат опечатки в названии («Офицантка» вместо
 * «Официантка»), и строгое сравнение такие треки не находит. Допускаем
 * одну вставку, удаление или замену символа — но только для слов от пяти
 * букв, иначе «дом» и «дым» станут одним словом.
 */
function wordsSimilar(a: string, b: string): boolean {
  return oneTypoApart(a, b, 5);
}

/**
 * Одна опечатка в слове имени артиста.
 *
 * В названиях перезаливов имя исполнителя часто искажено: «ondra adar -
 * cachalot.mp3» вместо «ONDA ANDAR — cachalot». Короткие псевдонимы — это
 * обычно четыре буквы, и порог в пять букв такое имя не ловит. Послабление
 * действует только для имён: в названиях оно склеивало бы разные песни.
 */
function artistWordSimilar(a: string, b: string): boolean {
  return oneTypoApart(a, b, 4);
}

/**
 * Слова отличаются не больше чем на одну вставку, удаление или замену.
 *
 * `minShort` — минимальная длина более короткого слова: короткие слова
 * сравниваем строго, иначе «дом» и «дым» станут одним словом.
 */
function oneTypoApart(a: string, b: string, minShort: number): boolean {
  if (a === b) return true;

  const left = [...a];
  const right = [...b];
  const [long, short] = left.length >= right.length ? [left, right] : [right, left];

  if (short.length < minShort || long.length - short.length > 1) return false;

  let prev = Array.from({ length: short.length + 1 }, (_, i) => i);
  let current = new Array<number>(short.length + 1).fill(0);

  for (let i = 0; i < long.length; i++) {
    current[0] = i + 1;
    let rowMin = current[0];

    for (let j = 0; j < short.length; j++) {
      const cost = long[i] === short[j] ? 0 : 1;
      current[j + 1] = Math.min(prev[j] + cost, prev[j + 1] + 1, current[j] + 1);
      rowMin = Math.min(rowMin, current[j + 1]);
    }

    if (rowMin > 1) return false;
    [prev, current] = [current, prev];
  }

  return prev[short.length] <= 1;
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

/**
 * Убирает из названия приписки, которыми перезаливают треки:
 * «(prod. by X)», «[2024]», «{edit}», «remix» и прочее.
 */
function cleanTitle(title: string): string {
  return title
    .replace(/\([^()]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    // Расширение файла в названии: «cachalot.mp3» на Genius зовётся
    // «cachalot», и с расширением поиск не находит ничего.
    .replace(/\.(mp3|wav|m4a|flac|ogg|aac|opus|webm)\b/gi, " ")
    .replace(/\bprod\.?\s*by\b.*$/i, " ")
    .replace(/\bmix\b.*$/i, " ")
    .replace(/[|_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Кириллица в латиницу: страницы Genius часто озаглавлены транслитерацией
 * («Красавица» → «Krasavitsa», «Гуляю» → «Gulyayu»), и без такого варианта
 * русское название не совпадает ни с чем. Схема близка к той, которой
 * пользуется Genius: ц → ts, ч → ch, ш → sh, щ → shch, х → kh, ю → yu,
 * я → ya; твёрдый и мягкий знаки отбрасываются.
 */
function translitRu(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
    ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e",
    ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
  };

  let result = "";
  let changed = false;

  for (const ch of value) {
    const lower = ch.toLowerCase();
    const mapped = map[lower];
    if (mapped === undefined) {
      result += ch;
    } else {
      changed = true;
      result += mapped;
    }
  }

  return changed ? result : value;
}

/** Число 0..999 словами: «4» → «четыре», «30» → «тридцать». */
function spellNumberRu(part: string): string | null {
  const units = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const teens = [
    "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
    "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
  ];
  const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

  if (!/^\d{1,3}$/.test(part)) return null;
  const value = Number(part);
  const out: string[] = [];
  const h = Math.floor(value / 100);
  const rest = value % 100;
  if (h > 0) out.push(hundreds[h]);
  if (rest >= 10 && rest < 20) {
    out.push(teens[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    if (t > 0) out.push(tens[t]);
    if (u > 0 || out.length === 0) out.push(units[u]);
  }
  return out.join(" ");
}

/**
 * «4.30», «4:30», «4-30» → «четыре тридцать»; одиночное число — тоже.
 *
 * Название-число не совпадает с записанным словами («4 30» против «четыре
 * тридцать») ни по одному слову, поэтому запись оригинала («Четыре тридцать»
 * Violetta Sokolova для ремикса «4.30 (hardstyle remix)») не находилась вовсе.
 */
function spelledNumberVariant(title: string): string | null {
  const normalized = normalizeGeniusText(title);
  const parts: string[] = [];

  for (const word of normalized.split(" ")) {
    if (/^\d+$/.test(word)) {
      parts.push(word);
      if (parts.length === 2) break;
    } else {
      break;
    }
  }

  if (parts.length === 0) return null;

  const words: string[] = [];
  for (const part of parts) {
    const spelled = spellNumberRu(part);
    if (spelled === null) return null;
    words.push(spelled);
  }

  const spelled = words.join(" ");
  const digits = parts.join(" ");
  return spelled === digits ? null : spelled;
}

/** Та же песня, если название записи — это число из нашего названия словами. */
function numeralEquivalent(wantTitle: string, trackTitle: string): boolean {
  const spelled = spelledNumberVariant(wantTitle);
  if (spelled === null) return false;
  const track = normalizeGeniusText(trackTitle);
  // Только точное совпадение: префикс «восемь» из «8 миля» не должен ловить
  // чужую «Восемь миля», а скобочные дополнения нормализация срезает.
  return track.length > 0 && track === spelled;
}

/** Варианты названия: исходное, очищенное, часть после тире и без хвоста. */
function titleVariants(title: string): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 1) variants.add(trimmed);
  };

  add(title);

  const cleaned = cleanTitle(title);
  add(cleaned);

  // «Артист - Песня»: песня обычно после тире.
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length > 1) {
    add(parts[parts.length - 1]);
    add(parts[0]);
  }

  // Хвост вроде «remix», «prod», «live», «bootleg».
  add(
    cleaned
      .replace(/\s*\b(remix|prod|edit|version|live|bootleg|mix|demo)\b.*$/i, "")
      .trim()
  );

  // «(speed up)», «slowed + reverb» и подобное: версия другого трека,
  // текст тот же, а приписка только мешает поиску.
  const withoutTempo = stripTempoMarks(cleaned) || cleaned;
  add(withoutTempo);

  const strippedParts = withoutTempo.split(/\s+[-–—]\s+/);
  if (strippedParts.length > 1) {
    add(strippedParts[strippedParts.length - 1]);
    add(strippedParts[0]);
  }

  // Слэш и хвостовые метки: «RANE/ШИПЫ ONDA ANDAR #2016» на LRCLIB лежит
  // как «RANE — ONDA ANDAR», и целиком такое название не находится.
  const noTags = withoutTempo.replace(/(?:^|\s)#\S+/g, " ").replace(/\s{2,}/g, " ").trim();
  add(noTags);

  for (const piece of noTags.split(/\s*\/\s*/)) {
    add(piece.trim());
  }

  // Каждое слово отдельно: по названию из одного слова LRCLIB и Genius
  // ищут гораздо лучше, чем по склейке из нескольких.
  for (const piece of noTags.split(/\s*\/\s*/)) {
    for (const word of piece.split(/\s+/)) {
      if (word.replace(/[^\p{L}\p{N}]/gu, "").length >= 4) add(word);
    }
  }

  // «4.30» → «четыре тридцать»: на LRCLIB и Genius такие песни лежат под
  // названием словами, и без этого варианта оригинал не находится вовсе.
  const spelled = spelledNumberVariant(title);
  if (spelled !== null) add(spelled);

  // Транслитерация кириллицы: «Anguish - Красавица» на Genius лежит как
  // «ANGUISH — Krasavitsa (Remix)». Вариант добавляем в конец, чтобы он не
  // отнимал место у обычных запросов.
  for (const value of [...variants]) {
    if (/[^\x00-\x7F]/.test(value) && /\p{L}/u.test(value)) {
      add(translitRu(value));
    }
  }

  return [...variants];
}

/** Варианты имени артиста: без скобок и приписок вроде «[second acc]». */
function artistVariants(artist: string): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    // Звёздочки, точки и прочие заглушки («*») артистом не считаем:
    // с ними LRCLIB не находит ничего.
    const hasLetters = /[\p{L}\p{N}]/u.test(trimmed);
    if (trimmed.length > 1 && hasLetters) variants.add(trimmed);
  };

  add(artist);
  add(artist.replace(/\([^()]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s{2,}/g, " ").trim());

  return [...variants];
}

/**
 * Исполнитель, названный прямо в названии трека: «RANE/ШИПЫ ONDA ANDAR
 * #2016» → «шипы onda andar», «Песня - Артист» → «артист». Нужно, чтобы
 * короткий запрос вроде «RANE» не подхватывал чужую песню с тем же словом,
 * но другим исполнителем (Genius по слову «RANE» отдаёт «Rane — Anastasija»).
 * Работает по сырому названию: разделители «/» и «-» нормализация уже
 * убрала бы.
 */
/**
 * Слова, которые в теге артиста отделяют одного исполнителя от другого.
 */
const ARTIST_JOIN_WORDS = ["feat", "ft", "featuring", "x", "х", "і", "и", "and", "with"];

/**
 * Отдельные исполнители внутри тега: «k0vertessence; B4YLUm» → два имени.
 *
 * Нормализация стирает запятые и амперсанды, поэтому делим по сырой строке.
 * «city» в «Gorgon City» остаётся частью имени: это не второй исполнитель,
 * и «gorgon» не должен считаться совпадением с «gorgon city».
 */
function artistParts(artist: string): string[] {
  const text = String(artist ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ");

  const parts: string[] = [];

  for (const chunk of text.split(/[,;&/+|·×]/)) {
    let current: string[] = [];

    for (const raw of chunk.split(/\s+/)) {
      const word = normalizeGeniusText(raw);
      if (!word) continue;

      if (ARTIST_JOIN_WORDS.includes(word)) {
        if (current.length > 0) {
          parts.push(current.join(" "));
          current = [];
        }
      } else {
        current.push(word);
      }
    }

    if (current.length > 0) parts.push(current.join(" "));
  }

  return parts;
}

/**
 * Совпадают ли имена исполнителей.
 *
 * Сравнение строгое: «gorgon» и «gorgon city» — разные артисты, хотя одно
 * имя целиком входит в другое. Совпадением считаем:
 *  * полностью одинаковые имена;
 *  * общего участника коллаборации («k0vertessence» ↔ «k0vertessence; B4YLUm»);
 *  * одну опечатку при одинаковом числе слов.
 */
function artistNamesMatch(left: string, right: string): boolean {
  const leftNorm = normalizeGeniusText(left);
  const rightNorm = normalizeGeniusText(right);

  if (!leftNorm || !rightNorm) return false;
  if (leftNorm === rightNorm) return true;

  const leftParts = artistParts(left);
  const rightParts = artistParts(right);

  if (leftParts.some((a) => rightParts.includes(a))) return true;

  // Одна опечатка в имени. Число слов должно совпадать: иначе «gorgon»
  // и «gorgon city» прошли бы как опечатка.
  const sameWords = (a: string, b: string) => {
    const aWords = a.split(" ").filter(Boolean);
    const bWords = b.split(" ").filter(Boolean);
    return (
      aWords.length === bWords.length &&
      aWords.every((word, index) => wordsSimilar(word, bWords[index]))
    );
  };

  return (
    sameWords(leftNorm, rightNorm) ||
    leftParts.some((a) => rightParts.some((b) => sameWords(a, b)))
  );
}

function artistFromTitle(title: string): string | null {
  const text = (title ?? "").trim();
  if (!text) return null;

  // Часть после слэша: коллабы и перезаливы часто пишут так.
  const slashParts = text.split("/");
  if (slashParts.length > 1) {
    const cleaned = normalizeGeniusText(
      cleanTitle(stripTempoMarks(slashParts[1].replace(/(?:^|\s)#\S+/g, " ")))
    );
    if (cleaned.length >= 4) return cleaned;
  }

  // Часть после последнего тире: «Песня - Артист» или «Артист - Песня».
  const dashParts = text.split("-");
  if (dashParts.length > 1) {
    const cleaned = normalizeGeniusText(
      cleanTitle(stripTempoMarks(dashParts[dashParts.length - 1]))
    );
    if (
      cleaned.length >= 4 &&
      !cleaned.split(" ").some((w) => w === "feat" || w === "ft")
    ) {
      return cleaned;
    }
  }

  return null;
}

/**
 * Кандидаты названия из описания трека.
 *
 * В выгрузках часто пишут оригинальную песню: «I Want (Original Song)», «Lyrics: …»
 * или просто первая строка. По ним можно найти текст, даже если перезалитое
 * название на Genius не встречается.
 */
function titleCandidatesFromDescription(description: string | undefined): string[] {
  if (!description) return [];

  const text = description.trim();
  if (!text || text.length > 800) return [];

  const result = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim().replace(/^["'«]|["'»]$/g, "");
    if (trimmed.length > 2 && trimmed.length < 120) result.add(trimmed);
  };

  // Текст в кавычках: «I Want» — Original Song
  for (const match of text.matchAll(/["'«]([^"'»\n]{2,80})["'»]/g)) add(match[1]);

  // Строки вида «Original song: …» / «Оригинал: …»
  for (const match of text.matchAll(
    /(?:original|оригинал|source|lyrics|текст|слова)\s*[:\-—]\s*([^\n]{2,80})/gi
  )) {
    add(match[1]);
  }

  // Первая строка описания, если она короткая и похожа на название
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine && firstLine.length <= 80 && !/[.!?]/.test(firstLine.slice(0, 40))) {
    add(firstLine);
  }

  return [...result].slice(0, 4);
}

/** Насколько результат поиска похож на нужный трек. */
function scoreGeniusSong(
  song: any,
  titles: string[],
  artists: string[]
): number {
  const rawSongArtist = String(song?.primary_artist?.name ?? "");
  const songTitle = normalizeGeniusText(song?.title);
  const songArtist = normalizeGeniusText(rawSongArtist);

  if (!songTitle || !songArtist) return -100;

  const wantTitles = titles.map(normalizeGeniusText).filter(Boolean);
  const wantArtists = artists.map(normalizeGeniusText).filter(Boolean);

  // Исполнитель, названный в самом названии трека («RANE/ШИПЫ ONDA ANDAR
  // #2016» → «шипы onda andar»). Если Genius вернул другого артиста —
  // короткое совпадение названия (одно слово) нельзя считать уверенным,
  // иначе «RANE» подхватывает чужую «Rane — Anastasija».
  const titleArtist = normalizeGeniusText(artistFromTitle(titles[0] ?? "") ?? "");
  const artistConsistent = !titleArtist || artistNamesMatch(rawSongArtist, titleArtist);

  // Исполнитель записи совпал с кем-то из известных нам имён (тег трека
  // или его вариант). Это главный признак, что песня та же.
  const artistMatched = artists.some((wantArtist) =>
    artistNamesMatch(rawSongArtist, wantArtist)
  );

  const isTranslation =
    songArtist.startsWith("genius ") &&
    GENIUS_TRANSLATION_MARKERS.some((marker) => songArtist.includes(marker));
  if (isTranslation && !wantArtists.includes(songArtist)) return -100;

  // Оценка названия. Короткие названия вроде «I WANT» не считаем совпадением
  // по «входит в» — иначе подставляется совсем другая песня.
  const titleScore = (wantTitle: string): number => {
    if (!wantTitle) return 0;
    if (songTitle === wantTitle) return 10;

    const words = wantTitle.split(" ").filter((word) => word.length > 2);
    if (words.length === 0 || wantTitle.length < 5) return 0;

    // Название из одного слова («Официантка»): сравниваем с любым словом в
    // названии на Genius — там бывает и перевод в скобках. Поправка на
    // опечатку нужна: в перезаливах название часто искажено.
    if (words.length === 1) {
      const songWords = songTitle.split(" ");
      return songWords.some((word) => wordsSimilar(word, words[0])) ? 6 : 0;
    }

    if (wantTitle.length < 8) return 0;

    if (songTitle.includes(wantTitle) || wantTitle.includes(songTitle)) return 6;

    // Сравниваем слова по отдельности: так ловятся опечатки в названии
    // («Офицантка» ↔ «Официантка») и лишние слова с одной стороны.
    const songWords = songTitle.split(" ").filter(Boolean);
    const matched = words.filter((word) =>
      songWords.some((songWord) => wordsSimilar(songWord, word))
    ).length;

    if (matched >= 2 && matched / words.length >= 0.5) {
      // Полное совпадение по словам (с точностью до опечатки) — почти
      // наверняка та же песня.
      if (matched === words.length && words.length >= 2) return 6;
      return 3;
    }

    return 0;
  };

  const artistScore = (wantArtist: string): number => {
    if (!wantArtist || !songArtist) return 0;
    if (normalizeGeniusText(wantArtist) === songArtist) return 8;
    if (artistNamesMatch(rawSongArtist, wantArtist)) return 4;
    return 0;
  };

  // Название и артист складываются: точное совпадение обоих — сильнее,
  // чем любого по отдельности. Раньше брался максимум, и чужая песня с
  // точным названием весила столько же, сколько верная пара «название +
  // артист», а при равном счёте побеждала та, что попалась раньше.
  // «4.30 (hardstyle remix)» и «Четыре тридцать (Four Thirty)» — одна
  // песня: число на Genius записано словами.
  const numeralEq = numeralEquivalent(titles[0] ?? "", song?.title);
  const titleBest = numeralEq
    ? 10
    : wantTitles.reduce((best, wantTitle) => Math.max(best, titleScore(wantTitle)), 0);
  const artistBest = artists.reduce(
    (best, wantArtist) => Math.max(best, artistScore(wantArtist)),
    0
  );
  let score = titleBest + artistBest;

  // Артист на Genius назван словами сырого названия SoundCloud-трека
  // («миномет нежеголь(The mortar)» → «Нежеголь (Nezhegol)»): сильный
  // признак, что запись правильная, ведь тег артиста часто содержит
  // ник загрузившего, а не настоящего исполнителя. Без этой поправки
  // чужая песня с тем же названием обгоняет верную.
  //
  // Бонус работает только когда название уже хоть как-то совпало. Иначе
  // «The Temptations — My Girl» проходила бы на трек с названием
  // «temptation»: имя группы похоже на слово из названия, а сама песня —
  // совсем другая.
  let artistNamedInTitle = false;
  {
    const rawTitle = normalizeGeniusText(titles[0] ?? "");
    const titleWords = rawTitle.split(" ").filter((word) => word.length >= 4);
    const artistWords = songArtist.split(" ").filter((word) => word.length >= 4);

    if (titleWords.length > 0 && artistWords.length > 0 && titleBest > 0) {
      const matched = artistWords.filter((artistWord) =>
        titleWords.some((titleWord) => artistWordSimilar(titleWord, artistWord))
      ).length;

      if (matched / artistWords.length >= 0.5) {
        score += 8;
        artistNamedInTitle = true;
      }
    }
  }

  // Название в треке называет исполнителя («…/… ONDA ANDAR»), а у записи
  // Genius — чужой. Короткое совпадение в одно слово («RANE») тогда не
  // должно давать «уверенный» балл: это другая песня. Жёстко режем ниже
  // порога приёма (4), чтобы такой результат не побеждал LRCLIB с верной
  // записью.
  if (!artistConsistent && score < 13) {
    score = Math.min(score, 3);
  }

  // Без совпадения артиста держаться можно только за сильное название.
  //  * Однословное «GLUTTONY» есть у десятков исполнителей, а «temptation»
  //    от Gorgon City — не «temptation» от gorgon. Даже точная длительность
  //    не делает такую запись верной.
  //  * Название покрывает половину слов трека или меньше — скорее всего,
  //    найдена другая песня с общим словом («Truth» внутри «truth yandere»).
  // Исключения — артист назван в названии трека: это обычные перезаливы,
  // где в теге загрузчика стоит ник, а настоящий исполнитель в названии.
  const artistConfident = artistMatched ||
    artistNamedInTitle ||
    numeralEq ||
    (Boolean(titleArtist) && artistConsistent);

  if (!artistConfident) {
    const rawTitle = normalizeGeniusText(titles[0] ?? "");
    const words = rawTitle.split(" ").filter((word) => word.length > 1);
    const singleWordTitle = words.length < 2;
    const coverage = words.length === 0
      ? 1
      : words.filter((word) => songTitle.includes(word)).length / words.length;

    if (singleWordTitle || coverage <= 0.5) {
      score = Math.min(score, 3);
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

/**
 * Ищет песню на Genius и достаёт из её страницы текст.
 *
 * Треки часто перезаливают: у копии другое название с приписками
 * («face - юморсrст (hardteek / hardstyle)»), поэтому ищем по нескольким
 * вариантам названия и имени артиста.
 */
async function findGeniusLyrics(
  title: string,
  artist: string,
  description?: string
): Promise<GeniusLyricsResult> {
  const titles = [...titleVariants(title), ...titleCandidatesFromDescription(description)];
  const artists = artistVariants(artist);

  const queries: string[] = [];
  const addQuery = (value: string) => {
    const query = value.trim();
    if (query && !queries.includes(query)) queries.push(query);
  };

  // Чередуем запросы с исполнителем и без него. Ник на SoundCloud часто не
  // совпадает с именем артиста на Genius («nsssive» вместо «Папин Олимпос»),
  // и запрос вместе с ним не находит вообще ничего. Раньше первые четыре
  // запроса были только с исполнителем — и поиск упирался в пустоту.
  for (const t of titles) {
    for (const a of artists) addQuery(`${t} ${a}`);
    addQuery(t);
  }

  const seen = new Set<number | string>();
  const songs: any[] = [];

  for (const query of queries.slice(0, 10)) {
    let search: any;
    try {
      search = await fetchGenius(
        `${GENIUS_ORIGIN}/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`,
        true
      );
    } catch (e) {
      log.warn(`Genius: поиск «${query}» не удался`, e);
      continue;
    }

    const rawHits: any[] = (search?.response?.sections ?? []).flatMap(
      (section: any) => section?.hits ?? []
    );

    for (const hit of rawHits) {
      const song = hit?.result;
      if (!song || !song.url || !song.title) continue;

      // Genius иногда отдаёт один и тот же результат дважды.
      const key = song.id ?? song.url;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(song);
    }

    // Если нашли уверенное совпадение — дальше не лезем.
    const best = songs
      .map((song) => ({ song, score: scoreGeniusSong(song, titles, artists) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 13) break;
  }

  const ranked = songs
    .map((song) => ({ song, score: scoreGeniusSong(song, titles, artists) }))
    .sort((a, b) => b.score - a.score);

  // Слишком слабые совпадения пропускаем: лучше честное «не найдено»,
  // чем текст совсем другой песни.
  for (const { song, score } of ranked.slice(0, 3)) {
    if (score < 5) continue;

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
async function getGeniusLyrics(
  title: string,
  artist: string,
  description?: string
): Promise<GeniusLyricsResult> {
  const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  const cached = geniusCache.get(key);

  if (cached && Date.now() - cached.at < GENIUS_CACHE_TTL) {
    return cached.value;
  }

  let result: GeniusLyricsResult;

  try {
    result = await findGeniusLyrics(title, artist, description);
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
const KARALYR_API = "https://karalyr.com/api/get";
const KARALYR_TIMEOUT = 10_000;
const LRCMUX_API = "https://api.lrcmux.dev/get";

/**
 * Есть ли в теле LRC хотя бы одна метка времени строки.
 *
 * Lrcmux умеет отдавать текст без таймингов: у песни просто нет разметки.
 * Такой ответ нельзя считать синхронизацией — разбор даёт ноль строк, и
 * караоке остаётся пустым, хотя текст найден.
 */
function hasLrcTimestamps(body: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    const m = /^\s*\[([^\]]*)\]/.exec(line);
    if (!m) return false;
    return m[1].includes(":") && /^[\d:.]+$/.test(m[1]);
  });
}

/** Снимает с LRC метки времени строк и слов — остаётся чистый текст. */
function stripLrcTimestamps(body: string): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const withoutLineTags = line.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
    const withoutWordTags = withoutLineTags.replace(/<[^>]*>/g, "");
    const cleaned = withoutWordTags.trim();
    if (cleaned) out.push(cleaned);
  }
  return out.join("\n");
}
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

/**
 * Артист записи LRCLIB совпадает с артистом трека или назван в названии.
 *
 * Название в названии — обычный случай перезалива: в теге артиста стоит ник
 * загрузившего («nsssive»), а настоящий исполнитель указан в самом названии.
 * Пустой артист трека ничего не говорит — тогда не мешаем выбирать по
 * названию и длительности.
 */
function lrcArtistMatches(entry: any, title: string, artist: string): boolean {
  const wantTitle = normalizeGeniusText(title);
  const wantArtist = normalizeGeniusText(artist);
  const rawTrackArtist = String(entry?.artistName ?? "");
  const trackArtist = normalizeGeniusText(rawTrackArtist);

  if (!wantArtist) return true;
  if (!trackArtist) return false;

  if (trackArtist.length >= 4 && wantTitle.includes(trackArtist)) return true;

  return artistNamesMatch(artist, rawTrackArtist);
}

/**
 * Доля слов искомого названия, которые есть в названии записи LRCLIB.
 *
 * «Truth» от Jaxomy покрывает лишь одно слово из «truth yandere^^ (ultra
 * slowed)» — это другая песня, даже если длительности случайно совпали.
 */
function lrcTitleCoverage(entry: any, title: string): number {
  const want = normalizeGeniusText(title);
  const track = normalizeGeniusText(entry?.trackName);
  const words = want.split(" ").filter((word) => word.length > 1);

  if (words.length === 0) return 0;

  const matched = words.filter((word) => track.includes(word)).length;
  return matched / words.length;
}

/** Разница длительности записи LRCLIB и трека в миллисекундах. */
function lrcDurationDiff(entry: any, durationMs: number): number {
  return typeof entry?.duration === "number"
    ? Math.abs(entry.duration * 1000 - durationMs)
    : Number.POSITIVE_INFINITY;
}

/**
 * Стоит ли заменить текущего кандидата LRCLIB этим.
 *
 * При равной оценке выбираем запись, ближайшую по длительности: на одну
 * песню на LRCLIB бывают и оригинал, и ускоренная версия, и по названию с
 * артистом они неотличимы — но ближайшая по времени точнее по структуре.
 */
function isBetterLrc(
  score: number,
  entry: any,
  best: { entry: any; score: number } | null,
  durationMs: number
): boolean {
  if (!best) return true;
  if (score > best.score) return true;
  return score === best.score && lrcDurationDiff(entry, durationMs) < lrcDurationDiff(best.entry, durationMs);
}

function scoreLrcTrack(entry: any, title: string, artist: string, durationMs: number): number {
  const wantTitle = normalizeGeniusText(title);
  const wantArtist = normalizeGeniusText(artist);
  const trackTitle = normalizeGeniusText(entry?.trackName);
  const rawTrackArtist = String(entry?.artistName ?? "");
  const trackArtist = normalizeGeniusText(rawTrackArtist);

  if (!trackTitle) return -100;

  let score = 0;

  // Число словами («4.30» и «Четыре тридцать») — то же название.
  const numeralEq = numeralEquivalent(title, String(entry?.trackName ?? ""));

  if (numeralEq || trackTitle === wantTitle) {
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

  // Артист записи назван в нашем названии трека — сильный признак, что это
  // та же песня. Нужен и когда артист трека известен: у перезаливов в теге
  // стоит ник загрузившего («nsssive»), а не настоящий исполнитель.
  if (trackArtist.length >= 4 && wantTitle.includes(trackArtist)) {
    score += 8;
  }

  if (wantArtist && trackArtist) {
    if (trackArtist === wantArtist) {
      score += 8;
    } else if (artistNamesMatch(artist, rawTrackArtist)) {
      // Коллаборация: у записи «k0vertessence; B4YLUm», у трека
      // «k0vertessence». Исполнитель тот же, просто тег полнее.
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

  // Чужой артист — доверять одному названию нельзя.
  //  * Название покрывает половину слов трека или меньше («Truth» внутри
  //    «truth yandere» после отбрасывания «(ultra slowed)») — это другая
  //    песня, даже если длительности совпали.
  //  * Однословное название вроде «Рассвет» слишком общее: без артиста
  //    верим только точной длительности.
  //  * Многословное и уникальное название («ВЫЗВАЛ ШЛЮХУ x mylancore»)
  //    пропускаем: перезаливы и ремиксы часто отличаются по длительности.
  const singleWordTitle = wantTitle.split(" ").filter(Boolean).length < 2;
  // Число словами — то же название, чужой артист записи его не перекрывает.
  if (!numeralEq && !lrcArtistMatches(entry, title, artist)) {
    const weakTitle = lrcTitleCoverage(entry, title) <= 0.5;

    // Однословное название («temptation», «Рассвет») без совпадения артиста
    // слишком общее: «gorgon — temptation» и «Gorgon City — Sweet
    // Temptation» — разные песни даже при точной длительности.
    if (weakTitle || singleWordTitle) score = Math.min(score, 3);
  }

  return score;
}

/**
 * Совпадает ли название записи LRCLIB с искомым.
 *
 * Отдельно от оценки: одной только близкой длительности и знакомого
 * исполнителя мало — иначе для «Официантка - Папин Олимпос» побеждала бы
 * любая другая песня того же артиста, лишь бы совпала по времени.
 */
function lrcTitleMatches(entry: any, title: string): boolean {
  const want = normalizeGeniusText(title);
  const track = normalizeGeniusText(entry?.trackName);

  if (!want || !track) return false;
  if (numeralEquivalent(title, entry?.trackName)) return true;
  if (track === want || track.includes(want) || want.includes(track)) return true;

  // Хотя бы одно слово названия должно найтись в названии записи:
  // «RANE» из «RANE/ШИПЫ ONDA ANDAR #2016» подходит, «СХИ» — нет.
  return want
    .split(" ")
    .filter((word) => word.length > 2)
    .some((word) => track.includes(word));
}

/**
 * Запасной источник текста — LRCLIB.
 *
 * Genius знает не всё: перезалитые треки часто там отсутствуют. LRCLIB
 * отдаёт текст без таймингов, но зато рядом с ним лежит и синхронизация —
 * поэтому караоке получается точным.
 */
async function getLrclibPlainLyrics(
  title: string,
  artist: string,
  durationMs = 0
): Promise<GeniusLyricsResult> {
  const cacheKey = `plain|${title.toLowerCase()}|${artist.toLowerCase()}|${Math.round(durationMs / 1000)}`;
  const cached = geniusCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GENIUS_CACHE_TTL) {
    return cached.value;
  }

  let result: GeniusLyricsResult;

  try {
    // Вариантов бывает много (слэш, отдельные слова) — по одному запросу на
    // каждый LRCLIB не любит, поэтому ограничиваемся самыми полезными.
    const titles = [title, ...titleVariants(title)].slice(0, 6);
    // Пустой артист — это поиск только по названию; так тоже ищем.
    const artists = [artist, ...artistVariants(artist), ""].slice(0, 3);

    let best: { entry: any; score: number } | null = null;

    for (const t of titles) {
      for (const a of artists) {
        const url = a
          ? `${LRCLIB_API}?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`
          : `${LRCLIB_API}?track_name=${encodeURIComponent(t)}`;

        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(LRCLIB_TIMEOUT),
        });

        if (!res.ok) continue;

        const list = await res.json();
        if (!Array.isArray(list)) continue;

        for (const entry of list) {
          if (!entry || typeof entry.plainLyrics !== "string") continue;
          if (entry.plainLyrics.trim().length < 40) continue;

          // Название должно хоть как-то совпасть: иначе при поиске по одному
          // слову («RANE») в выборку попадают десятки чужих песен, и
          // побеждает случайная с подходящей длительностью.
          if (!lrcTitleMatches(entry, title)) continue;

          // Оценка идёт по исходному названию, а не по варианту запроса:
          // иначе «RANE» из «RANE/ШИПЫ» засчиталось бы как точное
          // совпадение с чужой песней «Rane» другого исполнителя.
          const score = scoreLrcTrack(entry, title, artist, durationMs);
          if (isBetterLrc(score, entry, best, durationMs)) best = { entry, score };
        }

        if (best && best.score >= 18) break;
      }
      if (best && best.score >= 18) break;
    }

    // Fallback: Karalyr — LRCLIB-совместимый сервис.
    if (!best) {
      try {
        const url =
          `${KARALYR_API}?track_name=${encodeURIComponent(title)}` +
          `&artist_name=${encodeURIComponent(artist)}` +
          `&duration=${Math.round(durationMs / 1000)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(KARALYR_TIMEOUT),
        });
        if (res.ok) {
          const entry = await res.json();
          const plain = entry?.plainLyrics;
          if (typeof plain === "string" && plain.trim().length >= 40) {
            const trackName = String(entry.trackName ?? "");
            if (
              lrcTitleMatches(entry, title) &&
              versionMarkersCompatible(title, trackName) &&
              lrcArtistMatches(entry, title, artist)
            ) {
              best = { entry, score: 8 };
            }
          }
        }
      } catch (e) {
        log.warn("Karalyr: не удалось получить текст", e);
      }
    }

    // Fallback: Lrcmux — тот же агрегатор, что даёт караоке. Умеет отдавать и
    // обычный текст, когда на LRCLIB записи нет вовсе. Ищем по паре «артист +
    // название»: Lrcmux находит перезаливы, где в теге стоит ник загрузившего
    // («lightprey»), а на странице указан настоящий исполнитель.
    if (!best) {
      try {
        const url =
          `${LRCMUX_API}?artist=${encodeURIComponent(artist)}` +
          `&title=${encodeURIComponent(title)}&format=lrc`;
        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA },
          signal: AbortSignal.timeout(KARALYR_TIMEOUT),
        });
        if (res.ok) {
          const body = await res.text();
          const plain = stripLrcTimestamps(body);
          if (plain.trim().length >= 80) {
            best = {
              entry: {
                plainLyrics: plain,
                trackName: title,
                artistName: artist,
                duration: durationMs / 1000,
              },
              score: 8,
            };
          }
        }
      } catch (e) {
        log.warn("Lrcmux: не удалось получить текст", e);
      }
    }

    if (best && best.score >= 4) {
      result = {
        found: true,
        title: best.entry.trackName,
        artist: best.entry.artistName,
        url: `https://lrclib.net${best.entry.url ?? ""}`,
        lyrics: best.entry.plainLyrics,
        source: "lrclib",
      };
    } else {
      result = { found: false };
    }
  } catch (e) {
    log.warn("LRCLIB: не удалось получить текст", e);
    return { found: false };
  }

  geniusCache.set(cacheKey, { value: result, at: Date.now() });
  return result;
}

async function getSyncedLyrics(
  title: string,
  artist: string,
  durationMs: number
): Promise<SyncedLyricsResult> {
  // Для speed up / slowed версий караоке бессмысленно.
  if (isTempoModified(title)) {
    return { found: false };
  }

  const cacheKey = `${title.toLowerCase()}|${artist.toLowerCase()}|${Math.round(durationMs / 1000)}`;
  const cached = lrclibCache.get(cacheKey);

  if (cached && Date.now() - cached.at < LRCLIB_CACHE_TTL) {
    return cached.value;
  }

  let result: SyncedLyricsResult;

  try {
    // Перезалитый трек отличается приписками — пробуем и чистое название.
    const titles = [title, ...titleVariants(title)].slice(0, 3);
    const artists = [artist, ...artistVariants(artist)].slice(0, 2);

    let best: { entry: any; score: number } | null = null;

    for (const t of titles) {
      for (const a of artists) {
        const url =
          `${LRCLIB_API}?track_name=${encodeURIComponent(t)}` +
          `&artist_name=${encodeURIComponent(a)}`;

        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(LRCLIB_TIMEOUT),
        });

        if (!res.ok) continue;

        const list = await res.json();
        if (!Array.isArray(list)) continue;

        for (const entry of list) {
          if (!entry || typeof entry.syncedLyrics !== "string") continue;
          if (entry.syncedLyrics.trim().length <= 20) continue;

          // Та же проверка названия, что и для текста: иначе караоке
          // подхватит тайминги чужой песни того же исполнителя.
          if (!lrcTitleMatches(entry, title)) continue;

          // Ремикс/версия: если в названии трека есть маркер версии,
          // а у записи LRCLIB его нет — это другая песня. Исключение —
          // запись, узнанная по числу словами («4.30» и «Четыре тридцать»):
          // это точно тот же трек, только ремикс.
          const trackName = String(entry.trackName ?? "");
          if (
            !numeralEquivalent(title, trackName) &&
            !versionMarkersCompatible(title, trackName)
          ) {
            continue;
          }

          const score = scoreLrcTrack(entry, title, artist, durationMs);
          if (isBetterLrc(score, entry, best, durationMs)) best = { entry, score };
        }

        if (best && best.score >= 18) break;
      }
      if (best && best.score >= 18) break;
    }

    // Fallback: Karalyr — LRCLIB-совместимый сервис с word-synced караоке.
    if (!best) {
      try {
        const url =
          `${KARALYR_API}?track_name=${encodeURIComponent(title)}` +
          `&artist_name=${encodeURIComponent(artist)}` +
          `&duration=${Math.round(durationMs / 1000)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(KARALYR_TIMEOUT),
        });
        if (res.ok) {
          const entry = await res.json();
          const synced = entry?.syncedLyrics;
          if (typeof synced === "string" && synced.trim().length > 20) {
            const trackName = String(entry.trackName ?? "");
            if (
              lrcTitleMatches(entry, title) &&
              versionMarkersCompatible(title, trackName) &&
              lrcArtistMatches(entry, title, artist)
            ) {
              best = { entry, score: 8 };
            }
          }
        }
      } catch (e) {
        log.warn("Karalyr: не удалось получить синхронизацию", e);
      }
    }

    // Fallback: Lrcmux — агрегатор с word-level (Enhanced LRC) караоке.
    if (!best) {
      try {
        const url =
          `https://api.lrcmux.dev/get?artist=${encodeURIComponent(artist)}` +
          `&title=${encodeURIComponent(title)}` +
          `&format=lrc&level=word`;
        const res = await fetch(url, {
          headers: { "User-Agent": LRCLIB_UA },
          signal: AbortSignal.timeout(LRCLIB_TIMEOUT),
        });
        if (res.ok) {
          const body = await res.text();
          if (body.trim().length > 20 && hasLrcTimestamps(body)) {
            best = {
              entry: {
                syncedLyrics: body,
                trackName: title,
                artistName: artist,
                duration: durationMs / 1000,
              },
              score: 8,
            };
          }
        }
      } catch (e) {
        log.warn("Lrcmux: не удалось получить синхронизацию", e);
      }
    }

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
 * (лайки, подписки, плейлисты) недоступны. Просроченный токен
 * не отправляем — он ломает даже публичные запросы (401).
 */
async function apiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    Referer: "https://soundcloud.com/",
  };

  const token = await getAccessToken();
  if (token && !scTokenExpired(token)) {
    headers.Authorization = `OAuth ${token}`;
  }

  const cookie = await getCookieHeader();
  if (cookie) headers.Cookie = cookie;

  return headers;
}

/** Истёк ли access-токен SoundCloud (JWT, exp, запас — минута). */
function scTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 60_000;
  } catch {
    return false;
  }
}

/** client_id из claims токена — нужен для обновления сессии. */
function scClientIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return typeof payload.client_id === "string" ? payload.client_id : null;
  } catch {
    return null;
  }
}

/**
 * Продлевает OAuth-сессию SoundCloud по refresh-токену.
 *
 * Access-токен живёт сутки; когда он истекает, даже поиск отвечает 401.
 * SoundCloud отдаёт новую пару токенов стандартным OAuth-запросом,
 * а client_id берём из claims старого токена — так делает веб-клиент.
 * Новые cookies кладём и в партицию (их читают запросы), и в конфиг
 * (их читает восстановление сессии при следующем запуске).
 */
async function refreshScSession(): Promise<boolean> {
  try {
    const ses = session.fromPartition(SC_PARTITION);
    const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });
    const token = cookies.find((c) => c.name === "oauth_token")?.value;
    const refreshToken = cookies.find((c) => c.name === "oauth_refresh_token")?.value;

    if (!token || !refreshToken) return false;
    const clientId = scClientIdFromToken(token);
    if (!clientId) return false;

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const res = await fetch("https://secure.soundcloud.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": BROWSER_UA,
        Referer: "https://soundcloud.com/",
      },
      body,
    });

    if (!res.ok) {
      log.warn(`Обновление сессии SoundCloud отклонено: ${res.status}`);
      return false;
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!data.access_token) return false;

    const setCookie = async (name: string, value: string) => {
      await ses.cookies.set({
        url: "https://soundcloud.com",
        name,
        value,
        domain: ".soundcloud.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
      });
    };

    await setCookie("oauth_token", data.access_token);
    if (data.refresh_token) await setCookie("oauth_refresh_token", data.refresh_token);

    // Заголовок в конфиге: восстановление сессии при запуске и Rust-версия
    // читают его, если партиция пуста.
    const fresh = await ses.cookies.get({ domain: ".soundcloud.com" });
    setStore(
      "scCookies",
      fresh.map((c) => `${c.name}=${c.value}`).join("; ")
    );

    log.info("Сессия SoundCloud обновлена по refresh-токену");
    return true;
  } catch (error) {
    log.warn("Обновление сессии SoundCloud не удалось:", error);
    return false;
  }
}

/** Продлевает сессию, если до конца access-токена меньше получаса. */
async function refreshScSessionIfNeeded(): Promise<void> {
  const token = await getAccessToken();
  if (!token) return;
  if (!scTokenExpired(token)) {
    // До истечения больше минуты — проверим запас заранее.
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString("utf8")
      );
      const leftMs = payload.exp * 1000 - Date.now();
      if (leftMs > 30 * 60_000) return;
    } catch {
      return;
    }
  }
  await refreshScSession();
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

/**
 * Id текущего пользователя. Кэшируем: он не меняется в рамках сессии.
 */
let currentUserId: number | null = null;

async function getCurrentUserId(): Promise<number> {
  if (currentUserId) return currentUserId;

  const id = await getClientId();
  const res = await fetchWithRetry(`${API_V2}/me?client_id=${id}`, {
    headers: await apiHeaders(),
  });

  if (!res.ok) throw new Error("SoundCloud требует входа в аккаунт");

  const me = (await res.json()) as { id: number };
  currentUserId = me.id;
  return currentUserId;
}

function createWindow() {
  const bounds = store.get("windowBounds") as { width: number; height: number };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    title: "SoundWave",
    // Прозрачный фон нужен, чтобы скруглённые углы окна были видны:
    // цвет рисует сам интерфейс (.app-shell с border-radius).
    transparent: true,
    backgroundColor: "#00000000",
    icon: appIconPath(),
    autoHideMenuBar: true,
    // Своя рамка окна: системный заголовок и кнопки убираем,
    // свернуть/развернуть/закрыть рисуем сами.
    frame: false,
    roundedCorners: true,
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
    // Пользователь может запретить сворачивание в трей — тогда крестик
    // действительно закрывает приложение.
    if (!isQuitting && store.get("closeToTray") !== false) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });

  mainWindow.on("resize", () => {
    if (mainWindow) {
      const [width, height] = mainWindow.getSize();
      setStore("windowBounds", { width, height });
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

  // Развернуто/восстановлено — сообщаем рендереру, чтобы поменять иконку.
  const sendMaximized = () => {
    mainWindow?.webContents.send(
      "window-maximized-changed",
      mainWindow?.isMaximized() ?? false
    );
  };

  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  // Фокус окна: в фоне интерфейс ставит анимации на паузу и не жжёт CPU.
  mainWindow.on("focus", () => {
    mainWindow?.webContents.send("window-focus", true);
  });
  mainWindow.on("blur", () => {
    mainWindow?.webContents.send("window-focus", false);
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
  setStore("scCookies", cookieHeader);
  setStore("loggedIn", true);

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
      label: "Свернуть в трей",
      click: () => {
        mainWindow?.hide();
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

  // В подсказке видно, какая это версия — Rust или Electron.
  tray.setToolTip(`SoundWave ${app.getVersion()} · ELECTRON`);
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

/** Канал обновлений: stable, beta или alpha. */
function updateChannel(): string {
  const channel = String(store.get("updateChannel") ?? "stable");
  return ["stable", "beta", "alpha"].includes(channel) ? channel : "stable";
}

/**
 * Лента обновлений для канала.
 *
 * У каждого канала свой релиз на GitHub — ссылка постоянная, а внутри
 * лежит последняя сборка этого канала.
 */
function applyChannelFeed(channel: string): void {
  const url = `https://github.com/c4elovek-cmd/SoundWave/releases/download/${channel}/`;
  autoUpdater.setFeedURL({ provider: "generic", url });
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
  ipcMain.handle("set-theme", (_event, theme: string, base?: string) => {
    setStore("theme", theme);
    // Фон окна оставляем прозрачным: скруглённые углы рисует .app-shell,
    // и за ними видно рабочий стол. Непрозрачный фон закрыл бы углы.
    if (base && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor("#00000000");
    }
    return true;
  });

  // Сохранить громкость
  ipcMain.handle("set-volume", (_event, volume: number) => {
    setStore("volume", volume);
    return true;
  });

  /** Имя файла без запрещённых символов Windows. */
  function safeFileName(name: string): string {
    const cleaned = name
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+|\.+$/g, "")
      .trim();

    return cleaned || "track";
  }

  /** Уникальное имя файла: если такой уже есть — добавляем номер. */
  function uniqueFilePath(dir: string, name: string): string {
    const target = path.join(dir, name);
    if (!existsSync(target)) return target;

    const stem = path.basename(name, path.extname(name));
    const ext = path.extname(name);

    for (let n = 2; n < 500; n++) {
      const candidate = path.join(dir, `${stem} (${n})${ext}`);
      if (!existsSync(candidate)) return candidate;
    }

    return target;
  }

  /**
   * Прямая ссылка на mp3 трека.
   *
   * Для воспроизведения подходит любой играбельный поток, а для скачивания
   * нужен обычный progressive-mp3 — это один файл.
   */
  /**
   * Файлы HLS-плейлиста: init-сегмент и куски, по порядку.
   *
   * Ссылки в плейлисте могут быть относительными — дополняем их адресом
   * самого плейлиста.
   */
  function parseHlsParts(playlist: string, baseUrl: string): string[] {
    const parts: string[] = [];

    for (const raw of playlist.split("\n")) {
      const line = raw.trim();
      if (!line) continue;

      // #EXT-X-MAP:URI="..." — init-сегмент fMP4.
      if (line.startsWith("#EXT-X-MAP:")) {
        const match = line.match(/URI="([^"]+)"/);
        if (match) parts.push(new URL(match[1], baseUrl).toString());
        continue;
      }

      // Остальные строки — сегменты.
      if (!line.startsWith("#")) {
        parts.push(new URL(line, baseUrl).toString());
      }
    }

    return parts;
  }

  /**
   * Источник аудио для скачивания.
   *
   * Для воспроизведения подходит любой играбельный поток, а для скачивания
   * нужен цельный файл: обычный mp3 либо склеенные сегменты HLS.
   */
  async function resolveDownloadSource(
    trackId: number
  ): Promise<{ parts: string[]; extension: string }> {
    const id = await getClientId();
    const res = await withScThrottle(async () =>
      fetchWithRetry(`${API_V2}/tracks/${trackId}?client_id=${id}`, {
        headers: await apiHeaders(),
      })
    );

    if (!res.ok) throw new Error(`SoundCloud ответил ${res.status}`);

    const track = await res.json();
    const transcodings: any[] = track?.media?.transcodings ?? [];

    /** Ссылка на сам файл: у транскодировки она лежит в JSON-манифесте. */
    const manifestUrl = async (transcoding: any): Promise<string> => {
      const manifestRes = await withScThrottle(async () =>
        fetchWithRetry(transcoding.url, { headers: await apiHeaders() })
      );
      if (!manifestRes.ok) {
        throw new Error(`SoundCloud ответил ${manifestRes.status}`);
      }

      const manifest = await manifestRes.json();
      if (!manifest?.url) throw new Error("SoundCloud не вернул ссылку на аудио");
      return manifest.url as string;
    };

    // 1. Обычный mp3 — идеальный вариант, один файл.
    const progressive = transcodings.find(
      (t) => t?.format?.protocol === "progressive"
    );
    if (progressive) {
      return { parts: [await manifestUrl(progressive)], extension: "mp3" };
    }

    // 2. HLS с fMP4: init-сегмент плюс куски — из них получается .m4a.
    //    Зашифрованные протоколы (ctr/cbc-encrypted-hls) сюда не попадают:
    //    расшифровать сегменты вне плеера нельзя.
    const hls =
      transcodings.find(
        (t) =>
          t?.format?.protocol === "hls" &&
          String(t?.format?.mime_type ?? "").includes("mp4")
      ) ?? transcodings.find((t) => t?.format?.protocol === "hls");

    if (!hls) {
      const allEncrypted =
        transcodings.length > 0 &&
        transcodings.every((t) =>
          String(t?.format?.protocol ?? "").includes("encrypted")
        );
      throw new Error(
        allEncrypted
          ? "Трек защищён DRM — скачать его нельзя, только слушать"
          : "У трека нет потока, который можно скачать"
      );
    }

    const playlistUrl = await manifestUrl(hls);
    const playlistRes = await fetch(playlistUrl);
    if (!playlistRes.ok) {
      throw new Error(`Плейлист недоступен: ${playlistRes.status}`);
    }

    const parts = parseHlsParts(await playlistRes.text(), playlistUrl);
    if (!parts.length) throw new Error("Плейлист трека пустой — скачать нечего");

    return { parts, extension: "m4a" };
  }


  // Открыть папку средствами системы.
  // Для файла — открываем папку и выделяем его: кнопка «Открыть» после
  // скачивания должна показывать, куда лёг трек, а не запускать плеер.
  ipcMain.handle("open-path", async (_event, target: string) => {
    try {
      const resolved =
        target === "downloads" || !target
          ? app.getPath("downloads")
          : target;
      if (resolved.includes(":") && !resolved.startsWith("http")) {
        let isFile = false;
        try {
          isFile = statSync(resolved).isFile();
        } catch {
          isFile = false;
        }

        if (isFile) {
          shell.showItemInFolder(resolved);
        } else {
          await shell.openPath(resolved);
        }
      } else {
        shell.showItemInFolder(resolved);
      }
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Не удалось открыть файл";
      log.warn("Открытие не удалось:", message);
      return { ok: false, error: message };
    }
  });
  /**
   * Путь к ffmpeg.
   *
   * Приложение не таскает его с собой, но без ffmpeg нельзя получить mp3
   * из HLS-потока SoundCloud. Ищем в PATH и типовых местах установки.
   */
  function findFfmpeg(): string | null {
    const isWin = process.platform === "win32";
    const exeName = isWin ? "ffmpeg.exe" : "ffmpeg";

    // 1. PATH.
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, exeName);
      if (existsSync(candidate)) return candidate;
    }

    const candidates: string[] = [];

    // 2. Рядом с приложением.
    candidates.push(path.join(path.dirname(app.getPath("exe")), exeName));
    candidates.push(path.join(process.resourcesPath ?? "", exeName));

    // 3. WinGet: ссылка и распакованный пакет.
    if (process.env.LOCALAPPDATA) {
      const winget = path.join(
        process.env.LOCALAPPDATA,
        "Microsoft",
        "WinGet"
      );
      candidates.push(path.join(winget, "Links", exeName));

      const packages = path.join(winget, "Packages");
      try {
        for (const entry of readdirSync(packages)) {
          if (!entry.toLowerCase().includes("ffmpeg")) continue;
          const pkg = path.join(packages, entry);
          for (const build of readdirSync(pkg)) {
            candidates.push(path.join(pkg, build, "bin", exeName));
          }
        }
      } catch {
        // Папки может не быть — это нормально.
      }
    }

    // 4. Chocolatey и ручная установка.
    if (process.env.ProgramData) {
      candidates.push(
        path.join(process.env.ProgramData, "chocolatey", "bin", exeName)
      );
    }
    candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");

    return candidates.find((p) => p && existsSync(p)) ?? null;
  }

  /** Перекодировать файл в mp3. Бросает ошибку, если ffmpeg не справился. */
  function convertToMp3(
    input: string,
    output: string,
    title: string,
    artist: string
  ): Promise<void> {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      return Promise.reject(
        new Error("Для сохранения в mp3 нужен ffmpeg — установите его и повторите")
      );
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          input,
          "-vn",
          "-codec:a",
          "libmp3lame",
          "-q:a",
          "2",
          // Теги — чтобы плееры показывали исполнителя и название.
          "-metadata",
          `title=${title}`,
          "-metadata",
          `artist=${artist}`,
          output,
        ],
        { windowsHide: true }
      );

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (e) => reject(new Error(`ffmpeg: ${e.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else {
          const last = stderr.trim().split("\n").pop() ?? `код ${code}`;
          reject(new Error(`Не удалось перекодировать в mp3: ${last}`));
        }
      });
    });
  }

  // Скачать трек в папку «Загрузки» в формате mp3
  ipcMain.handle(
    "download-track",
    async (_event, trackId: number, title: string, artist: string) => {
      const report = (
        state: string,
        percent: number,
        extra: Record<string, unknown> = {}
      ) => {
        mainWindow?.webContents.send("download-progress", {
          trackId,
          percent,
          state,
          ...extra,
        });
      };

      report("started", 0);

      // Уже скачан? Повторная кнопка «скачать всё» не должна плодить
      // дубликаты: если файл с таким именем лежит в загрузках, сообщаем
      // «готово» и не качаем второй раз.
      const dir = app.getPath("downloads");
      const existing = path.join(
        dir,
        `${safeFileName(artist)} - ${safeFileName(title)}.mp3`
      );
      if (existsSync(existing)) {
        report("done", 100, { path: existing });
        return { path: existing, skipped: true };
      }

      const tempPath = path.join(
        os.tmpdir(),
        `soundwave-${trackId}-${process.pid}.m4a`
      );

      try {
        const source = await resolveDownloadSource(trackId);
        const handle = await fsPromises.open(tempPath, "w");
        const totalParts = Math.max(source.parts.length, 1);

        try {
          // Части идут по порядку: у mp3 она одна, у HLS — init и сегменты.
          for (let index = 0; index < source.parts.length; index++) {
            const response = await fetch(source.parts[index]);
            if (!response.ok || !response.body) {
              throw new Error(`Сервер отдал ошибку ${response.status}`);
            }

            const total = Number(response.headers.get("content-length") ?? 0);
            const reader = response.body.getReader();
            let written = 0;

            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;

              await handle.write(value);
              written += value.length;

              const partPercent =
                total > 0 ? Math.min(100, Math.floor((written * 100) / total)) : 0;
              // Загрузка — первые 90%, остальное конвертация.
              report(
                "progress",
                Math.min(
                  90,
                  Math.floor(((index * 100 + partPercent) / totalParts) * 0.9)
                )
              );
            }
          }
        } finally {
          await handle.close();
        }

        const target = uniqueFilePath(
          dir,
          `${safeFileName(artist)} - ${safeFileName(title)}.mp3`
        );

        if (source.extension === "mp3") {
          // rename не работает между дисками — на этот случай копируем.
          try {
            await fsPromises.rename(tempPath, target);
          } catch {
            await fsPromises.copyFile(tempPath, target);
            await fsPromises.unlink(tempPath).catch(() => undefined);
          }
        } else {
          report("progress", 95);
          await convertToMp3(tempPath, target, title, artist);
          await fsPromises.unlink(tempPath).catch(() => undefined);
        }

        report("done", 100, { path: target });
        log.info("Трек скачан:", target);
        return { ok: true, path: target };
      } catch (e) {
        await fsPromises.unlink(tempPath).catch(() => undefined);
        const message =
          e instanceof Error ? e.message : "Не удалось скачать трек";
        log.warn("Скачивание не удалось:", message);
        report("error", 0, { error: message });
        return { ok: false, error: message };
      }
    }
  );

  // Скачан ли трек: файл «Артист - Трек.mp3» в папке загрузок.
  // Плеер играет такие треки локально, без сети.
  ipcMain.handle(
    "find-download",
    (_event, title: string, artist: string) => {
      const dir = app.getPath("downloads");
      const file = path.join(
        dir,
        `${safeFileName(String(artist ?? ""))} - ${safeFileName(String(title ?? ""))}.mp3`
      );
      return existsSync(file)
        ? { found: true, path: file }
        : { found: false };
    }
  );

  // Пакетная проверка: список треков → карта «id → путь».
  // Страницам невыгодно дёргать по одному треку за раз.
  ipcMain.handle(
    "find-downloads",
    (_event, tracks: Array<{ id: number; title: string; artist: string }>) => {
      const dir = app.getPath("downloads");
      const out: Record<string, string> = {};

      for (const item of tracks ?? []) {
        if (!item || typeof item.id !== "number" || !item.title) continue;
        const file = path.join(
          dir,
          `${safeFileName(String(item.artist ?? ""))} - ${safeFileName(String(item.title))}.mp3`
        );
        if (existsSync(file)) out[String(item.id)] = file;
      }

      return out;
    }
  );

  // Все скачанные mp3 из папки загрузок — для страницы «Скачанные».
  ipcMain.handle("list-downloads", () => {
    const dir = app.getPath("downloads");
    const out: Array<{
      file: string;
      path: string;
      size: number;
      modified: number;
    }> = [];

    try {
      for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith(".mp3")) continue;
        const full = path.join(dir, name);
        try {
          const stats = statSync(full);
          out.push({
            file: name,
            path: full,
            size: stats.size,
            modified: stats.mtimeMs,
          });
        } catch {
          continue;
        }
      }
    } catch {
      // Папки может не быть — считаем список пустым.
    }

    out.sort((a, b) => b.modified - a.modified);
    return out;
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
   * Запись во внутренний API SoundCloud: POST / PUT / DELETE.
   * Читать приватные коллекции и менять лайки можно только с OAuth-токеном,
   * который приложение достаёт при входе.
   */
  ipcMain.handle(
    "sc-write",
    async (
      _event,
      method: string,
      path: string,
      params: Record<string, string | number> = {}
    ) => {
      const id = await getClientId();

      const url = path.startsWith("http")
        ? new URL(path)
        : new URL(`${API_V2}${path.startsWith("/") ? path : `/${path}`}`);

      if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", id);
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, String(value));
      }

      const res = await withScThrottle(async () =>
        fetch(url.toString(), {
          method: method.toUpperCase(),
          headers: await apiHeaders(),
        })
      );

      const text = await res.text();

      if (!res.ok) {
        throw new Error(
          `SoundCloud API вернул ошибку ${res.status} (${method.toUpperCase()} ${url.pathname}): ${text.slice(0, 200)}`,
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  );

  // Лайк / снятие лайка.
  //
  // Тот же путь, что использует веб-клиент SoundCloud:
  // PUT/DELETE /users/{userId}/track_likes/{trackId}. Пробованный ранее
  // документированный POST /likes/tracks/{urn} принимает только OAuth-
  // клиентов из Dev Portal (403 для веб client_id).
  ipcMain.handle(
    "sc-toggle-like",
    async (_event, trackId: number, like: boolean) => {
      try {
        const userId = await getCurrentUserId();
        const clientId = await getClientId();

        const url =
          `${API_V2}/users/${userId}/track_likes/${trackId}` +
          `?client_id=${clientId}`;

        const res = await withScThrottle(async () =>
          fetch(url, {
            method: like ? "PUT" : "DELETE",
            headers: await apiHeaders(),
          })
        );

        const body = await res.text();
        log.info(`Лайк ${like ? "+" : "-"} трек ${trackId}: ${res.status} ${body.slice(0, 120)}`);

        // Повторный PUT (трек уже лайкнут) и DELETE несуществующего лайка
        // уже дают нужное состояние, поэтому это не ошибка.
        const stateAlreadyReached =
          (like && (res.status === 400 || res.status === 409 || res.status === 500)) ||
          (!like && res.status === 404);

        if (!res.ok && !stateAlreadyReached) {
          throw new Error(
            res.status === 401
              ? "Нужен вход в аккаунт SoundCloud"
              : `SoundCloud API вернул ошибку ${res.status}`,
          );
        }

        return { ok: true, liked: like };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Не удалось изменить лайк",
        };
      }
    }
  );

  /**
   * Помечает DRM-треки прямо в ответе API.
   *
   * У SoundCloud для защищённых треков есть только зашифрованные потоки —
   * их не играет ни один браузер. Флаг ставит интерфейс, чтобы не пускать
   * такие треки в очередь.
   */
  function markDrmTracks(value: any): void {
    if (Array.isArray(value)) {
      value.forEach(markDrmTracks);
      return;
    }
    if (!value || typeof value !== "object") return;

    for (const item of Object.values(value)) {
      markDrmTracks(item);
    }

    const transcodings = value?.media?.transcodings;
    if (
      Array.isArray(transcodings) &&
      transcodings.length > 0 &&
      transcodings.every((t) => String(t?.format?.protocol ?? "").includes("encrypted"))
    ) {
      value.drm = true;
    }
  }

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

      const res = await withScThrottle(async () =>
        fetchWithRetry(url.toString(), { headers: await apiHeaders() })
      );
      const text = await res.text();

      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "SoundCloud требует входа в аккаунт"
            : `SoundCloud API вернул ошибку ${res.status} (${url.pathname})`,
        );
      }

      try {
        const data = JSON.parse(text);
        // Помечаем DRM-треки: в очередь такие попадать не должны.
        markDrmTracks(data);
        return data;
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

    // Выбираем поток, который браузер действительно сможет сыграть.
    //
    // У SoundCloud бывают три вида:
    //   progressive        — обычный mp3, играет всегда;
    //   hls                — открытый HLS с сегментами fMP4;
    //   ctr-encrypted-hls  — HLS с ключом в data-URI (Common Encryption),
    //                        такой hls.js расшифровывает;
    //   cbc-encrypted-hls  — FairPlay (`skd://`, com.apple.streamingkeydelivery),
    //                        его не играет ни один браузер — только в последнюю
    //                        очередь, когда других вариантов нет.
    const protocolOf = (t: any) => String(t?.format?.protocol ?? "");
    const mimeOf = (t: any) => String(t?.format?.mime_type ?? "");

    const chosen =
      transcodings.find((t) => protocolOf(t) === "progressive") ??
      transcodings.find((t) => protocolOf(t) === "hls") ??
      transcodings.find((t) => protocolOf(t) === "ctr-encrypted-hls") ??
      transcodings.find(
        (t) => mimeOf(t).includes("mp4") && !protocolOf(t).includes("encrypted")
      ) ??
      transcodings.find((t) => protocolOf(t) === "cbc-encrypted-hls") ??
      transcodings[0];

    if (!chosen) {
      throw new Error("У трека нет доступных потоков");
    }

    // Остались только зашифрованные потоки: такой трек закрыт DRM
    // (FairPlay или Common Encryption) и браузер его не расшифрует.
    // Лучше честно сказать об этом, чем молча стоять на 0:00.
    if (protocolOf(chosen).includes("encrypted")) {
      throw new Error("Трек защищён DRM — звук недоступен");
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
    async (
      _event,
      payload: { title?: string; artist?: string; description?: string; duration?: number }
    ) => {
      const title = String(payload?.title ?? "").trim();
      const artist = String(payload?.artist ?? "").trim();
      const duration = Number(payload?.duration ?? 0) || 0;

      if (!title) return { found: false, error: "Не указано название трека" };

      const genius = await getGeniusLyrics(title, artist, payload?.description);

      // Genius не знает такой трек — берём текст из LRCLIB.
      // Там же лежат и тайминги, поэтому караоке будет точным.
      const found = genius.found
        ? genius
        : await getLrclibPlainLyrics(title, artist, duration);
      const result = found.found ? found : genius;

      // Караоке для speed up / slowed версий бессмысленно: тайминги
      // оригинала разъедутся со звуком. Текст при этом отдаём — он нужен.
      if (result.found && isTempoModified(title)) {
        return { ...result, tempoModified: true };
      }

      return result;
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
    // Сессия могла остаться с прошлого запуска или появиться в Rust-версии:
    // в этом случае подкладываем cookies из общего файла настроек.
    await importCookiesFromConfig();

    const cookies = await session.fromPartition(SC_PARTITION).cookies.get({ domain: ".soundcloud.com" });
    const hasToken = cookies.some((c) => c.name === "oauth_token");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const loggedIn = hasToken && Boolean(cookieHeader);

    if (loggedIn) {
      setStore("loggedIn", true);
      setStore("scCookies", cookieHeader);
      mainWindow?.webContents.send("auth-success", cookieHeader);
    } else {
      setStore("loggedIn", false);
      setStore("scCookies", null);
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
    setStore("scCookies", cookieHeader);
    setStore("loggedIn", true);
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
    setStore("loggedIn", false);
    setStore("scCookies", null);
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

  // Свои кнопки окна
  ipcMain.handle("window-minimize", () => {
    mainWindow?.minimize();
    return true;
  });

  ipcMain.handle("window-toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle("window-is-maximized", () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.handle("window-close", () => {
    // Закрытие из окна — это выход из приложения, а не сворачивание в трей.
    isQuitting = true;
    mainWindow?.close();
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
    const { display, weight, suffix } = parseFontName(base);
    const id = randomBytes(6).toString("hex");
    const family = `SWFont${display.replace(/[^\w]+/g, "")}`;
    const file = `${id}-${base.replace(/[^\w.-]+/g, "_")}.${ext}`;

    mkdirSync(fontsDir(), { recursive: true });
    copyFileSync(source, path.join(fontsDir(), file));

    const font: StoredFont = {
      id,
      name: `${display} ${suffix}`,
      display,
      family,
      file,
      weight,
    };
    setStore("customFonts", [
      ...listStoredFonts().filter((item) => item.id !== id),
      font,
    ]);

    return fontEntry(font);
  });

  // Удалить шрифт: сразу всё семейство со всеми начертаниями
  ipcMain.handle("fonts-remove", (_event, family: string) => {
    const fonts = listStoredFonts();
    const doomed = fonts.filter((item) => item.family === family);

    if (doomed.length === 0) return false;

    for (const font of doomed) {
      try {
        unlinkSync(path.join(fontsDir(), font.file));
      } catch {
        // Файла уже нет — не страшно.
      }
    }

    setStore(
      "customFonts",
      fonts.filter((item) => item.family !== family)
    );
    return true;
  });

  /* ==================== Discord Rich Presence ==================== */

  ipcMain.handle("discord-status", () => {
    const custom = String(store.get("discordClientId") ?? "").trim();
    return {
      enabled: store.get("discordEnabled") !== false,
      clientId: getDiscordClientId(),
      builtIn: !custom,
      largeImage: String(store.get("discordLargeImage") ?? ""),
      connected: discord.isConnected,
    };
  });

  ipcMain.handle(
    "discord-config",
    async (
      _event,
      payload?: { enabled?: boolean; clientId?: string; largeImage?: string }
    ) => {
      if (payload?.enabled !== undefined) {
        setStore("discordEnabled", Boolean(payload.enabled));
      }
      if (payload?.clientId !== undefined) {
        setStore("discordClientId", String(payload.clientId).trim());
      }
      if (payload?.largeImage !== undefined) {
        setStore("discordLargeImage", String(payload.largeImage).trim());
      }

      const enabled = store.get("discordEnabled") !== false;
      const clientId = getDiscordClientId();

      if (enabled && clientId) {
        await discord.connect(clientId);
      } else {
        discord.stop();
      }

      return {
        enabled,
        clientId,
        builtIn: !String(store.get("discordClientId") ?? "").trim(),
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
            artworkUrl?: string;
            largeText?: string;
            smallText?: string;
            startTimestamp?: number;
          }
        | null
    ) => {
      if (!store.get("discordEnabled") && store.get("discordEnabled") !== undefined) {
        return false;
      }

      if (!presence) {
        discord.setActivity(null);
        log.info("Discord: активность очищена");
        return true;
      }

      log.info(
        `Discord: активность — «${presence.details ?? ""}» / «${presence.state ?? ""}»`
      );

      // Discord принимает внешний URL как картинку активности. Поэтому
      // показываем обложку играющего трека, а ключ из настроек — запасной
      // вариант, когда обложки у трека нет.
      const artwork = String(presence.artworkUrl ?? "").trim();
      const configuredImage = String(store.get("discordLargeImage") ?? "").trim();

      discord.setActivity({
        details: presence.details,
        state: presence.state,
        largeText: presence.largeText,
        smallText: presence.smallText,
        largeImageKey:
          (artwork.startsWith("https://") ? artwork : "") ||
          configuredImage ||
          DEFAULT_DISCORD_ASSET,
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
        setStore("agentApiEnabled", Boolean(payload.enabled));
      }

      if (payload?.port !== undefined) {
        const port = Number(payload.port);
        if (Number.isFinite(port) && port > 1024 && port < 65536) {
          setStore("agentApiPort", Math.round(port));
        }
      }

      if (payload?.regenerateToken) {
        setStore("agentApiToken", randomBytes(24).toString("hex"));
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

  // Журнал действий пользователя: включается в настройках, нужен для разбора багов
  // Закрывать окно в трей или выходить из приложения
  ipcMain.handle("set-close-to-tray", (_event, value: boolean) => {
    setStore("closeToTray", Boolean(value));
    log.info("Закрывать окно в трей:", value ? "включено" : "выключено");
    return true;
  });

  // Текущий канал обновлений
  ipcMain.handle("get-update-channel", () => {
    return updateChannel();
  });

  // Сменить канал обновлений: stable, beta или alpha
  ipcMain.handle("set-update-channel", (_event, channel: string) => {
    const value = ["stable", "beta", "alpha"].includes(channel)
      ? channel
      : "stable";

    setStore("updateChannel", value);
    applyChannelFeed(value);
    log.info("Канал обновлений:", value);
    return { ok: true, channel: value };
  });

  // Автообновление: проверяем релиз на GitHub и качаем новую версию.
  ipcMain.handle("check-for-updates", async () => {
    if (!app.isPackaged) {
      return {
        ok: false,
        error: "Обновления доступны только в установленной версии",
      };
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version ?? "";
      const current = app.getVersion();

      if (!version || version === current) {
        return { ok: true, upToDate: true, current };
      }

      return { ok: true, upToDate: false, version, current };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Не удалось проверить обновления";
      log.warn("Проверка обновлений не удалась:", message);
      return { ok: false, error: message };
    }
  });

  // Установить скачанное обновление и перезапустить приложение.
  ipcMain.handle("install-update", async () => {
    if (!app.isPackaged) {
      return { ok: false, error: "Обновления доступны только в установленной версии" };
    }

    try {
      // Файл ещё мог не скачаться — ждём и тогда ставим.
      if (!updateDownloaded) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Обновление не скачалось за 5 минут"));
          }, 5 * 60 * 1000);

          const onDownloaded = () => {
            cleanup();
            resolve();
          };
          const onError = (e: Error) => {
            cleanup();
            reject(e);
          };
          const cleanup = () => {
            clearTimeout(timer);
            autoUpdater.removeListener("update-downloaded", onDownloaded);
            autoUpdater.removeListener("error", onError);
          };

          autoUpdater.on("update-downloaded", onDownloaded);
          autoUpdater.on("error", onError);
        });
      }

      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Не удалось установить обновление";
      log.warn("Установка обновления не удалась:", message);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(
    "log-action",
    (_event, action: string, details: Record<string, unknown> = {}) => {
      try {
        const dir = path.join(app.getPath("userData"), "logs");
        mkdirSync(dir, { recursive: true });

        const line = JSON.stringify({
          t: new Date().toISOString(),
          a: action,
          ...details,
        });

        appendFileSync(path.join(dir, "actions.log"), `${line}\n`, "utf8");
        return true;
      } catch (e) {
        log.warn("Не удалось записать действие в журнал:", e);
        return false;
      }
    }
  );

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

    // Access-токен SoundCloud живёт сутки — продлеваем заранее:
    // сразу при запуске и дальше раз в 15 минут.
    void refreshScSessionIfNeeded();
    setInterval(() => void refreshScSessionIfNeeded(), 15 * 60_000);

    // Discord Rich Presence — если включён, подключаемся сразу.
    if (store.get("discordEnabled") !== false) {
      const clientId = getDiscordClientId();
      if (clientId) void discord.connect(clientId);
    }


  // Автообновление: следим за релизом и сообщаем интерфейсу.
    applyChannelFeed(updateChannel());
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      log.info("Доступно обновление:", info.version);
      mainWindow?.webContents.send("update-available", { version: info.version });
    });

    autoUpdater.on("update-downloaded", (info) => {
      log.info("Обновление скачано:", info.version);
      updateDownloaded = true;
      mainWindow?.webContents.send("update-downloaded", { version: info.version });
    });

    autoUpdater.on("error", (e) => {
      log.warn("Автообновление не сработало:", e.message);
      mainWindow?.webContents.send("update-error", { message: e.message });
    });

    // Сессия общая с Rust-версией: если там выполнили вход, подхватываем
    // его здесь, и наоборот — вход в этой версии увидит Rust.
    void importCookiesFromConfig().then((imported) => {
      if (!imported) return;
      void session.fromPartition(SC_PARTITION)
        .cookies.get({ domain: ".soundcloud.com" })
        .then((cookies) => {
          const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
          if (header) {
            setStore("scCookies", header);
            setStore("loggedIn", true);
            mainWindow?.webContents.send("auth-success", header);
          }
        });
    });

    watchSessionFile(store, (cookieHeader) => {
      if (!cookieHeader) {
        // В другой версии вышли из аккаунта — чистим сессию и выходим здесь.
        void clearSessionCookies().then(() => {
          setStore("loggedIn", false);
          mainWindow?.webContents.send("logged-out");
        });
        return;
      }
      mainWindow?.webContents.send("auth-success", cookieHeader);
    });
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

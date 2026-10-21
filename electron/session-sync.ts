// Синхронизация сессии между двумя версиями приложения.
//
// Electron и Rust хранят cookies по-разному: Electron — в своём разделе
// сессии Chromium, Rust — в хранилище WebView2. Общий файл настроек
// (soundwave-config.json) связывает их: в нём лежит строка cookies.
//
// Здесь:
//   1. запись в настройки не затирает изменения другой версии;
//   2. cookies из файла подкладываются в сессию Electron, если своих нет;
//   3. следит за файлом: вход в другой версии подхватывается сразу.

import { app, session } from "electron";
import fs from "fs";
import path from "path";
import log from "electron-log";

const SC_PARTITION = "persist:soundcloud";
const CONFIG_FILE = "soundwave-config.json";
const WATCH_INTERVAL = 2000;

/** Читает файл настроек с диска — минуя кэш electron-store. */
export function readConfigFile(): Record<string, unknown> {
  try {
    const file = path.join(app.getPath("userData"), CONFIG_FILE);
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Пишет значение в настройки, не затирая то, что изменила другая версия.
 *
 * electron-store держит состояние в памяти и переписывает файл целиком:
 * если Rust-версия успела записать сессию, любая запись Electron поверх
 * возвращала бы старые cookies. Поэтому перед записью подтягиваем файл.
 */
export function setConfigValue(
  store: { set: (key: string, value: unknown) => void },
  key: string,
  value: unknown,
): void {
  const fresh = readConfigFile();
  if (Object.keys(fresh).length > 0) {
    // Обновляем кэш store свежими данными, иначе set() перезапишет файл
    // устаревшим состоянием.
    try {
      (store as unknown as { store: unknown }).store = fresh;
    } catch {
      // Если store не даёт менять состояние целиком — просто пишем поверх.
    }
  }
  store.set(key, value);
}

/** Раскладывает строку cookies на пары. */
function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .map((pair) => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter((pair) => pair.name.length > 0);
}

/**
 * Кладёт cookies из файла настроек в сессию Electron.
 *
 * Нужно, когда сессия Chromium пустая, а вход уже есть — например, его
 * сделали в Rust-версии. Возвращает true, если что-то импортировали.
 *
 * force = true — принимаем сессию из файла безусловно: так подхватывается
 * вход, сделанный в другой версии приложения.
 */
export async function importCookiesFromConfig(force = false): Promise<boolean> {
  const saved = String(readConfigFile().scCookies ?? "").trim();
  if (!saved) return false;

  const ses = session.fromPartition(SC_PARTITION);
  const existing = await ses.cookies.get({ domain: ".soundcloud.com" });
  if (
    !force &&
    existing.some((cookie) => cookie.name === "oauth_token" && cookie.value)
  ) {
    return false;
  }

  const pairs = parseCookieHeader(saved);
  if (pairs.length === 0) return false;

  let imported = 0;
  for (const { name, value } of pairs) {
    try {
      // Старый cookie с тем же именем убираем: иначе в заголовке окажется
      // два oauth_token, и API возьмёт не тот.
      const previous = await ses.cookies.get({ name });
      for (const old of previous) {
        const domain = old.domain ?? ".soundcloud.com";
        const url = `https://${domain.replace(/^\./, "")}${old.path ?? "/"}`;
        try {
          await ses.cookies.remove(url, name);
        } catch {
          // Если удалить не вышло — перезапишем тем же именем ниже.
        }
      }

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
      imported += 1;
    } catch {
      // Неудачный cookie не помешает остальным.
    }
  }

  if (imported > 0) {
    log.info(`Сессия синхронизирована из файла настроек: ${imported} cookies`);
  }
  return imported > 0;
}

/**
 * Убирает cookies SoundCloud из сессии Electron.
 *
 * Нужно, когда сессию закрыли в другой версии приложения.
 */
export async function clearSessionCookies(): Promise<void> {
  const ses = session.fromPartition(SC_PARTITION);
  const cookies = await ses.cookies.get({ domain: ".soundcloud.com" });

  for (const cookie of cookies) {
    const domain = cookie.domain ?? ".soundcloud.com";
    const url = `https://${domain.replace(/^\./, "")}${cookie.path ?? "/"}`;
    try {
      await ses.cookies.remove(url, cookie.name);
    } catch {
      // Если не удалось — не страшно, главное не блокировать остальное.
    }
  }
}

/**
 * Следит за файлом настроек и сообщает, когда сессия изменилась.
 *
 * Вход в другой версии приложения должен подхватываться сразу, а не
 * после перезапуска.
 */
export function watchSessionFile(
  store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  onChanged: (cookieHeader: string) => void,
): () => void {
  let last = String(readConfigFile().scCookies ?? "");

  const timer = setInterval(() => {
    const current = String(readConfigFile().scCookies ?? "");
    if (current === last) return;
    last = current;

    log.info("Сессия изменена в другой версии приложения — синхронизируем");
    void importCookiesFromConfig(true).then(() => {
      try {
        store.set("loggedIn", Boolean(current));
      } catch {
        // Не критично.
      }
      onChanged(current);
    });
  }, WATCH_INTERVAL);

  timer.unref?.();
  return () => clearInterval(timer);
}

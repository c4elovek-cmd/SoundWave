/**
 * Локальные файлы в интерфейсе.
 *
 * Скачанные треки плеер играет прямо с диска — без сети и без
 * повторного запроса ссылки у SoundCloud. Аудио-элементу нужен URL,
 * который понимает оболочка:
 *  - Tauri (WebView2) — asset-протокол (`asset://` / `http://asset.localhost`),
 *    включён в tauri.conf.json с областью «папка загрузок»;
 *  - Electron (Chromium) — обычный `file:///`.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./tauriBridge";

/** URL локального файла для аудио-элемента. */
export function localFileUrl(path: string): string {
  if (isTauri()) {
    return convertFileSrc(path);
  }

  // Electron: file:///C:/Users/…/Artist%20-%20Track.mp3
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    "file:///" +
    encodeURI(normalized)
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F")
  );
}

/** Человекочитаемый размер файла: «3.4 МБ». */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} МБ`;
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

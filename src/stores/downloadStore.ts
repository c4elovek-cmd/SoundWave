import { create } from "zustand";
import { useEffect } from "react";
import { showToast } from "./toastStore";
import { SCTrack } from "../types/soundcloud";
import { logAction } from "../lib/actionLog";

/** Состояние скачивания одного трека. */
export interface DownloadInfo {
  percent: number;
  state: "started" | "progress" | "done" | "error";
  error?: string;
  path?: string;
}

interface BatchDownload {
  label: string;
  total: number;
  done: number;
  failed: number;
}

interface DownloadState {
  /** Прогресс по id трека. */
  downloads: Record<number, DownloadInfo>;
  /** Идёт пакетное скачивание (кнопка «Скачать всё»). */
  batch: BatchDownload | null;
  /** Путь к скачанному файлу по id трека — такие играются с диска. */
  known: Record<number, string>;
  setInfo: (trackId: number, info: DownloadInfo) => void;
  clear: (trackId: number) => void;
}

export const useDownloadStore = create<DownloadState>((set) => ({
  downloads: {},
  batch: null,
  known: {},
  setInfo: (trackId, info) =>
    set((state) => ({ downloads: { ...state.downloads, [trackId]: info } })),
  clear: (trackId) =>
    set((state) => {
      const downloads = { ...state.downloads };
      delete downloads[trackId];
      return { downloads };
    }),
}));

let subscribed = false;

/**
 * Подписка на события скачивания от бэкенда.
 *
 * Событие одно на приложение, поэтому подписка заводится один раз:
 * дальше состояние раздаётся из стора.
 */
export function ensureDownloadSubscription(): void {
  if (subscribed) return;
  if (!window.electronAPI?.onDownloadProgress) return;

  subscribed = true;
  window.electronAPI.onDownloadProgress((info) => {
    const store = useDownloadStore.getState();
    const inBatch = store.batch !== null;

    store.setInfo(info.trackId, {
      percent: info.percent,
      state: info.state as DownloadInfo["state"],
      error: info.error,
      path: info.path,
    });

    // Скачанный трек запоминаем: плеер будет играть его с диска,
    // а в строках появится отметка «скачано».
    if (info.state === "done" && info.path) {
      useDownloadStore.setState((state) => ({
        known: { ...state.known, [info.trackId]: info.path as string },
      }));
    }

    // Во время «Скачать всё» по-трековые плашки не нужны: их были сотни,
    // и они заваливали экран. Итог покажет пакетная плашка в конце.
    if (info.state === "done" && !inBatch) {
      showToast({
        group: "download-done",
        kind: "success",
        title: "Трек скачан",
        message: info.path,
        timeout: 8000,
        action: info.path
          ? {
              label: "Открыть",
              onClick: () => {
                void window.electronAPI?.openPath?.(info.path as string);
              },
            }
          : undefined,
      });
    }

    if (info.state === "error") {
      // Ошибки схлопываем в одну плашку: важна последняя причина, а не
      // список из сотни одинаковых.
      showToast({
        group: "download-error",
        kind: "error",
        title: "Не удалось скачать",
        message: info.error,
        timeout: 6000,
      });
    }

    // Готовый или упавший трек убираем из списка через пару секунд.
    if (info.state === "done" || info.state === "error") {
      window.setTimeout(
        () => useDownloadStore.getState().clear(info.trackId),
        3000
      );
    }
  });
}

/**
 * Скачать трек в папку «Загрузки».
 *
 * Ошибки не выбрасываем наружу: о них сообщает бэкенд событием
 * `download-progress`, а интерфейс показывает состояние в кнопке.
 */
export async function downloadTrack(
  trackId: number,
  title: string,
  artist: string
): Promise<void> {
  try {
    await window.electronAPI?.downloadTrack?.(trackId, title, artist);
  } catch (error) {
    console.error("Не удалось скачать трек:", error);
    useDownloadStore.getState().setInfo(trackId, {
      percent: 0,
      state: "error",
      error: error instanceof Error ? error.message : "Не удалось скачать трек",
    });
    window.setTimeout(() => useDownloadStore.getState().clear(trackId), 4000);
  }
}

/** Ждёт, пока бэкенд отчитается о готовности или ошибке по треку. */
export function downloadTrackAndWait(track: SCTrack): Promise<DownloadInfo> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (info: DownloadInfo) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(info);
    };

    const check = () => {
      const info = useDownloadStore.getState().downloads[track.id];
      if (info && (info.state === "done" || info.state === "error")) finish(info);
    };

    const unsubscribe = useDownloadStore.subscribe(check);
    // Страховка: если событие от бэкенда потерялось, не виснем навсегда.
    const timer = window.setTimeout(() => {
      finish({ percent: 0, state: "error", error: "Скачивание прервано по таймауту" });
    }, 15 * 60 * 1000);

    void downloadTrack(track.id, track.title, track.user?.username ?? "");
  });
}

/**
 * Скачивает список треков подряд — кнопка «Скачать всё».
 *
 * По одному, а не всё сразу: иначе на коллекцию в сотню лайков обрушивается
 * сотня одновременных загрузок. Прогресс по каждому треку виден в его строке
 * списка; уже скачанные бэкенд пропускает сам (файл с тем же именем есть).
 */
export async function downloadTracks(
  tracks: SCTrack[],
  label: string
): Promise<void> {
  ensureDownloadSubscription();

  const list = tracks.filter((track) => track.id && track.title);
  if (list.length === 0) return;

  const running = useDownloadStore.getState().batch;
  if (running) {
    showToast({
      kind: "info",
      title: "Скачивание уже идёт",
      message: `${running.label}: ${running.done + running.failed}/${running.total}`,
      timeout: 4000,
    });
    return;
  }

  useDownloadStore.setState({ batch: { label, total: list.length, done: 0, failed: 0 } });
  logAction("tracks.download_batch", { label, count: list.length });

  // Одна плашка на весь пакет: обновляется на месте и в конце
  // превращается в итог. По-трековые плашки в это время не показываем.
  showToast({
    group: "download-batch",
    kind: "info",
    title: `Скачиваю: ${label}`,
    message: `0 из ${list.length}`,
    timeout: 0,
  });

  try {
    for (const track of list) {
      const info = await downloadTrackAndWait(track);
      const current = useDownloadStore.getState().batch;
      if (!current) break;
      const next = {
        ...current,
        done: current.done + (info.state === "done" ? 1 : 0),
        failed: current.failed + (info.state === "error" ? 1 : 0),
      };
      useDownloadStore.setState({ batch: next });

      showToast({
        group: "download-batch",
        kind: "info",
        title: `Скачиваю: ${label}`,
        message: `${next.done + next.failed} из ${next.total}`,
        timeout: 0,
      });
    }
  } finally {
    const result = useDownloadStore.getState().batch;
    useDownloadStore.setState({ batch: null });

    if (result && result.total > 0) {
      showToast({
        group: "download-batch",
        kind: result.failed === 0 ? "success" : "info",
        title:
          result.failed === 0
            ? `${result.label} — всё скачано`
            : `${result.label} — готово`,
        message:
          result.failed === 0
            ? `${result.done} треков в папке загрузок`
            : `${result.done} скачано, ${result.failed} с ошибкой`,
        timeout: 6000,
        action: {
          label: "Открыть папку",
          onClick: () => void window.electronAPI?.openPath?.("downloads"),
        },
      });
    }
  }
}

// --- Уже скачанные треки ---------------------------------------------------

/** Пачка треков, которую собрал `probeDownloadedTrack` и ждёт проверки. */
const probePending = new Map<number, { id: number; title: string; artist: string }>();
let probeTimer: number | null = null;

/** Одна проверка папки загрузок на всю пачку строк списка. */
function flushProbe(): void {
  probeTimer = null;
  const list = [...probePending.values()];
  probePending.clear();
  if (list.length === 0) return;

  void window.electronAPI
    ?.findDownloads?.(list)
    .then((result) => {
      const entries = Object.entries(result ?? {});
      if (entries.length === 0) return;

      const known = { ...useDownloadStore.getState().known };
      for (const [id, path] of entries) {
        known[Number(id)] = path;
      }
      useDownloadStore.setState({ known });
    })
    .catch(() => {});
}

/**
 * Отмечает трек для проверки «не скачан ли он уже».
 *
 * Строки списка вызывают её при появлении; запросы собираются в пачку
 * и уходят одним вызовом — сотня строк не означает сотню обращений к диску.
 */
export function probeDownloadedTrack(track: SCTrack): void {
  if (!track.id || !track.title) return;
  if (useDownloadStore.getState().known[track.id]) return;

  probePending.set(track.id, {
    id: track.id,
    title: track.title,
    artist: track.user?.username ?? "",
  });

  if (probeTimer === null) {
    probeTimer = window.setTimeout(flushProbe, 100);
  }
}

/** Путь к скачанному файлу трека — или null, если он ещё не скачан. */
export function useDownloadedTrack(track: SCTrack): string | null {
  const path = useDownloadStore((s) => s.known[track.id]);

  useEffect(() => {
    probeDownloadedTrack(track);
    // Проверяем один раз на трек: результат приходит в стор.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  return path ?? null;
}

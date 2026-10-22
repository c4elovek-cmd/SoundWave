import { create } from "zustand";
import { showToast } from "./toastStore";

/** Состояние скачивания одного трека. */
export interface DownloadInfo {
  percent: number;
  state: "started" | "progress" | "done" | "error";
  error?: string;
  path?: string;
}

interface DownloadState {
  /** Прогресс по id трека. */
  downloads: Record<number, DownloadInfo>;
  setInfo: (trackId: number, info: DownloadInfo) => void;
  clear: (trackId: number) => void;
}

export const useDownloadStore = create<DownloadState>((set) => ({
  downloads: {},
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
    useDownloadStore.getState().setInfo(info.trackId, {
      percent: info.percent,
      state: info.state as DownloadInfo["state"],
      error: info.error,
      path: info.path,
    });

    if (info.state === "done") {
      showToast({
        kind: "success",
        title: "Трек скачан",
        message: info.path,
        // Плашка живёт, пока не закроют: файл можно открыть в любой момент.
        timeout: 0,
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
      showToast({
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

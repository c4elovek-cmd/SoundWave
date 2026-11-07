/**
 * Саундпад — сохранённые песни и фрагменты для мгновенного запуска.
 *
 * Звуки живут в отдельной папке приложения (бэкенд `soundpad_save`),
 * список — в localStorage. Проигрывание идёт своим аудио-элементом
 * поверх основного плеера: музыка не прерывается, как в настоящем
 * саундпаде. Клик по поду включает звук, повторный клик останавливает.
 */

import { create } from "zustand";
import { localFileUrl } from "../lib/localFiles";
import { logAction } from "../lib/actionLog";
import { showToast } from "./toastStore";

export interface SoundpadEntry {
  id: string;
  /** Название пада — редактируется на странице. */
  name: string;
  artist: string;
  /** Трек-источник на SoundCloud, если звук оттуда. */
  trackId: number | null;
  kind: "track" | "fragment";
  /** Локальный mp3 в папке саундпада. */
  path: string;
  /** Длительность звука в секундах. */
  duration: number;
  /** Границы фрагмента в исходном треке, секунды. */
  start?: number;
  end?: number;
  artworkUrl?: string;
  createdAt: number;
}

interface SoundpadState {
  entries: SoundpadEntry[];
  volume: number;
  /** Какой пад звучит прямо сейчас. */
  playingId: string | null;
  /** Прогресс играющего пада, 0–1. */
  progress: number;
  add: (entry: SoundpadEntry) => void;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => void;
  setVolume: (value: number) => void;
  /** Клик по поду: включить, либо остановить, если уже играет. */
  play: (id: string) => void;
  stop: () => void;
}

const STORAGE_KEY = "sw-soundpad";

function loadPersisted(): { entries: SoundpadEntry[]; volume: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { entries: [], volume: 0.9 };
    const parsed = JSON.parse(raw) as Partial<{
      entries: SoundpadEntry[];
      volume: number;
    }>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      volume: typeof parsed.volume === "number" ? parsed.volume : 0.9,
    };
  } catch {
    return { entries: [], volume: 0.9 };
  }
}

function persist(entries: SoundpadEntry[], volume: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, volume }));
  } catch {
    // Переполненное хранилище не должно ронять приложение.
  }
}

// Один аудио-элемент на весь саундпад: поды не звучат одновременно.
let audio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = "auto";
  }
  return audio;
}

export const useSoundpadStore = create<SoundpadState>((set, get) => ({
  ...loadPersisted(),
  playingId: null,
  progress: 0,

  add: (entry) => {
    const entries = [entry, ...get().entries];
    persist(entries, get().volume);
    set({ entries });
    logAction("soundpad.add", {
      kind: entry.kind,
      name: entry.name,
      duration: Math.round(entry.duration),
    });
  },

  remove: async (id) => {
    const entry = get().entries.find((item) => item.id === id);
    if (!entry) return;

    if (get().playingId === id) get().stop();

    // Файл чистим на диске; если его уже нет — не страшно.
    try {
      await window.electronAPI?.soundpadDelete?.(entry.path);
    } catch {
      // Список всё равно обновляем: звук больше не нужен.
    }

    const entries = get().entries.filter((item) => item.id !== id);
    persist(entries, get().volume);
    set({ entries });
    logAction("soundpad.remove", { name: entry.name });
  },

  rename: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const entries = get().entries.map((item) =>
      item.id === id ? { ...item, name: trimmed } : item
    );
    persist(entries, get().volume);
    set({ entries });
  },

  setVolume: (value) => {
    const volume = Math.min(1, Math.max(0, value));
    if (audio) audio.volume = volume;
    persist(get().entries, volume);
    set({ volume });
  },

  play: (id) => {
    const state = get();
    if (state.playingId === id) {
      state.stop();
      return;
    }

    const entry = state.entries.find((item) => item.id === id);
    if (!entry) return;

    const element = ensureAudio();
    element.onended = () => set({ playingId: null, progress: 0 });
    element.ontimeupdate = () => {
      const total = element.duration;
      if (Number.isFinite(total) && total > 0) {
        set({ progress: element.currentTime / total });
      }
    };
    element.onerror = () => {
      set({ playingId: null, progress: 0 });
      showToast({
        kind: "error",
        title: "Звук не найден",
        message: "Файл удалён с диска — добавьте звук заново",
        timeout: 5000,
      });
    };

    element.src = localFileUrl(entry.path);
    element.volume = state.volume;
    element.currentTime = 0;
    set({ playingId: id, progress: 0 });
    logAction("soundpad.play", { name: entry.name, kind: entry.kind });

    void element.play().catch(() => {
      set({ playingId: null, progress: 0 });
      showToast({
        kind: "error",
        title: "Не удалось воспроизвести звук",
        timeout: 4000,
      });
    });
  },

  stop: () => {
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
    }
    set({ playingId: null, progress: 0 });
  },
}));

/** Новый id пада: время + случайный хвост, без внешних зависимостей. */
export function soundpadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
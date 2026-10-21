import { create } from "zustand";
import { SCTrack } from "../types/soundcloud";
import { errorText } from "../lib/errorText";

export interface LyricsResult {
  found: boolean;
  title?: string;
  artist?: string;
  url?: string;
  lyrics?: string;
  error?: string;
}

export interface SyncedLyricsResult {
  found: boolean;
  syncedLyrics?: string;
  title?: string;
  artist?: string;
  duration?: number;
  error?: string;
}

interface CacheEntry extends LyricsResult {
  savedAt: number;
}

type LyricsCache = Record<string, CacheEntry>;

interface LyricsState {
  loading: boolean;
  trackId: number | null;
  result: LyricsResult | null;
  error: string | null;
  synced: SyncedLyricsResult | null;
  syncLoading: boolean;
  syncTrackId: number | null;
  load: (track: SCTrack | null) => Promise<void>;
  loadSynced: (track: SCTrack | null) => Promise<void>;
}

const CACHE_KEY = "sw-lyrics-cache";
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 100;

function readCache(): LyricsCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LyricsCache) : {};
  } catch {
    return {};
  }
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.savedAt < CACHE_TTL;
}

function saveCache(cache: LyricsCache) {
  const entries = Object.entries(cache)
    .filter(([, entry]) => isFresh(entry))
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, CACHE_LIMIT);

  const trimmed = Object.fromEntries(entries);

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // Место в localStorage закончилось — оставляем хотя бы последние тексты.
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, 20))));
    } catch {
      // Совсем не смогли сохранить — текст всё равно уже показан.
    }
  }
}

// Номер последнего запроса: если пользователь быстро переключил трек,
// ответ по старому треку не должен перетереть новый.
let requestId = 0;

/**
 * Ключ кэша текстов — по названию и артисту, а не по id трека.
 *
 * Треки часто перезаливают: у копии новый id, а песня та же. С таким
 * ключом текст для перезалива берётся из кэша, а не ищется заново.
 */
function lyricsKey(track: SCTrack): string {
  const title = (track.title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const artist = (track.user?.username ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `${title}|${artist}`;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  loading: false,
  trackId: null,
  result: null,
  error: null,
  synced: null,
  syncLoading: false,
  syncTrackId: null,

  load: async (track) => {
    if (!track?.id) {
      set({ loading: false, trackId: null, result: null, error: null });
      return;
    }

    // При смене трека старые тайминги караоке больше не актуальны.
    if (get().trackId !== track.id) {
      set({ synced: null, syncTrackId: null, syncLoading: false });
    }

    const cached = readCache()[lyricsKey(track)];
    if (cached && isFresh(cached)) {
      set({
        trackId: track.id,
        loading: false,
        result: cached,
        error: cached.found ? null : cached.error ?? "Текст не найден на Genius",
      });
      return;
    }

    requestId += 1;
    const currentRequest = requestId;

    set({ trackId: track.id, loading: true, result: null, error: null });

    try {
      if (!window.electronAPI?.getLyrics) {
        throw new Error("Мост к Electron недоступен");
      }

      const response = await window.electronAPI.getLyrics(
        track.title,
        track.user?.username ?? "",
        track.description ?? ""
      );

      if (currentRequest !== requestId) return;

      if (response.found) {
        set({ loading: false, result: response, error: null });
      } else {
        set({
          loading: false,
          result: response,
          error: response.error ?? "Текст не найден на Genius",
        });
      }

      // Ошибки сети не кэшируем — при следующем открытии попробуем снова.
      if (!response.error) {
        const cache = readCache();
        cache[lyricsKey(track)] = { ...response, savedAt: Date.now() };
        saveCache(cache);
      }
    } catch (e) {
      if (currentRequest !== requestId) return;
      set({
        loading: false,
        result: null,
        error: errorText(e, "Не удалось загрузить текст"),
      });
    }
  },

  loadSynced: async (track) => {
    if (!track?.id) return;

    const state = get();
    if (state.syncTrackId === track.id) return;

    set({ syncTrackId: track.id, syncLoading: true, synced: null });

    try {
      if (!window.electronAPI?.getSyncedLyrics) {
        throw new Error("Мост к Electron недоступен");
      }

      const response = await window.electronAPI.getSyncedLyrics(
        track.title,
        track.user?.username ?? "",
        track.duration ?? 0
      );

      if (get().trackId !== track.id) return;
      set({ synced: response, syncLoading: false });
    } catch {
      if (get().trackId !== track.id) return;
      // Не страшно: панель разложит строки по длительности сама.
      set({ synced: { found: false }, syncLoading: false });
    }
  },
}));

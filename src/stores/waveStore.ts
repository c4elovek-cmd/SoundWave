/**
 * Состояние «Моей волны».
 *
 * Очередь волны живёт в playerStore — здесь только настройки, история
 * прослушанного и дизлайки. Когда плеер доходит до конца очереди, он
 * вызывает refill() и дописывает новую порцию.
 */

import { create } from "zustand";
import { SCTrack } from "../types/soundcloud";
import { collectWaveCandidates, loadWaveSeed, WaveMode, WaveSeed } from "../lib/wave";
import { logAction } from "../lib/actionLog";
import { usePlayerStore } from "./playerStore";

const MODE_KEY = "sw-wave-mode";
const PLAYED_KEY = "sw-wave-played";
const DISLIKED_KEY = "sw-wave-disliked";
const ARTIST_SCORES_KEY = "sw-wave-artist-scores";

const MAX_PLAYED = 300;
const MAX_DISLIKED = 500;
/** После двух дизлайков артист перестаёт попадать в волну */
const ARTIST_LIMIT = 2;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage может быть недоступен — не критично */
  }
}

function loadMode(): WaveMode {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === "familiar" || stored === "mixed" || stored === "fresh" ? stored : "mixed";
}

function loadNumberArray(key: string, limit: number): number[] {
  const value = readJson<unknown>(key, []);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => typeof id === "number").slice(-limit);
}

function loadArtistScores(): Record<number, number> {
  const value = readJson<Record<string, number>>(ARTIST_SCORES_KEY, {});
  const result: Record<number, number> = {};

  for (const [key, score] of Object.entries(value)) {
    const id = Number(key);
    if (Number.isFinite(id) && typeof score === "number" && score > 0) result[id] = score;
  }

  return result;
}

function blockedArtists(scores: Record<number, number>): Set<number> {
  return new Set(
    Object.entries(scores)
      .filter(([, score]) => score >= ARTIST_LIMIT)
      .map(([id]) => Number(id))
  );
}

interface WaveState {
  active: boolean;
  loading: boolean;
  mode: WaveMode;
  seed: WaveSeed | null;
  /** id треков, которые уже играли */
  played: number[];
  disliked: number[];
  /** сколько раз дизлайкнули треки каждого артиста */
  artistScores: Record<number, number>;
  error: string | null;

  start: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => void;
  setMode: (mode: WaveMode) => void;
  dislike: (track: SCTrack) => void;
  refill: () => Promise<SCTrack[]>;
  resetHistory: () => void;
}

export const useWaveStore = create<WaveState>((set, get) => ({
  active: false,
  loading: false,
  mode: loadMode(),
  seed: null,
  played: loadNumberArray(PLAYED_KEY, MAX_PLAYED),
  disliked: loadNumberArray(DISLIKED_KEY, MAX_DISLIKED),
  artistScores: loadArtistScores(),
  error: null,

  start: async () => {
    if (get().loading) return;

    logAction("wave.start", { mode: get().mode });
    set({ loading: true, error: null });

    try {
      const seed = await loadWaveSeed();

      if (seed.likes.length === 0 && seed.followings.length === 0) {
        set({
          loading: false,
          error: "Поставь несколько лайков или подпишись на артистов — и волна соберётся сама.",
        });
        return;
      }

      set({ seed });

      const { played, disliked, artistScores, mode } = get();
      const tracks = await collectWaveCandidates({
        seed,
        mode,
        exclude: new Set([...played, ...disliked]),
        blockedArtists: blockedArtists(artistScores),
        limit: 14,
      });

      if (tracks.length === 0) {
        set({
          loading: false,
          error: "Не удалось собрать волну. Попробуй ещё раз — SoundCloud мог не ответить.",
        });
        return;
      }

      const player = usePlayerStore.getState();
      player.setRefill(() => useWaveStore.getState().refill());
      player.play(tracks[0], tracks, 0);
      set({ active: true, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "Не удалось собрать волну",
      });
    }
  },

  restart: async () => {
    logAction("wave.restart");
    usePlayerStore.getState().setRefill(null);
    set({ active: false });
    await get().start();
  },

  stop: () => {
    logAction("wave.stop");
    const player = usePlayerStore.getState();
    player.setRefill(null);
    player.pause();
    set({ active: false });
  },

  setMode: (mode) => {
    logAction("wave.mode", { mode });
    localStorage.setItem(MODE_KEY, mode);
    set({ mode });
  },

  dislike: (track) => {
    if (!track) return;

    logAction("wave.dislike", { id: track.id, artist: track.user?.username });

    const disliked = [...new Set([...get().disliked, track.id])].slice(-MAX_DISLIKED);
    const artistScores = { ...get().artistScores };
    const artistId = track.user?.id;

    if (artistId) artistScores[artistId] = (artistScores[artistId] ?? 0) + 1;

    writeJson(DISLIKED_KEY, disliked);
    writeJson(ARTIST_SCORES_KEY, artistScores);
    set({ disliked, artistScores });

    // Убираем трек из того, что ещё не сыграло
    const player = usePlayerStore.getState();
    if (player.currentTrack?.id === track.id) {
      player.next();
    } else {
      player.removeTrackById(track.id);
    }
  },

  refill: async () => {
    const { seed, mode, played, disliked, artistScores } = get();
    if (!seed) return [];

    const player = usePlayerStore.getState();
    const inQueue = new Set(player.queue.map((track) => track.id));

    return collectWaveCandidates({
      seed,
      mode,
      exclude: new Set([...played, ...disliked, ...inQueue]),
      blockedArtists: blockedArtists(artistScores),
      limit: 12,
    });
  },

  resetHistory: () => {
    writeJson(PLAYED_KEY, []);
    writeJson(DISLIKED_KEY, []);
    writeJson(ARTIST_SCORES_KEY, {});
    set({ played: [], disliked: [], artistScores: {} });
  },
}));

/**
 * История прослушанного.
 *
 * Нужна, чтобы волна не предлагала одно и то же. Пишем её при любой смене
 * трека в плеере, а не только во время волны: иначе после ручного
 * прослушивания волна снова подсунет те же треки.
 */
usePlayerStore.subscribe((state, prev) => {
  const id = state.currentTrack?.id;
  const prevId = prev.currentTrack?.id;

  if (!id || id === prevId || !state.isPlaying) return;

  const { played } = useWaveStore.getState();
  if (played.includes(id)) return;

  const next = [...played, id].slice(-MAX_PLAYED);
  writeJson(PLAYED_KEY, next);
  useWaveStore.setState({ played: next });
});

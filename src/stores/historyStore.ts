import { create } from "zustand";
import { SCTrack } from "../types/soundcloud";
import { usePlayerStore } from "./playerStore";

/**
 * История прослушиваний — что реально играло.
 *
 * Пишется автоматически при смене трека в плеере, хранится в localStorage
 * и переживает перезапуск. На главной из неё собрана полка «Недавно слушал»
 * и «Похоже на то, что ты любишь» (related берётся от последнего трека).
 */

const KEY = "sw-listening-history";
const MAX = 40;

interface HistoryState {
  tracks: SCTrack[];
  record: (track: SCTrack) => void;
}

function read(): SCTrack[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as SCTrack[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  tracks: read(),

  record: (track) => {
    const current = get().tracks;

    // Повтор одного и того же трека подряд историю не засоряет.
    if (current[0]?.id === track.id) return;

    const next = [track, ...current.filter((t) => t.id !== track.id)].slice(0, MAX);
    set({ tracks: next });

    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Переполнен localStorage — не страшно, история не критична.
    }
  },
}));

// Записываем трек, когда он действительно начал играть.
let lastRecorded: number | null = null;
usePlayerStore.subscribe((state) => {
  const track = state.currentTrack;
  if (track && state.isPlaying && track.id !== lastRecorded) {
    lastRecorded = track.id;
    useHistoryStore.getState().record(track);
  }
});

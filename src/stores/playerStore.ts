import { create } from "zustand";
import { SCTrack, RepeatMode } from "../types/soundcloud";
import { Howl } from "howler";

interface PlayerState {
  // Состояние
  currentTrack: SCTrack | null;
  queue: SCTrack[];
  queueIndex: number;
  isPlaying: boolean;
  progress: number; // 0-1
  duration: number; // мс
  volume: number; // 0-1
  isMuted: boolean;
  repeat: RepeatMode;
  isShuffled: boolean;

  // Howl instance
  howl: Howl | null;

  // Actions
  play: (track: SCTrack, queue?: SCTrack[], index?: number) => void;
  pause: () => void;
  resume: () => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (progress: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  addToQueue: (track: SCTrack) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  setProgress: (p: number) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  isPlaying: false,
  progress: 0,
  duration: 0,
  volume: 0.8,
  isMuted: false,
  repeat: "off",
  isShuffled: false,
  howl: null,

  play: (track, queue = [], index = 0) => {
    const { howl: oldHowl } = get();
    if (oldHowl) {
      oldHowl.unload();
    }

    // Заглушка URL — потом заменим на реальный из API
    const streamUrl = track.stream_url || `https://api.soundcloud.com/tracks/${track.id}/stream?client_id=YOUR_CLIENT_ID`;

    const newHowl = new Howl({
      src: [streamUrl],
      html5: true,
      volume: get().volume,
      onplay: () => {
        set({ isPlaying: true });
      },
      onpause: () => {
        set({ isPlaying: false });
      },
      onend: () => {
        const { repeat, next } = get();
        if (repeat === "one") {
          get().seek(0);
          newHowl.play();
        } else {
          next();
        }
      },
      onload: () => {
        set({ duration: newHowl.duration() * 1000 });
      },
      onloaderror: (_id, err) => {
        console.error("Ошибка загрузки трека:", err);
        set({ isPlaying: false });
      },
    });

    newHowl.play();

    set({
      currentTrack: track,
      queue: queue.length > 0 ? queue : [track],
      queueIndex: index,
      howl: newHowl,
      progress: 0,
    });
  },

  pause: () => {
    const { howl } = get();
    howl?.pause();
    set({ isPlaying: false });
  },

  resume: () => {
    const { howl } = get();
    howl?.play();
    set({ isPlaying: true });
  },

  togglePlay: () => {
    const { isPlaying, resume, pause } = get();
    if (isPlaying) pause();
    else resume();
  },

  next: () => {
    const { queue, queueIndex, repeat, isShuffled, play } = get();
    if (queue.length === 0) return;

    let nextIndex: number;

    if (isShuffled) {
      nextIndex = Math.floor(Math.random() * queue.length);
    } else if (queueIndex < queue.length - 1) {
      nextIndex = queueIndex + 1;
    } else if (repeat === "all") {
      nextIndex = 0;
    } else {
      return; // конец очереди
    }

    const nextTrack = queue[nextIndex];
    play(nextTrack, queue, nextIndex);
  },

  prev: () => {
    const { queue, queueIndex, progress, currentTrack, play } = get();
    if (queue.length === 0) return;

    // Если прошло > 3 сек — рестарт, иначе предыдущий
    if (progress > 0.03) {
      get().seek(0);
    } else if (queueIndex > 0) {
      const prevTrack = queue[queueIndex - 1];
      play(prevTrack, queue, queueIndex - 1);
    } else {
      get().seek(0);
    }
  },

  seek: (progress: number) => {
    const { howl, duration } = get();
    if (!howl) return;
    howl.seek(progress * duration);
    set({ progress });
  },

  setVolume: (vol: number) => {
    const { howl, isMuted } = get();
    if (howl && !isMuted) {
      howl.volume(vol);
    }
    set({ volume: vol });
    window.electronAPI?.setVolume(vol);
  },

  toggleMute: () => {
    const { howl, isMuted, volume } = get();
    if (howl) {
      howl.mute(isMuted);
    }
    set({ isMuted: !isMuted });
  },

  setRepeat: (mode: RepeatMode) => {
    set({ repeat: mode });
  },

  toggleShuffle: () => {
    set((state) => ({ isShuffled: !state.isShuffled }));
  },

  addToQueue: (track) => {
    set((state) => ({ queue: [...state.queue, track] }));
  },

  removeFromQueue: (index) => {
    set((state) => ({
      queue: state.queue.filter((_, i) => i !== index),
      queueIndex: state.queueIndex > index ? state.queueIndex - 1 : state.queueIndex,
    }));
  },

  clearQueue: () => {
    set({ queue: [] });
  },

  setProgress: (p) => set({ progress: p }),
}));
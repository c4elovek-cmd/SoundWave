import { create } from "zustand";
import { SCTrack, RepeatMode } from "../types/soundcloud";
import Hls from "hls.js";
import { scApi } from "../lib/soundcloud-api";

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
  error: string | null;
  /**
   * Источник новых треков, когда очередь кончилась.
   * Волна ставит сюда свой refill; null — очередь конечна.
   */
  refill: (() => Promise<SCTrack[]>) | null;
  /** идёт доливка очереди — защита от повторного запуска */
  refilling: boolean;

  // Элемент воспроизведения и HLS-плеер
  audio: HTMLAudioElement | null;
  hls: Hls | null;

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
  removeTrackById: (trackId: number) => void;
  clearQueue: () => void;
  setRefill: (fn: (() => Promise<SCTrack[]>) | null) => void;
  setProgress: (p: number) => void;
  setError: (message: string | null) => void;
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
  audio: null,
  hls: null,
  error: null,
  refill: null,
  refilling: false,

  play: async (track, queue = [], index = 0) => {
    // Гасим предыдущий поток
    const prevHls = get().hls;
    const prevAudio = get().audio;
    if (prevHls) {
      prevHls.destroy();
      set({ hls: null });
    }
    if (prevAudio) {
      prevAudio.pause();
      prevAudio.removeAttribute("src");
      prevAudio.load();
    }

    set({
      currentTrack: track,
      queue: queue.length > 0 ? queue : [track],
      queueIndex: index,
      progress: 0,
      duration: 0,
      error: null,
    });

    // Ссылка на аудио живёт в подписанном CDN-URL, который выдаёт SoundCloud
    // по манифесту потока. Поле track.stream_url ведёт на api-v2 и без
    // client_id отдаёт 404, поэтому его использовать нельзя.
    let src = "";
    let protocol = "progressive";
    try {
      const stream = await scApi.getStreamUrl(track.id);
      src = stream.url;
      protocol = stream.protocol;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Не удалось получить ссылку на трек";
      set({ error: message, isPlaying: false });
      console.error("Ошибка подготовки трека:", e);
      return;
    }

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = get().volume;
    audio.muted = get().isMuted;

    const start = () => {
      void audio.play().catch((e) => {
        console.error("Не удалось запустить воспроизведение:", e);
        set({ isPlaying: false });
      });
    };

    // SoundCloud отдаёт потоки в HLS (m3u8 + fMP4/AAC). Chromium не играет
    // HLS нативно, поэтому подключаем hls.js через MediaSource.
    const isHls = protocol === "hls" || src.includes(".m3u8");

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false, lowLatencyMode: false });

      hls.on(Hls.Events.MANIFEST_PARSED, start);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        console.error("Ошибка HLS:", data.type, data.details);

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          set({ error: "Не удалось загрузить аудио", isPlaying: false });
        }
      });

      hls.loadSource(src);
      hls.attachMedia(audio);
      set({ hls });
    } else {
      audio.src = src;
      audio.addEventListener("canplay", start, { once: true });
    }

    audio.addEventListener("loadedmetadata", () => {
      set({ duration: (audio.duration || 0) * 1000 });
    });

    audio.addEventListener("timeupdate", () => {
      const d = audio.duration || 0;
      if (d > 0) set({ progress: audio.currentTime / d });
    });

    audio.addEventListener("play", () => set({ isPlaying: true, error: null }));
    audio.addEventListener("pause", () => set({ isPlaying: false }));

    audio.addEventListener("ended", () => {
      const { repeat, next } = get();
      if (repeat === "one") {
        audio.currentTime = 0;
        start();
      } else {
        next();
      }
    });

    audio.addEventListener("error", () => {
      console.error("Ошибка воспроизведения");
      set({ error: "Не удалось загрузить аудио", isPlaying: false });
    });

    set({ audio });
  },

  pause: () => {
    get().audio?.pause();
    set({ isPlaying: false });
  },

  resume: () => {
    const { audio } = get();
    if (!audio) return;
    void audio.play().catch(() => set({ isPlaying: false }));
    set({ isPlaying: true });
  },

  togglePlay: () => {
    const { isPlaying, resume, pause } = get();
    if (isPlaying) pause();
    else resume();
  },

  next: () => {
    const { queue, queueIndex, repeat, isShuffled, play, refill } = get();
    if (queue.length === 0) return;

    let nextIndex: number;

    if (isShuffled) {
      nextIndex = Math.floor(Math.random() * queue.length);
    } else if (queueIndex < queue.length - 1) {
      nextIndex = queueIndex + 1;
    } else if (repeat === "all") {
      nextIndex = 0;
    } else if (refill) {
      // Очередь кончилась, но волна ещё идёт — доливаем следующую порцию
      if (get().refilling) return;
      set({ refilling: true });

      void (async () => {
        let more: SCTrack[] = [];

        try {
          more = await refill();
        } catch (e) {
          console.error("Не удалось долить очередь:", e);
          set({ refilling: false });
          return;
        }

        if (more.length === 0) {
          set({ refilling: false });
          return;
        }

        const current = get();
        const grown = [...current.queue, ...more];
        set({ queue: grown, refilling: false });
        void current.play(grown[current.queueIndex + 1], grown, current.queueIndex + 1);
      })();

      return;
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
    const { audio, duration } = get();
    if (!audio) return;
    const total = duration / 1000;
    if (total <= 0) return;
    audio.currentTime = Math.max(0, Math.min(total - 0.1, progress * total));
    set({ progress });
  },

  setVolume: (vol: number) => {
    const { audio, isMuted } = get();
    if (audio && !isMuted) {
      audio.volume = vol;
    }
    set({ volume: vol });
    window.electronAPI?.setVolume(vol);
  },

  toggleMute: () => {
    const { audio, isMuted } = get();
    if (audio) {
      audio.muted = !isMuted;
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

  removeFromQueue: (index: number) => {
    set((state) => ({
      queue: state.queue.filter((_, i) => i !== index),
      queueIndex: state.queueIndex > index ? state.queueIndex - 1 : state.queueIndex,
    }));
  },

  /**
   * Убирает трек из очереди по id — используется дизлайком в волне.
   * Текущий трек не трогаем: его сменой занимается вызывающий.
   */
  removeTrackById: (trackId) => {
    set((state) => {
      const index = state.queue.findIndex((track) => track.id === trackId);
      if (index === -1) return state;

      return {
        queue: state.queue.filter((track) => track.id !== trackId),
        queueIndex: index < state.queueIndex ? state.queueIndex - 1 : state.queueIndex,
      };
    });
  },

  clearQueue: () => {
    set({ queue: [] });
  },

  setRefill: (fn) => {
    set({ refill: fn, refilling: false });
  },

  setProgress: (p: number) => set({ progress: p }),

  setError: (error: string | null) => set({ error }),
}));

import { create } from "zustand";
import { SCTrack, RepeatMode } from "../types/soundcloud";
import Hls from "hls.js";
import { scApi } from "../lib/soundcloud-api";
import { logAction } from "../lib/actionLog";
import { errorText } from "../lib/errorText";

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
  play: (
    track: SCTrack,
    queue?: SCTrack[],
    index?: number,
    options?: { allowDrm?: boolean }
  ) => void;
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
  /**
   * Номер текущей попытки включения. Любое действие пользователя
   * увеличивает его — тогда запоздавший ответ сети не запустит трек,
   * который уже остановили.
   */
  playToken: number;
  /** Пользователь хочет слышать звук (пауза сбрасывает флаг). */
  shouldPlay: boolean;
  /** Трек ожидает восстановления сети для продолжения воспроизведения */
  waitingForNetwork: boolean;
  /** Сохранённая позиция воспроизведения при обрыве связи (в секундах) */
  savedTimeOnDisconnect: number;
  /** Обработка перехода в оффлайн */
  handleNetworkOffline: () => void;
  /** Обработка восстановления соединения */
  handleNetworkOnline: () => void;
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
  playToken: 0,
  shouldPlay: false,
  waitingForNetwork: false,
  savedTimeOnDisconnect: 0,

  play: async (track, queue = [], index = 0, options) => {
    // Треки с DRM браузер не играет: у SoundCloud для них только
    // зашифрованные потоки. В обычных списках их пропускаем, в «Моей
    // волне» оставляем — там пользователь сам решает.
    const allowDrm = options?.allowDrm ?? false;

    if (track.drm && !allowDrm) {
      set({
        error: "Трек защищён DRM — звук недоступен",
        isPlaying: false,
      });
      logAction("skip_drm", { id: track.id, title: track.title });
      return;
    }

    // Нов�� попытка включения: всё, что придёт по старому токену, игнорируем.
    const token = get().playToken + 1;
    set({ playToken: token, shouldPlay: true });

    logAction("play", {
      id: track.id,
      title: track.title,
      artist: track.user?.username,
      queue: queue.length,
      index,
    });

    // Из очереди DRM-треки тоже убираем — иначе следующий трек не заиграет.
    let nextQueue = queue;
    let nextIndex = index;

    if (!allowDrm && queue.some((item) => item.drm)) {
      nextQueue = queue.filter((item) => !item.drm);
      const found = nextQueue.findIndex((item) => item.id === track.id);
      nextIndex = found >= 0 ? found : 0;
    }

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
      set({ audio: null });
    }

    set({
      currentTrack: track,
      queue: nextQueue.length > 0 ? nextQueue : [track],
      queueIndex: nextIndex,
      progress: 0,
      duration: 0,
      error: null,
    });

    // Защита от потери интернета: если сети нет прямо сейчас,
    // запоминаем трек и ставим в режим ожидания сети
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      set({
        isPlaying: false,
        shouldPlay: true,
        waitingForNetwork: true,
        error: "Ожидание сети: трек начнёт играть автоматически при подключении",
      });
      return;
    }

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
      const message = errorText(e, "Не удалось получить ссылку на трек");
      const isNet =
        message.includes("интернет") ||
        (typeof navigator !== "undefined" && !navigator.onLine);
      set({
        error: isNet
          ? "Ожидание сети: трек начнёт играть автоматически при подключении"
          : message,
        isPlaying: false,
        waitingForNetwork: isNet,
      });
      console.error("Ошибка подготовки трека:", e);
      return;
    }

    // Пока шёл запрос, пользователь мог нажать паузу или включить другой трек.
    if (get().playToken !== token) return;

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = get().volume;
    audio.muted = get().isMuted;

    const start = () => {
      // Трек могли остановить, пока грузился поток.
      if (get().playToken !== token || !get().shouldPlay) return;

      void audio.play().catch((e) => {
        console.error("Не удалось запустить воспроизведение:", e);
        if (get().playToken === token) set({ isPlaying: false });
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

        // Не отдаётся ключ шифрования: у SoundCloud такие треки закрыты DRM
        // (FairPlay или Common Encryption). Браузер их не расшифровывает,
        // и повторные попытки только сыпят ошибками — говорим честно.
        if (data.details === "keyLoadError" || data.details === "keyLoadTimeOut") {
          hls.destroy();
          set({
            error: "Трек защищён DRM — звук недоступен",
            isPlaying: false,
            hls: null,
          });
          return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            console.warn("HLS сетевой сбой: нет интернета, ожидаем восстановление...");
            set({
              waitingForNetwork: true,
              error: "Ожидание подключения к интернету...",
              isPlaying: false,
            });
            return;
          }
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
      if (d > 0) {
        set({
          progress: audio.currentTime / d,
          savedTimeOnDisconnect: audio.currentTime,
        });
      }
    });

    audio.addEventListener("waiting", () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        set({
          waitingForNetwork: true,
          error: "Ожидание подключения к интернету...",
        });
      }
    });

    audio.addEventListener("stalled", () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        set({
          waitingForNetwork: true,
          error: "Ожидание подключения к интернету...",
        });
      }
    });

    audio.addEventListener("play", () => {
      if (get().playToken === token) {
        set({ isPlaying: true, error: null, waitingForNetwork: false });
      }
    });
    audio.addEventListener("pause", () => {
      if (get().playToken === token) set({ isPlaying: false });
    });

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
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        set({
          waitingForNetwork: true,
          isPlaying: false,
          error: "Воспроизведение приостановлено: ожидание сети...",
        });
      } else {
        set({ error: "Не удалось загрузить аудио", isPlaying: false });
      }
    });

    set({ audio });
  },

  pause: () => {
    const { audio } = get();
    // Увеличиваем токен: незавершённая загрузка трека отменится.
    logAction("pause", { id: get().currentTrack?.id });
    set({ isPlaying: false, shouldPlay: false, playToken: get().playToken + 1 });
    audio?.pause();
  },

  resume: () => {
    const { audio, currentTrack, queue, queueIndex } = get();

    logAction("resume", { id: currentTrack?.id });

    if (!audio) {
      // Трек ещё грузится или был остановлен — включаем заново.
      if (currentTrack) get().play(currentTrack, queue, queueIndex);
      return;
    }

    set({ shouldPlay: true });
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

    logAction("next", { id: get().currentTrack?.id });

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

        // Пока шёл запрос, волну могли остановить или поставить на паузу.
        // Тогда долитый трек включать нельзя — иначе музыка идёт сама.
        if (!get().refill || !get().shouldPlay) {
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

    logAction("prev", { id: currentTrack?.id, progress });

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

    logAction("seek", { ratio: Math.round(progress * 1000) / 1000, seconds: Math.round(progress * total) });

    audio.currentTime = Math.max(0, Math.min(total - 0.1, progress * total));
    set({ progress });
  },

  setVolume: (vol: number) => {
    const { audio, isMuted } = get();
    logAction("volume", { value: Math.round(vol * 100) / 100 });

    // Громкость и mute — независимые вещи: применяем громкость всегда,
    // иначе после размута звук остаётся на старом уровне.
    if (audio) {
      audio.volume = vol;

      // Громкость выше нуля снимает mute — иначе ползунок выглядит
      // «мёртвым»: значение меняется, а на экране всё равно ноль.
      if (isMuted && vol > 0) {
        audio.muted = false;
        set({ isMuted: false });
      }
    }

    set({ volume: vol });
    window.electronAPI?.setVolume(vol);
  },

  toggleMute: () => {
    const { audio, isMuted, volume } = get();
    logAction("mute", { muted: !isMuted });
    if (audio) {
      audio.muted = !isMuted;
      if (isMuted) audio.volume = volume;
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
    // В очередь DRM-треки не кладём: их всё равно нечем играть.
    if (track.drm) {
      set({ error: "Трек защищён DRM — в очередь его не добавить" });
      logAction("skip_drm", { id: track.id, title: track.title });
      return;
    }
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

  handleNetworkOffline: () => {
    const { isPlaying, audio } = get();
    if (isPlaying) {
      set({
        waitingForNetwork: true,
        savedTimeOnDisconnect: audio?.currentTime || get().savedTimeOnDisconnect,
      });
    }
  },

  handleNetworkOnline: () => {
    const {
      waitingForNetwork,
      currentTrack,
      queue,
      queueIndex,
      audio,
      hls,
      shouldPlay,
      savedTimeOnDisconnect,
    } = get();

    const hasNetworkError =
      get().error?.toLowerCase().includes("сет") ||
      get().error?.toLowerCase().includes("интернет");

    if (!waitingForNetwork && !hasNetworkError) {
      return;
    }

    logAction("network_resume_play", { id: currentTrack?.id });
    set({ waitingForNetwork: false, error: null });

    if (shouldPlay && currentTrack) {
      if (hls && audio) {
        hls.startLoad();
        void audio.play().catch(() => {
          get().play(currentTrack, queue, queueIndex);
        });
        set({ isPlaying: true });
      } else if (audio && audio.src && !audio.error) {
        void audio.play().catch(() => {
          get().play(currentTrack, queue, queueIndex);
        });
        set({ isPlaying: true });
      } else {
        get().play(currentTrack, queue, queueIndex);
        if (savedTimeOnDisconnect > 0) {
          setTimeout(() => {
            const d = (get().duration || 1) / 1000;
            if (d > 0) get().seek(savedTimeOnDisconnect / d);
          }, 600);
        }
      }
    }
  },
}));

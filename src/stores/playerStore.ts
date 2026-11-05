import { create } from "zustand";
import { SCTrack, RepeatMode } from "../types/soundcloud";
import Hls from "hls.js";
import { scApi } from "../lib/soundcloud-api";
import { localFileUrl } from "../lib/localFiles";
import { useDownloadStore } from "./downloadStore";
import { logAction } from "../lib/actionLog";
import { errorText } from "../lib/errorText";

/** Момент последнего обновления позиции, пока окно было скрыто. */
let lastHiddenSync = 0;

/**
 * Сколько треков должно остаться до конца очереди, чтобы начать
 * подтягивать следующую порцию. Два — запас на время запроса.
 */
const QUEUE_PREFETCH_AHEAD = 2;

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
  /**
   * Источник следующей страницы для очереди из обычного списка
   * (лайки, загрузки): страница ставит сюда загрузку `next_href`.
   * Тогда очередь растёт сама, без кнопки «Загрузить ещё».
   */
  queueLoader: (() => Promise<SCTrack[]>) | null;
  /** идёт доливка очереди — защита от повторного запуска */
  refilling: boolean;
  /** Источник очереди исчерпан: дальше треков нет, доливать нечего. */
  queueEnd: boolean;
  /**
   * Текущая очередь играет DRM-треки (волна). Держим на уровне стора,
   * чтобы `next()` знал, пропускать защищённые треки или играть их.
   */
  allowDrm: boolean;

  // Элемент воспроизведения и HLS-плеер
  audio: HTMLAudioElement | null;
  hls: Hls | null;

  // Actions
  play: (
    track: SCTrack,
    queue?: SCTrack[],
    index?: number,
    options?: { allowDrm?: boolean; localPath?: string }
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
  playNext: (track: SCTrack) => void;
  removeFromQueue: (index: number) => void;
  removeTrackById: (trackId: number) => void;
  clearQueue: () => void;
  setRefill: (fn: (() => Promise<SCTrack[]>) | null) => void;
  setQueueLoader: (fn: (() => Promise<SCTrack[]>) | null) => void;
  /**
   * Доливает очередь заранее — когда до конца остаётся пара треков.
   * Так музыка не обрывается на границе уже загруженного списка.
   */
  ensureQueueAhead: () => void;
  /** Подтянуть следующую порцию из источника очереди. */
  fetchMore: () => Promise<SCTrack[]>;
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
  queueLoader: null,
  refilling: false,
  queueEnd: false,
  allowDrm: false,
  playToken: 0,
  shouldPlay: false,
  waitingForNetwork: false,
  savedTimeOnDisconnect: 0,

  play: async (track, queue = [], index = 0, options) => {
    // Треки с DRM браузер не играет: у SoundCloud для них только
    // зашифрованные потоки. В обычных списках их пропускаем, в «Моей
    // волне» оставляем — там пользователь сам решает.
    // Скачанный файл снимает ограничение: локальный mp3 играет всегда.
    const allowDrm = options?.allowDrm ?? false;
    // Локальный файл — приоритетный источник: играет без сети и
    // начинается мгновенно. Явный путь из опций, метка на треке
    // или ранее найденный файл в папке загрузок.
    const localPath =
      options?.localPath ??
      track.localPath ??
      useDownloadStore.getState().known[track.id] ??
      null;

    if (track.drm && !allowDrm && !localPath) {
      set({
        error: "Трек защищён DRM — звук недоступен",
        isPlaying: false,
      });
      logAction("skip_drm", { id: track.id, title: track.title });
      return;
    }

    // Новая попытка включения: всё, что придёт по старому токену, игнорируем.
    const token = get().playToken + 1;
    // Новая очередь — значит, источник долива мог смениться: снимаем
    // отметку «источник исчерпан» и запоминаем режим DRM для `next()`.
    // Обычное воспроизведение (не из волны) снимает и долив волны: очередь
    // сменилась, и подмешивать волные треки в неё больше нельзя.
    set({
      playToken: token,
      shouldPlay: true,
      allowDrm,
      queueEnd: false,
      ...(allowDrm ? {} : { refill: null, refilling: false }),
    });

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

    // Скачанный файл играет с диска даже без сети: оффлайн-охрану
    // и запрос ссылки у SoundCloud пропускаем целиком.
    if (!localPath && typeof navigator !== "undefined" && !navigator.onLine) {
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
    let isLocal = false;

    if (localPath) {
      src = localFileUrl(localPath);
      isLocal = true;
      logAction("play_local", { id: track.id, title: track.title });
    } else {
      try {
        const stream = await scApi.getStreamUrl(track.id);
        src = stream.url;
        protocol = stream.protocol;
      } catch (e) {
        // Ссылку получить не удалось, но файл мог скачаться раньше —
        // тогда всё равно играем с диска.
        const fallback = await window.electronAPI
          ?.findDownload?.(track.title, track.user?.username ?? "")
          .catch(() => null);
        if (fallback?.found && fallback.path) {
          src = localFileUrl(fallback.path);
          isLocal = true;
          logAction("play_local_fallback", { id: track.id, title: track.title });
        } else {
          const message = errorText(e, "Не удалось получить ссылку на трек");
          const isNet =
            message.includes("интернет") ||
            message.includes("сеть") ||
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
      }
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
    // Локальный mp3 — обычный источник, HLS там не встречается.
    const isHls = !isLocal && (protocol === "hls" || src.includes(".m3u8"));

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
          console.warn("HLS сетевой сбой: повторяем загрузку потока");
          set({
            waitingForNetwork: true,
            error: "Связь прервалась. Повторяем загрузку…",
            isPlaying: false,
          });
          // HLS сам делает последовательные повторы; если сеть уже вернулась,
          // сразу продолжит загрузку. Глобальный online-listener разбудит его,
          // если браузер сообщил о полном отключении.
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
      if (d <= 0) return;

      // В скрытом окне ререндеры не видны, а ЦП тратится. Обновляем
      // позицию редко — savedTimeOnDisconnect нужен для восстановления
      // после обрыва сети, пяти секунд достаточно.
      const now = Date.now();
      if (document.hidden && now - lastHiddenSync < 5000) return;
      lastHiddenSync = now;

      set({
        progress: audio.currentTime / d,
        savedTimeOnDisconnect: audio.currentTime,
      });

      // Заранее доливаем очередь: к моменту, когда текущий трек доиграет,
      // следующие уже на месте и паузы на догрузку не будет.
      get().ensureQueueAhead();
    });

    audio.addEventListener("waiting", () => {
      if (!isLocal && typeof navigator !== "undefined" && !navigator.onLine) {
        set({
          waitingForNetwork: true,
          error: "Ожидание подключения к интернету...",
        });
      }
    });

    audio.addEventListener("stalled", () => {
      if (!isLocal && typeof navigator !== "undefined" && !navigator.onLine) {
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
      if (isLocal) {
        // Локальный файл: сети тут ни при чём — файл пропал или побился.
        set({
          isPlaying: false,
          error: "Не удалось воспроизвести скачанный файл",
        });
        return;
      }
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

    // Если включили трек ближе к концу списка — сразу подтягиваем дальше.
    get().ensureQueueAhead();
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

    // Нет сети — не дёргаем аудио вхолостую, показываем ожидание.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      set({
        shouldPlay: true,
        waitingForNetwork: true,
        isPlaying: false,
        error: "Ожидание сети: воспроизведение начнётся при подключении",
      });
      return;
    }

    if (!audio) {
      // Трек ещё грузится или был остановлен — включаем заново. Режим DRM
      // сохраняем: это перезапуск текущего трека, а не новая очередь, и
      // волну он останавливать не должен.
      if (currentTrack) get().play(currentTrack, queue, queueIndex, { allowDrm: get().allowDrm });
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
    const { queue, queueIndex, repeat, isShuffled, play, allowDrm } = get();
    if (queue.length === 0) return;

    logAction("next", { id: get().currentTrack?.id });

    // DRM-треки браузер не расшифровывает: в обычных списках их
    // пропускаем, иначе очередь встаёт на первом же защищённом треке.
    const playable = (track: SCTrack) => allowDrm || !track.drm;

    if (isShuffled) {
      const candidates = queue
        .map((_, index) => index)
        .filter((index) => playable(queue[index]));
      if (candidates.length === 0) return;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      play(queue[pick], queue, pick, { allowDrm });
      return;
    }

    // Ближайший играемый трек впереди.
    for (let index = queueIndex + 1; index < queue.length; index++) {
      if (playable(queue[index])) {
        play(queue[index], queue, index, { allowDrm });
        return;
      }
    }

    if (repeat === "all") {
      const first = queue.findIndex(playable);
      if (first >= 0) play(queue[first], queue, first, { allowDrm });
      return;
    }

    // Очередь кончилась. Если у неё есть источник (волна или следующая
    // страница списка) — доливаем и играем дальше, а не встаём.
    const startedWith = { id: get().currentTrack?.id, index: queueIndex };
    void (async () => {
      const more = await get().fetchMore();
      if (more.length === 0) return;

      // Пока шёл запрос, могло всё смениться: другой трек, пауза, стоп.
      const state = get();
      if (
        state.currentTrack?.id !== startedWith.id ||
        state.queueIndex !== startedWith.index ||
        !state.shouldPlay
      ) {
        return;
      }

      const offset = state.queue.length - more.length;
      for (let index = offset; index < state.queue.length; index++) {
        if (playable(state.queue[index])) {
          void state.play(state.queue[index], state.queue, index, { allowDrm });
          return;
        }
      }
    })();
  },

  prev: () => {
    const { queue, queueIndex, progress, currentTrack, play, allowDrm } = get();
    if (queue.length === 0) return;

    logAction("prev", { id: currentTrack?.id, progress });

    // Если прошло > 3 сек — рестарт, иначе предыдущий
    if (progress > 0.03) {
      get().seek(0);
      return;
    }

    // Назад тоже пропускаем DRM-треки: иначе воспроизведение встанет.
    for (let index = queueIndex - 1; index >= 0; index--) {
      if (allowDrm || !queue[index].drm) {
        play(queue[index], queue, index, { allowDrm });
        return;
      }
    }

    get().seek(0);
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

  playNext: (track) => {
    if (track.drm) {
      set({ error: "Трек защищён DRM — в очередь его не добавить" });
      logAction("skip_drm", { id: track.id, title: track.title });
      return;
    }
    set((state) => {
      // Пустая очередь — просто добавляем; иначе вставляем за текущим.
      const at = state.queue.length === 0 ? 0 : state.queueIndex + 1;
      const queue = [...state.queue];
      queue.splice(at, 0, track);
      return { queue };
    });
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
    set({ refill: fn, refilling: false, queueEnd: false });
  },

  setQueueLoader: (fn) => {
    set({ queueLoader: fn, refilling: false, queueEnd: false });
  },

  /**
   * Подтягивает следующую порцию треков из источника очереди: у «Моей
   * волны» это её refill, у пагинируемых списков (лайки, загрузки) —
   * следующая страница. Возвращает добавленные треки; пустой массив —
   * источника нет либо он исчерпан.
   */
  fetchMore: async () => {
    const { refill, queueLoader, refilling } = get();
    if (refilling) return [];

    const source = refill ?? queueLoader;
    if (!source) return [];

    set({ refilling: true });

    let more: SCTrack[] = [];
    try {
      more = await source();
    } catch (e) {
      console.error("Не удалось долить очередь:", e);
      set({ refilling: false });
      return [];
    }

    const state = get();
    // Источник могли убрать (остановка волны, уход со страницы) — тогда
    // долитый трек включать нельзя: очередь уже другая.
    if (!state.refill && !state.queueLoader) {
      set({ refilling: false });
      return [];
    }

    const known = new Set(state.queue.map((track) => track.id));
    const fresh = more.filter(
      (track) => track && !known.has(track.id) && (state.allowDrm || !track.drm)
    );

    if (fresh.length === 0) {
      // Пусто — источник исчерпан: больше не дёргаем его вхолостую.
      set({ refilling: false, queueEnd: true });
      return [];
    }

    set({ queue: [...state.queue, ...fresh], refilling: false });
    return fresh;
  },

  /**
   * Упреждающая доливка: как только до конца очереди остаётся пара
   * треков, подтягиваем следующую порцию заранее. Так переход к концу
   * уже загруженного списка не превращается в паузу с догрузкой.
   */
  ensureQueueAhead: () => {
    const { queue, queueIndex, refill, queueLoader, refilling, queueEnd } = get();
    if (refilling || queueEnd) return;
    if (!refill && !queueLoader) return;
    if (queue.length === 0) return;

    const remaining = queue.length - queueIndex - 1;
    if (remaining > QUEUE_PREFETCH_AHEAD) return;

    void get().fetchMore();
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
      // Режим DRM сохраняем: это перезапуск после отвала сети, а не новая
      // очередь — волну он останавливать не должен.
      const allowDrm = get().allowDrm;
      if (hls && audio) {
        hls.startLoad();
        void audio.play().catch(() => {
          get().play(currentTrack, queue, queueIndex, { allowDrm });
        });
        set({ isPlaying: true });
      } else if (audio && audio.src && !audio.error) {
        void audio.play().catch(() => {
          get().play(currentTrack, queue, queueIndex, { allowDrm });
        });
        set({ isPlaying: true });
      } else {
        get().play(currentTrack, queue, queueIndex, { allowDrm });
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

import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  RepeatOnce,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
  Queue,
  MusicNotes,
  TextAa,
  Microphone,
  Heart,
  ThumbsDown,
  DownloadSimple,
  Check,
} from "@phosphor-icons/react";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { useWaveStore } from "../../stores/waveStore";
import {
  downloadTrack,
  ensureDownloadSubscription,
  useDownloadStore,
} from "../../stores/downloadStore";
import { formatDuration } from "../../lib/soundcloud-api";
import { logAction } from "../../lib/actionLog";
import { trackUrl, userUrl } from "../../lib/soundcloudLinks";
import "./Player.css";

export default function Player() {
  const {
    currentTrack,
    isPlaying,
    progress,
    duration,
    volume,
    isMuted,
    repeat,
    isShuffled,
    error,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    setRepeat,
    toggleShuffle,
    setProgress,
  } = usePlayerStore();

  const dislike = useWaveStore((s) => s.dislike);
  const download = useDownloadStore((s) =>
    currentTrack ? s.downloads[currentTrack.id] : undefined
  );

  /** Открывает страницу SoundCloud в браузере. */
  const openSoundCloud = (url: string | null) => {
    if (!url) return;
    logAction("open_external", { url });
    void window.electronAPI?.openExternal?.(url);
  };

  // События скачивания приходят из бэкенда — одно на всё приложение.
  useEffect(() => {
    ensureDownloadSubscription();
  }, []);

  const {
    toggleQueue,
    queueVisible,
    toggleLyrics,
    lyricsVisible,
    openKaraokeFullscreen,
    karaokeFullscreen,
    likedTracks,
    toggleLike,
    likeError,
  } = useAppStore();
  const [localProgress, setLocalProgress] = useState(0);
  const [volumeHint, setVolumeHint] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const hintTimerRef = useRef<number | null>(null);

  const isLiked = currentTrack
    ? likedTracks.some((item) => item.id === currentTrack.id)
    : false;

  // Громкость колёсиком мыши над панелью плеера.
  const changeVolume = (delta: number) => {
    const next = Math.min(1, Math.max(0, volume + delta));
    setVolume(next);

    setVolumeHint(next);
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setVolumeHint(null), 1200);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!currentTrack) return;
    changeVolume(e.deltaY > 0 ? -0.04 : 0.04);
  };

  useEffect(
    () => () => {
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    },
    []
  );

  // Обновление прогресса через requestAnimationFrame
  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      const { audio, duration: d } = usePlayerStore.getState();
      if (audio && d > 0) {
        const pos = audio.currentTime;
        setProgress(pos / (d / 1000));
        setLocalProgress(pos / (d / 1000));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, setProgress]);

  useEffect(() => {
    setLocalProgress(progress);
  }, [progress]);

  // Обработка клика по прогресс-бару
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = progressBarRef.current;
    if (!bar || !currentTrack) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(ratio);
  };

  // Горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      // В полноэкранном караоке пробелом управляет сам оверлей.
      if (useAppStore.getState().karaokeFullscreen) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          if (e.shiftKey) next();
          break;
        case "ArrowLeft":
          if (e.shiftKey) prev();
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.05));
          break;
        case "KeyM":
          toggleMute();
          break;
        case "KeyL":
          // лайк — обработаем позже
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [volume, togglePlay, next, prev, setVolume, toggleMute]);

  if (!currentTrack) {
    return (
      <div className="player-empty">
        <MusicNotes size={18} style={{ marginRight: 8 }} />
        Выбери трек, чтобы начать слушать
      </div>
    );
  }

  const artwork = currentTrack.artwork_url
    ? currentTrack.artwork_url.replace("-large", "-t200x200")
    : "";

  const totalSec = Math.floor(duration / 1000);
  const currentSec = Math.floor(localProgress * (duration / 1000));

  return (
    <div className="player-bar" onWheel={handleWheel}>
      {/* Левая часть — трек */}
      <div className="player-track">
        <div className="player-artwork">
          {artwork ? (
            <img
              src={artwork}
              alt=""
              onClick={() => openSoundCloud(trackUrl(currentTrack))}
              title="Открыть страницу трека"
            />
          ) : (
            <MusicNotes size={24} onClick={() => openSoundCloud(trackUrl(currentTrack))} />
          )}
        </div>
        <div className="player-track-info">
          <span
            className="player-track-title player-link"
            title={`${currentTrack.title} — открыть на SoundCloud`}
            onClick={() => openSoundCloud(trackUrl(currentTrack))}
          >
            {currentTrack.title}
          </span>
          <span
            className="player-track-artist player-link"
            title="Открыть страницу автора"
            onClick={() => openSoundCloud(userUrl(currentTrack.user ?? {}))}
          >
            {currentTrack.user?.username ?? ""}
          </span>
          {error && (
            <span className="player-error" title={error}>
              {error}
            </span>
          )}
        </div>
        <button
          className={`icon-btn player-dislike ${
            download ? "" : ""
          }`}
          onClick={() => {
            if (!currentTrack) return;
            logAction("track.dislike", { id: currentTrack.id });
            dislike(currentTrack);
          }}
          title="Больше не предлагать"
          aria-label="Дизлайк"
        >
          <ThumbsDown size={17} />
        </button>

        <button
          className={`icon-btn player-download ${download?.state ?? ""}`}
          onClick={() => {
            if (!currentTrack) return;
            logAction("track.download", {
              id: currentTrack.id,
              title: currentTrack.title,
            });
            void downloadTrack(
              currentTrack.id,
              currentTrack.title,
              currentTrack.user?.username ?? ""
            );
          }}
          title="Скачать трек"
          aria-label="Скачать трек"
          disabled={
            download?.state === "started" || download?.state === "progress"
          }
        >
          {download?.state === "done" ? (
            <Check size={17} weight="bold" style={{ color: "var(--success)" }} />
          ) : download?.state === "started" ||
            download?.state === "progress" ? (
            <span className="player-download-percent">{download.percent}%</span>
          ) : (
            <DownloadSimple size={17} />
          )}
        </button>

        <button
          className={`icon-btn player-like ${isLiked ? "active" : ""} ${
            likeError ? "failed" : ""
          }`}
          onClick={() => void toggleLike(currentTrack)}
          title={
            likeError
              ? likeError
              : isLiked
                ? "Убрать из избранного"
                : "В избранное"
          }
        >
          <Heart size={18} weight={isLiked ? "fill" : "regular"} />
        </button>
      </div>

      {/* Центр — контролы */}
      <div className="player-controls">
        <div className="controls-row">
          <button
            className={`ctrl-btn ${isShuffled ? "active" : ""}`}
            onClick={toggleShuffle}
            title="Перемешать"
          >
            <Shuffle size={17} weight={isShuffled ? "bold" : "regular"} />
          </button>

          <button className="ctrl-btn" onClick={prev} title="Предыдущий">
            <SkipBack size={20} weight="fill" />
          </button>

          <button className="play-btn" onClick={togglePlay} title="Играть/Пауза">
            {isPlaying ? (
              <Pause size={20} weight="fill" />
            ) : (
              <Play size={20} weight="fill" style={{ marginLeft: 2 }} />
            )}
          </button>

          <button className="ctrl-btn" onClick={next} title="Следующий">
            <SkipForward size={20} weight="fill" />
          </button>

          <button
            className={`ctrl-btn ${repeat !== "off" ? "active" : ""}`}
            onClick={() =>
              setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")
            }
            title={`Повтор: ${repeat === "off" ? "выкл" : repeat === "all" ? "все" : "один"}`}
          >
            {repeat === "one" ? <RepeatOnce size={17} weight="bold" /> : <Repeat size={17} weight={repeat !== "off" ? "bold" : "regular"} />}
          </button>
        </div>

        <div className="progress-row">
          <span className="progress-time">{formatDuration(currentSec * 1000)}</span>
          <div className="progress-bar" ref={progressBarRef} onClick={handleSeek}>
            <div className="progress-bar-track">
              <div
                className="progress-bar-fill"
                style={{ width: `${localProgress * 100}%` }}
              />
            </div>
          </div>
          <span className="progress-time">{formatDuration(totalSec * 1000)}</span>
        </div>
      </div>

      {/* Правая часть — громкость и очередь */}
      <div className="player-right">
        <button
          className={`icon-btn ${karaokeFullscreen ? "active" : ""}`}
          onClick={openKaraokeFullscreen}
          title="Караоке на весь экран"
        >
          <Microphone size={19} />
        </button>

        <button
          className={`icon-btn ${lyricsVisible ? "active" : ""}`}
          onClick={toggleLyrics}
          title="Текст песни"
        >
          <TextAa size={19} />
        </button>

        <button
          className={`icon-btn ${queueVisible ? "active" : ""}`}
          onClick={toggleQueue}
          title="Очередь"
        >
          <Queue size={19} />
        </button>

        <div className="volume-wrap">
          <button className="ctrl-btn" onClick={toggleMute} title="Звук">
            {isMuted || volume === 0 ? (
              <SpeakerX size={18} />
            ) : volume < 0.5 ? (
              <SpeakerLow size={18} />
            ) : (
              <SpeakerHigh size={18} />
            )}
          </button>
          <input
            type="range"
            className="volume-slider"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
          />
        </div>
      </div>

      {volumeHint !== null && (
        <div className="volume-hint">
          {volumeHint === 0 ? (
            <SpeakerX size={16} />
          ) : volumeHint < 0.5 ? (
            <SpeakerLow size={16} />
          ) : (
            <SpeakerHigh size={16} />
          )}
          <span>{Math.round(volumeHint * 100)}%</span>
        </div>
      )}
    </div>
  );
}

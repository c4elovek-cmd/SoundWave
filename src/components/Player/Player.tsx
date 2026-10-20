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
} from "@phosphor-icons/react";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { formatDuration } from "../../lib/soundcloud-api";
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

  const { toggleQueue, queueVisible } = useAppStore();
  const [localProgress, setLocalProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);

  // Обновление прогресса через requestAnimationFrame
  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      const { howl, duration: d } = usePlayerStore.getState();
      if (howl && d > 0) {
        const pos = howl.seek() as number;
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
    <div className="player-bar">
      {/* Левая часть — трек */}
      <div className="player-track">
        <div className="player-artwork">
          {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={24} />}
        </div>
        <div className="player-track-info">
          <span className="player-track-title" title={currentTrack.title}>
            {currentTrack.title}
          </span>
          <span className="player-track-artist" title={currentTrack.user.username}>
            {currentTrack.user.username}
          </span>
          {error && (
            <span className="player-error" title={error}>
              {error}
            </span>
          )}
        </div>
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
    </div>
  );
}

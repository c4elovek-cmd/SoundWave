import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowsIn,
  ArrowsOut,
  Pause,
  Play,
  SkipForward,
  SpinnerGap,
  X,
} from "../../lib/icons";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  buildTimedLyricsDetailed,
  findActiveLine,
  lineProgress,
  LyricsLine,
  SyncQuality,
} from "../../lib/lyrics";
import { KaraokeLine, paintKaraokeWords } from "./KaraokeLine";
import { fontStack } from "../../lib/fonts";
import { formatDuration } from "../../lib/soundcloud-api";
import "./KaraokeFullscreen.css";

const MIN_SIZE = 32;
const MAX_SIZE = 96;

export default function KaraokeFullscreen() {
  const closeKaraoke = useAppStore((s) => s.closeKaraokeFullscreen);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const duration = usePlayerStore((s) => s.duration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const seek = usePlayerStore((s) => s.seek);

  const { loading, result, error, load, synced, syncLoading, loadSynced } =
    useLyricsStore();

  const [activeLine, setActiveLine] = useState(-1);
  const [fullscreen, setFullscreen] = useState(false);

  const lyricsFont = useSettingsStore((s) => s.lyricsFont);
  const customFonts = useSettingsStore((s) => s.customFonts);
  const fontSize = useSettingsStore((s) => s.karaokeFontSize);
  const setSetting = useSettingsStore((s) => s.set);

  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);

  const fontStackValue = useMemo(
    () => fontStack(lyricsFont, customFonts),
    [lyricsFont, customFonts]
  );

  // Текст подгружаем сами: караоке можно открыть, не открывая боковую панель.
  useEffect(() => {
    if (!currentTrack) return;
    const state = useLyricsStore.getState();
    if (state.trackId === currentTrack.id && (state.loading || state.result?.found)) {
      return;
    }
    void load(currentTrack);
  }, [currentTrack?.id, load]);

  // Точная синхронизация нужна для караоке — подтягиваем LRC.
  // Для speed up / slowed версий не ищем: у них другой темп, и тайминги
  // оригинала разъедутся со звуком.
  useEffect(() => {
    if (!currentTrack || !result?.found || result.tempoModified) return;
    void loadSynced(currentTrack);
  }, [currentTrack?.id, result?.found, result?.tempoModified, loadSynced]);

  useEffect(() => {
    localStorage.setItem("sw-karaoke-size", String(fontSize));
  }, [fontSize]);

  const durationSec = duration > 0 ? duration / 1000 : 0;

  const timed = useMemo(
    () =>
      result?.found && result.lyrics
        ? buildTimedLyricsDetailed(result.lyrics, durationSec, synced?.syncedLyrics)
        : { lines: [] as LyricsLine[], quality: "estimate" as SyncQuality },
    [result?.found, result?.lyrics, durationSec, synced?.syncedLyrics]
  );

  const timedLines = timed.lines;
  const syncQuality = timed.quality;

  // Активная строка и полоса прогресса. Полосу обновляем напрямую в DOM,
  // чтобы не перерисовывать весь экран 60 раз в секунду.
  useEffect(() => {
    let raf = 0;

    const tick = () => {
      const state = usePlayerStore.getState();
      const audio = state.audio;
      const time = audio?.currentTime ?? 0;
      const total =
        audio?.duration && Number.isFinite(audio.duration)
          ? audio.duration
          : state.duration / 1000;

      if (fillRef.current) {
        const percent = total > 0 ? Math.min(1, Math.max(0, time / total)) : 0;
        fillRef.current.style.width = `${percent * 100}%`;
      }

      if (timeRef.current) {
        timeRef.current.textContent = formatDuration(time * 1000);
      }

      if (timedLines.length > 0) {
        const nextLine = findActiveLine(timedLines, time);
        setActiveLine((prev) => (prev === nextLine ? prev : nextLine));

        // Заливка текста идёт по звуку: доля пройденного времени строки.
        // Красим по словам — иначе фраза, перенесённая на несколько
        // визуальных строк, заливалась бы вся сразу.
        if (linesRef.current) {
          const progress = lineProgress(timedLines, nextLine, time);
          paintKaraokeWords(linesRef.current, progress);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timedLines]);

  const handleClose = useCallback(() => {
    if (fullscreen) void window.electronAPI?.setFullscreen(false);
    closeKaraoke();
  }, [closeKaraoke, fullscreen]);

  // Полноэкранный режим окна: если пользователь вышел из него через Esc,
  // караоке закрывается вместе с ним.
  useEffect(() => {
    if (!window.electronAPI?.onFullscreenChanged) return;
    return window.electronAPI.onFullscreenChanged((value) => {
      setFullscreen(value);
      if (!value) closeKaraoke();
    });
  }, [closeKaraoke]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      } else if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose, togglePlay]);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(ratio);
  };

  const changeSize = (delta: number) => {
    setSetting(
      "karaokeFontSize",
      Math.max(MIN_SIZE, Math.min(MAX_SIZE, fontSize + delta))
    );
  };

  const visibleLines = useMemo(() => {
    if (timedLines.length === 0) return [];

    const center = activeLine >= 0 ? activeLine : 0;
    const start = Math.max(0, center - 2);
    const end = Math.min(timedLines.length, start + 5);

    const result: {
      text: string;
      index: number;
      isSection: boolean;
      active: boolean;
    }[] = [];

    for (let i = start; i < end; i++) {
      const line = timedLines[i];
      if (line.isBlank) continue;
      result.push({
        text: line.isSection ? line.text.slice(1, -1) : line.text,
        index: i,
        isSection: line.isSection,
        active: i === activeLine,
      });
    }

    return result;
  }, [timedLines, activeLine]);

  const artwork = currentTrack?.artwork_url
    ? currentTrack.artwork_url.replace("-large", "-t500x500")
    : "";

  const syncLabel =
    syncQuality === "exact"
      ? "Точная синхронизация"
      : syncQuality === "aligned"
        ? "Синхронизация по LRC"
        : "Примерная синхронизация";

  const showStatus = timedLines.length === 0;

  return createPortal(
    <div className="karaoke-fs" style={{ fontFamily: fontStackValue }}>
      <div
        className="karaoke-fs-bg"
        style={artwork ? { backgroundImage: `url(${artwork})` } : undefined}
      />
      <div className="karaoke-fs-veil" />

      <header className="karaoke-fs-top">
        <div className="karaoke-fs-track">
          <span className="karaoke-fs-title">
            {currentTrack?.title ?? "Караоке"}
          </span>
          <span className="karaoke-fs-artist">
            {currentTrack?.user?.username ?? "Ничего не играет"}
          </span>
        </div>

        <div className="karaoke-fs-actions">
          <span className="karaoke-fs-sync" title={syncLabel}>
            {syncLabel}
          </span>

          <button
            className="karaoke-fs-btn"
            onClick={() => void window.electronAPI?.setFullscreen(!fullscreen)}
            title={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}
          >
            {fullscreen ? <ArrowsIn size={20} /> : <ArrowsOut size={20} />}
          </button>

          <button
            className="karaoke-fs-btn"
            onClick={handleClose}
            title="Закрыть караоке (Esc)"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      <main className="karaoke-fs-stage">
        {showStatus && loading && (
          <div className="karaoke-fs-status">
            <SpinnerGap size={28} className="karaoke-fs-spinner" />
            Ищу текст песни…
          </div>
        )}

        {showStatus && !loading && error && (
          <div className="karaoke-fs-status">
            {error}
            {currentTrack && (
              <button
                className="karaoke-fs-retry"
                onClick={() => void load(currentTrack)}
              >
                Попробовать снова
              </button>
            )}
          </div>
        )}

        {showStatus && !loading && !error && (
          <div className="karaoke-fs-status">
            Для этого трека нет текста — караоке покажет только обложку и
            управление.
          </div>
        )}

        {!showStatus && (
          <div
            className="karaoke-fs-lines"
            ref={linesRef}
            style={{ fontSize: `${fontSize}px` }}
          >
            {visibleLines.map((line) => (
              <div
                key={line.index}
                className={`karaoke-fs-line${line.active ? " active karaoke-active" : ""}${
                  line.isSection ? " section" : ""
                }`}
              >
                <KaraokeLine text={line.text} section={line.isSection} />
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="karaoke-fs-bottom">
        <div className="karaoke-fs-controls">
          <button
            className="karaoke-fs-btn"
            onClick={togglePlay}
            title="Играть / Пауза (Пробел)"
          >
            {isPlaying ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}
          </button>

          <button className="karaoke-fs-btn" onClick={next} title="Следующий трек">
            <SkipForward size={20} weight="fill" />
          </button>

          <div
            className="karaoke-fs-progress"
            ref={barRef}
            onClick={handleSeek}
            title="Перемотать"
          >
            <div className="karaoke-fs-progress-track">
              <div className="karaoke-fs-progress-fill" ref={fillRef} />
            </div>
          </div>

          <span className="karaoke-fs-time" ref={timeRef}>
            {formatDuration(0)}
          </span>
        </div>

        <div className="karaoke-fs-size">
          <button
            className="karaoke-fs-size-btn"
            onClick={() => changeSize(-4)}
            disabled={fontSize <= MIN_SIZE}
            title="Мельче"
          >
            A−
          </button>
          <button
            className="karaoke-fs-size-btn"
            onClick={() => changeSize(4)}
            disabled={fontSize >= MAX_SIZE}
            title="Крупнее"
          >
            A+
          </button>
        </div>
      </footer>
    </div>,
    document.body
  );
}

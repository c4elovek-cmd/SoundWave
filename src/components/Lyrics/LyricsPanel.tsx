import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsOut,
  Microphone,
  MusicNotes,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { buildTimedLyrics, findActiveLine, LyricsLine } from "../../lib/lyrics";
import { BUILTIN_FONTS, CUSTOM_FONT_PREFIX, fontStack } from "../../lib/fonts";
import "./Lyrics.css";

export default function LyricsPanel() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const duration = usePlayerStore((s) => s.duration);
  const closeLyrics = useAppStore((s) => s.closeLyrics);
  const openKaraokeFullscreen = useAppStore((s) => s.openKaraokeFullscreen);
  const { loading, result, error, load, synced, syncLoading, loadSynced } = useLyricsStore();

  const karaoke = useSettingsStore((s) => s.karaokeEnabled);
  const font = useSettingsStore((s) => s.lyricsFont);
  const fontSize = useSettingsStore((s) => s.lyricsFontSize);
  const exactSync = useSettingsStore((s) => s.exactSync);
  const customFonts = useSettingsStore((s) => s.customFonts);
  const setSetting = useSettingsStore((s) => s.set);

  const [activeLine, setActiveLine] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const fontStackValue = fontStack(font, customFonts);
  const durationSec = duration > 0 ? duration / 1000 : 0;

  const timedLines = useMemo(
    () =>
      result?.found && result.lyrics
        ? buildTimedLyrics(result.lyrics, durationSec, synced?.syncedLyrics)
        : [],
    [result?.found, result?.lyrics, durationSec, synced?.syncedLyrics]
  );

  useEffect(() => {
    void load(currentTrack);
    // Панель перезагружает текст только при смене трека.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id]);

  // Точные тайминги нужны в караоке; по настройке — и всегда.
  useEffect(() => {
    if (currentTrack && result?.found && (karaoke || exactSync)) {
      void loadSynced(currentTrack);
    }
  }, [karaoke, exactSync, currentTrack?.id, result?.found, loadSynced]);

  // Отслеживаем текущую строку по времени аудио. Подписка на progress
  // дёргала бы панель 60 раз в секунду — здесь состояние меняется только
  // при переходе на новую строку.
  useEffect(() => {
    if (!karaoke || timedLines.length === 0) {
      setActiveLine(-1);
      return;
    }

    let raf = 0;
    const tick = () => {
      const audio = usePlayerStore.getState().audio;
      const time = audio?.currentTime ?? 0;
      const next = findActiveLine(timedLines, time);
      setActiveLine((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [karaoke, timedLines]);

  // Автопрокрутка к активной строке.
  useEffect(() => {
    if (!karaoke || activeLine < 0) return;

    const body = bodyRef.current;
    const element = body?.querySelector<HTMLElement>(`[data-line="${activeLine}"]`);
    if (!body || !element) return;

    const bodyRect = body.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const target =
      body.scrollTop +
      (elementRect.top - bodyRect.top) -
      body.clientHeight / 2 +
      elementRect.height / 2;

    body.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeLine, karaoke]);

  useEffect(() => {
    if (!karaoke) bodyRef.current?.scrollTo({ top: 0 });
  }, [currentTrack?.id, karaoke]);

  const seekToLine = (line: LyricsLine) => {
    if (line.start === null) return;

    const state = usePlayerStore.getState();
    const total =
      state.audio?.duration && Number.isFinite(state.audio.duration)
        ? state.audio.duration
        : state.duration / 1000;

    if (total > 0) {
      state.seek(Math.max(0, Math.min(1, line.start / total)));
    }
  };

  const canRetry = !loading && Boolean(error) && Boolean(currentTrack);

  return (
    <aside className="lyrics-panel">
      <div className="lyrics-header">
        <div className="lyrics-heading">
          <span>Текст песни</span>
          {result?.found && <span className="lyrics-badge">Genius</span>}
        </div>
        <button className="icon-btn" onClick={closeLyrics} title="Закрыть">
          <X size={16} />
        </button>
      </div>

      {currentTrack ? (
        <div className="lyrics-track">
          <span className="lyrics-track-title">{currentTrack.title}</span>
          <span className="lyrics-track-artist">
            {currentTrack.user?.username ?? "Неизвестный автор"}
          </span>
        </div>
      ) : null}

      {result?.found && result.lyrics && (
        <div className="lyrics-toolbar">
          <button
            className={`lyrics-karaoke ${karaoke ? "active" : ""}`}
            onClick={() => setSetting("karaokeEnabled", !karaoke)}
            title="Караоке: подсветка текущей строки"
          >
            <Microphone size={14} weight={karaoke ? "fill" : "regular"} />
            Караоке
          </button>

          <button
            className="lyrics-karaoke"
            onClick={openKaraokeFullscreen}
            title="Караоке на весь экран"
          >
            <ArrowsOut size={14} />
            Во весь экран
          </button>

          {karaoke && (
            <span
              className={`lyrics-sync-dot ${
                synced?.found ? "exact" : syncLoading ? "loading" : "auto"
              }`}
              title={
                synced?.found
                  ? `Точная синхронизация: ${synced.title ?? "LRCLIB"}${
                      synced.artist ? ` — ${synced.artist}` : ""
                    }`
                  : syncLoading
                    ? "Ищу точную синхронизацию…"
                    : "Примерная синхронизация по длительности трека"
              }
            />
          )}

          <div className="lyrics-font-controls">
            <select
              className="lyrics-font-select"
              value={font}
              onChange={(e) => setSetting("lyricsFont", e.target.value)}
              title="Шрифт текста"
              style={{ fontFamily: fontStackValue }}
            >
              {BUILTIN_FONTS.map((item) => (
                <option key={item.id} value={item.id} style={{ fontFamily: item.stack }}>
                  {item.label}
                </option>
              ))}

              {customFonts.length > 0 && (
                <optgroup label="Свои шрифты">
                  {customFonts.map((item) => (
                    <option
                      key={item.id}
                      value={`${CUSTOM_FONT_PREFIX}${item.id}`}
                      style={{ fontFamily: `"${item.family}", sans-serif` }}
                    >
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            <button
              className="lyrics-size-btn"
              onClick={() => setSetting("lyricsFontSize", Math.max(12, fontSize - 1))}
              disabled={fontSize <= 12}
              title="Меньше шрифт"
            >
              A−
            </button>
            <button
              className="lyrics-size-btn"
              onClick={() => setSetting("lyricsFontSize", Math.min(22, fontSize + 1))}
              disabled={fontSize >= 22}
              title="Больше шрифт"
            >
              A+
            </button>
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        className={`lyrics-body ${karaoke ? "karaoke" : ""}`}
        style={{ fontFamily: fontStackValue }}
      >
        {!currentTrack && (
          <div className="lyrics-status">
            <MusicNotes size={26} />
            <span>Сейчас ничего не играет</span>
            <span className="lyrics-hint">
              Включите трек, и здесь появится его текст
            </span>
          </div>
        )}

        {currentTrack && loading && (
          <div className="lyrics-status">
            <SpinnerGap size={24} className="lyrics-spinner" />
            <span>Ищу текст на Genius…</span>
          </div>
        )}

        {currentTrack && !loading && error && (
          <div className="lyrics-status">
            <WarningCircle size={24} />
            <span>{error}</span>
            {canRetry && (
              <button
                className="lyrics-retry"
                onClick={() => void load(currentTrack)}
              >
                Попробовать снова
              </button>
            )}
          </div>
        )}

        {currentTrack && !loading && !error && timedLines.length > 0 && (
          <div
            className="lyrics-text"
            style={{ fontSize: `${Math.min(28, fontSize + (karaoke ? 3 : 0))}px` }}
          >
            {timedLines.map((line, index) => {
              if (line.isBlank) {
                return <div key={index} className="lyrics-line blank" />;
              }

              const active = karaoke && activeLine === index;
              const clickable = karaoke && line.start !== null;

              return (
                <div
                  key={index}
                  data-line={index}
                  className={`lyrics-line${line.isSection ? " section" : ""}${
                    karaoke ? " karaoke-line" : ""
                  }${active ? " active" : ""}${clickable ? " clickable" : ""}`}
                  onClick={clickable ? () => seekToLine(line) : undefined}
                  title={clickable ? "Перейти к этой строке" : undefined}
                >
                  {line.isSection ? line.text.slice(1, -1) : line.text}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {result?.found && result.url && (
        <button
          className="lyrics-source"
          onClick={() => window.electronAPI?.openExternal(result.url as string)}
        >
          <ArrowSquareOut size={14} />
          Открыть на Genius
        </button>
      )}
    </aside>
  );
}

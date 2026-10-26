import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsOut,
  Microphone,
  MusicNotes,
  SpinnerGap,
  WarningCircle,
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
import { BUILTIN_FONTS, CUSTOM_FONT_PREFIX, fontFamilies, fontStack } from "../../lib/fonts";
import { KaraokeLine, paintKaraokeWords } from "./KaraokeLine";
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

  const timed = useMemo(
    () =>
      result?.found && result.lyrics
        ? buildTimedLyricsDetailed(result.lyrics, durationSec, synced?.syncedLyrics)
        : { lines: [] as LyricsLine[], quality: "estimate" as SyncQuality },
    [result?.found, result?.lyrics, durationSec, synced?.syncedLyrics]
  );

  const timedLines = timed.lines;
  const syncQuality = timed.quality;

  // Speed up / slowed версии: текст показываем, караоке — нет.
  const tempoModified = Boolean(result?.tempoModified);
  // Если караоке было включено глобально, для такого трека его глушим.
  const karaokeActive = karaoke && !tempoModified;

  useEffect(() => {
    void load(currentTrack);
    // Панель перезагружает текст только при смене трека.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id]);

  // Точные тайминги нужны в караоке; по настройке — и всегда.
  // Для speed up / slowed версий не ищем: у них другой темп, и тайминги
  // оригинала разъедутся со звуком.
  useEffect(() => {
    if (currentTrack && result?.found && !result.tempoModified && (karaoke || exactSync)) {
      void loadSynced(currentTrack);
    }
  }, [karaoke, exactSync, currentTrack?.id, result?.found, result?.tempoModified, loadSynced]);

  // Отслеживаем текущую строку по времени аудио. Подписка на progress
  // дёргала бы панель 60 раз в секунду — здесь состояние меняется только
  // при переходе на новую строку.
  useEffect(() => {
    if (!karaokeActive || timedLines.length === 0) {
      setActiveLine(-1);
      return;
    }

    let raf = 0;
    const tick = () => {
      const audio = usePlayerStore.getState().audio;
      const time = audio?.currentTime ?? 0;
      const next = findActiveLine(timedLines, time);
      setActiveLine((prev) => (prev === next ? prev : next));

      // Заливка текста идёт по звуку: доля пройденного времени строки.
      // Красим по словам — иначе фраза, перенесённая на несколько
      // визуальных строк, заливалась бы вся сразу.
      const body = bodyRef.current;
      if (body) {
        const progress = lineProgress(timedLines, next, time);
        paintKaraokeWords(body, progress);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [karaokeActive, timedLines]);

  // Автопрокрутка к активной строке.
  useEffect(() => {
    if (!karaokeActive || activeLine < 0) return;

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
  }, [activeLine, karaokeActive]);

  useEffect(() => {
    if (!karaokeActive) bodyRef.current?.scrollTo({ top: 0 });
  }, [currentTrack?.id, karaokeActive]);

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

      {tempoModified && result?.found && result.lyrics && (
        <div className="lyrics-tempo-note">
          Это версия с изменённым темпом (speed up, slowed и т. п.) — караоке
          отключено: строки оригинала разъехались бы со звуком. Текст ниже от
          оригинального трека.
        </div>
      )}

      {result?.found && result.lyrics && (
        <div className="lyrics-toolbar">
          <button
            className={`lyrics-karaoke ${karaokeActive ? "active" : ""}`}
            onClick={() => !tempoModified && setSetting("karaokeEnabled", !karaoke)}
            disabled={tempoModified}
            title={
              tempoModified
                ? "Это версия с изменённым темпом (speed up, slowed): строки караоке разъехались бы со звуком"
                : "Караоке: подсветка текущей строки"
            }
          >
            <Microphone size={14} weight={karaokeActive ? "fill" : "regular"} />
            Караоке
          </button>

          <button
            className="lyrics-karaoke"
            onClick={() => !tempoModified && openKaraokeFullscreen()}
            disabled={tempoModified}
            title={
              tempoModified
                ? "Это версия с изменённым темпом (speed up, slowed): строки караоке разъехались бы со звуком"
                : "Караоке на весь экран"
            }
          >
            <ArrowsOut size={14} />
            Во весь экран
          </button>

          {karaokeActive && (
            <span
              className={`lyrics-sync-dot ${
                syncQuality === "exact"
                  ? "exact"
                  : syncQuality === "aligned"
                    ? "aligned"
                    : syncLoading
                      ? "loading"
                      : "auto"
              }`}
              title={
                syncQuality === "exact"
                  ? `Точная синхронизация: ${synced?.title ?? "LRCLIB"}${
                      synced?.artist ? ` — ${synced.artist}` : ""
                    }`
                  : syncQuality === "aligned"
                    ? "Тайминги LRCLIB подобраны по совпадению строк: текст отличается, но время настоящее"
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

              {fontFamilies(customFonts).length > 0 && (
                <optgroup label="Свои шрифты">
                  {fontFamilies(customFonts).map((item) => (
                    <option
                      key={item.family}
                      value={`${CUSTOM_FONT_PREFIX}${item.family}`}
                      style={{ fontFamily: `"${item.family}", sans-serif` }}
                    >
                      {item.display}
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
        className={`lyrics-body ${karaokeActive ? "karaoke" : ""}`}
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
            style={{ fontSize: `${Math.min(28, fontSize + (karaokeActive ? 3 : 0))}px` }}
          >
            {timedLines.map((line, index) => {
              if (line.isBlank) {
                return <div key={index} className="lyrics-line blank" />;
              }

              const active = karaokeActive && activeLine === index;
              const clickable = karaokeActive && line.start !== null;

              return (
                <div
                  key={index}
                  data-line={index}
                  className={`lyrics-line${line.isSection ? " section" : ""}${
                    karaokeActive ? " karaoke-line" : ""
                  }${active ? " active karaoke-active" : ""}${clickable ? " clickable" : ""}`}
                  onClick={clickable ? () => seekToLine(line) : undefined}
                  title={clickable ? "Перейти к этой строке" : undefined}
                >
                  {line.isSection ? (
                    line.text.slice(1, -1)
                  ) : karaokeActive ? (
                    <KaraokeLine text={line.text} />
                  ) : (
                    line.text
                  )}
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

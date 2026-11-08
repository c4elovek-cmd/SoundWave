/**
 * Добавление в саундпад прямо из плеера.
 *
 * Два режима: целая песня (копия скачанного mp3) и фрагмент
 * (вырезается ffmpeg по границам start–end). Если трек ещё не скачан,
 * модалка сначала скачивает его — фрагменты режутся только с диска.
 * DRM-треки сохранять нельзя: скачивание для них закрыто.
 */

import { useEffect, useRef, useState } from "react";
import { MusicNotes, Play, Scissors, SpinnerGap, Stop, X } from "../../lib/icons";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import {
  downloadTrackAndWait,
  ensureDownloadSubscription,
  useDownloadStore,
} from "../../stores/downloadStore";
import {
  soundpadId,
  useSoundpadStore,
} from "../../stores/soundpadStore";
import { showToast } from "../../stores/toastStore";
import { localFileUrl } from "../../lib/localFiles";
import {
  formatSoundpadTime as formatTime,
  parseSoundpadTime as parseTime,
} from "../../lib/soundpadTime";
import { logAction } from "../../lib/actionLog";
import "./Soundpad.css";

interface Props {
  onClose: () => void;
}

export default function SoundpadAddModal({ onClose }: Props) {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const playerDuration = usePlayerStore((s) => s.duration);
  const add = useSoundpadStore((s) => s.add);
  const setView = useAppStore((s) => s.setView);
  const knownPath = useDownloadStore((s) =>
    currentTrack ? s.known[currentTrack.id] : undefined
  );

  const total = Math.max(
    0,
    (playerDuration > 0 ? playerDuration : currentTrack?.duration ?? 0) / 1000
  );

  const [mode, setMode] = useState<"track" | "fragment">("track");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("0:00");
  const [name, setName] = useState(currentTrack?.title ?? "");
  const [localPath, setLocalPath] = useState<string | null>(
    knownPath ?? currentTrack?.localPath ?? null
  );
  const [busy, setBusy] = useState<"download" | "save" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  const artist = currentTrack?.user?.username ?? "";
  const isDrm = Boolean(currentTrack?.drm);

  // Стартовые границы фрагмента — от текущей позиции плеера, окно 15 секунд.
  useEffect(() => {
    const position = usePlayerStore.getState().audio?.currentTime ?? 0;
    const from = Math.max(0, Math.min(position, Math.max(0, total - 1)));
    const to = Math.min(total, from + 15);
    setStart(Math.round(from * 10) / 10);
    setEnd(Math.round(to * 10) / 10);
    setStartText(formatTime(from));
    setEndText(formatTime(to));
    // Один раз при открытии: дальше границами управляет пользователь.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Узнаём локальный файл: стор загрузок или проверка папки загрузок.
  useEffect(() => {
    if (localPath || !currentTrack) return;
    void window.electronAPI
      ?.findDownload?.(currentTrack.title, artist)
      .then((result) => {
        if (result?.found && result.path) setLocalPath(result.path);
      })
      .catch(() => {});
  }, [localPath, currentTrack, artist]);

  // Закрытие и размонтирование останавливают превью.
  useEffect(() => {
    return () => {
      previewRef.current?.pause();
      previewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  if (!currentTrack) return null;

  const stopPreview = () => {
    previewRef.current?.pause();
    previewRef.current = null;
    setPreviewing(false);
  };

  /** Превью фрагмента с диска — основной плеер не трогаем. */
  const togglePreview = () => {
    if (previewing) {
      stopPreview();
      return;
    }
    if (!localPath) return;

    const element = new Audio(localFileUrl(localPath));
    previewRef.current = element;
    element.onloadedmetadata = () => {
      element.currentTime = Math.min(start, Math.max(0, element.duration - 0.1));
      void element.play().catch(() => stopPreview());
    };
    element.ontimeupdate = () => {
      if (element.currentTime >= end) stopPreview();
    };
    element.onended = () => stopPreview();
    setPreviewing(true);
  };

  const switchMode = (next: "track" | "fragment") => {
    stopPreview();
    setMode(next);
    // Название подсказываем только если пользователь его не менял.
    if (next === "fragment" && name === currentTrack.title) {
      setName(`${currentTrack.title} (фрагмент)`);
    } else if (next === "track" && name === `${currentTrack.title} (фрагмент)`) {
      setName(currentTrack.title);
    }
  };

  const commitTime = (which: "start" | "end", text: string) => {
    const value = parseTime(text);
    if (value === null) {
      if (which === "start") setStartText(formatTime(start));
      else setEndText(formatTime(end));
      return;
    }
    const clamped = Math.max(0, Math.min(total, value));
    if (which === "start") {
      setStart(clamped);
      setStartText(formatTime(clamped));
      if (end <= clamped) {
        const next = Math.min(total, clamped + 15);
        setEnd(next);
        setEndText(formatTime(next));
      }
    } else {
      setEnd(clamped);
      setEndText(formatTime(clamped));
      if (clamped <= start) {
        const next = Math.max(0, clamped - 15);
        setStart(next);
        setStartText(formatTime(next));
      }
    }
  };

  const fragmentValid = end > start && end - start <= 300;
  const canSave =
    !busy && !isDrm && name.trim().length > 0 && (mode === "track" || fragmentValid);

  const save = async () => {
    if (!canSave) return;
    stopPreview();
    ensureDownloadSubscription();

    let source = localPath;
    if (!source) {
      // Фрагменты и копия режутся только с диска — сначала скачиваем.
      setBusy("download");
      const info = await downloadTrackAndWait(currentTrack);
      if (info.state !== "done" || !info.path) {
        setBusy(null);
        showToast({
          kind: "error",
          title: "Не удалось скачать трек для саундпада",
          message: info.error,
          timeout: 6000,
        });
        return;
      }
      source = info.path;
      setLocalPath(source);
    }

    setBusy("save");
    const finalEnd = Math.min(end, total);
    const result = await window.electronAPI
      ?.soundpadSave?.(
        source,
        name.trim(),
        artist,
        mode === "fragment" ? start : undefined,
        mode === "fragment" ? finalEnd : undefined,
        total
      )
      .catch((error: unknown) => ({
        ok: false,
        path: undefined,
        steamSoundpad: false,
        error: error instanceof Error ? error.message : "Не удалось сохранить звук",
      }));
    setBusy(null);

    if (!result?.ok || !result.path) {
      showToast({
        kind: "error",
        title: "Не удалось сохранить в саундпад",
        message: result?.error,
        timeout: 6000,
      });
      return;
    }

    // Steam SoundPad установлен — звук ушёл и в его список (файл копия
    // лежит рядом с его данными). Он держит список в памяти: новый звук
    // появится после перезапуска SoundPad.
    if (result.steamSoundpad) {
      logAction("soundpad.saved_to_steam", { id: currentTrack.id, mode });
      showToast({
        kind: "success",
        title: "Добавлено в Steam SoundPad",
        message:
          "Перезапусти SoundPad, чтобы звук появился в списке: всё сохраняет сразу (Ctrl+S)",
        timeout: 7000,
        action: {
          label: "Папка SoundPad",
          onClick: () => void window.electronAPI?.openPath?.("steam-soundpad"),
        },
      });
      onClose();
      return;
    }

    add({
      id: soundpadId(),
      name: name.trim(),
      artist,
      trackId: currentTrack.id,
      kind: mode,
      path: result.path,
      duration: mode === "fragment" ? finalEnd - start : total,
      start: mode === "fragment" ? start : undefined,
      end: mode === "fragment" ? finalEnd : undefined,
      artworkUrl: currentTrack.artwork_url ?? undefined,
      createdAt: Date.now(),
    });

    logAction("soundpad.saved_from_player", { id: currentTrack.id, mode });
    showToast({
      kind: "success",
      title: "Добавлено в саундпад",
      message: name.trim(),
      timeout: 5000,
      action: {
        label: "Открыть",
        onClick: () => setView("soundpad"),
      },
    });
    onClose();
  };

  const artwork = currentTrack.artwork_url
    ? currentTrack.artwork_url.replace("-large", "-t200x200")
    : "";

  return (
    <div
      className="sp-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="sp-modal" role="dialog" aria-modal="true" aria-label="Добавить в саундпад">
        <div className="sp-modal-header">
          <span className="sp-modal-title">
            <Scissors size={18} />В саундпад
          </span>
          <button className="icon-btn" onClick={onClose} disabled={Boolean(busy)} title="Закрыть">
            <X size={18} />
          </button>
        </div>

        <div className="sp-track-head">
          <div className="sp-track-art">
            {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={22} />}
          </div>
          <div className="sp-track-meta">
            <span className="sp-track-name">{currentTrack.title}</span>
            <span className="sp-track-artist">{artist}</span>
          </div>
        </div>

        {isDrm && (
          <div className="sp-drm-note">
            Трек защищён DRM — сохранить его в саундпад нельзя.
          </div>
        )}

        <div className="sp-mode-switch" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "track"}
            className={mode === "track" ? "active" : ""}
            onClick={() => switchMode("track")}
            disabled={Boolean(busy)}
          >
            Вся песня
          </button>
          <button
            role="tab"
            aria-selected={mode === "fragment"}
            className={mode === "fragment" ? "active" : ""}
            onClick={() => switchMode("fragment")}
            disabled={Boolean(busy)}
          >
            Фрагмент
          </button>
        </div>

        {mode === "fragment" && (
          <div className="sp-fragment">
            <div className="sp-range" aria-hidden="true">
              <div
                className="sp-range-window"
                style={{
                  left: `${total > 0 ? (start / total) * 100 : 0}%`,
                  width: `${total > 0 ? (Math.max(0, end - start) / total) * 100 : 0}%`,
                }}
              />
            </div>
            <div className="sp-time-row">
              <label className="sp-time-field">
                <span>Начало</span>
                <input
                  value={startText}
                  onChange={(e) => setStartText(e.target.value)}
                  onBlur={(e) => commitTime("start", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTime("start", startText);
                  }}
                  disabled={Boolean(busy)}
                  placeholder="0:00"
                />
              </label>
              <label className="sp-time-field">
                <span>Конец</span>
                <input
                  value={endText}
                  onChange={(e) => setEndText(e.target.value)}
                  onBlur={(e) => commitTime("end", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTime("end", endText);
                  }}
                  disabled={Boolean(busy)}
                  placeholder="0:15"
                />
              </label>
              <button
                className="sp-from-position"
                onClick={() => {
                  const position = usePlayerStore.getState().audio?.currentTime ?? 0;
                  const from = Math.max(0, Math.min(position, Math.max(0, total - 0.5)));
                  const to = Math.min(total, from + 15);
                  setStart(Math.round(from * 10) / 10);
                  setEnd(Math.round(to * 10) / 10);
                  setStartText(formatTime(from));
                  setEndText(formatTime(to));
                }}
                disabled={Boolean(busy)}
                title="Взять 15 секунд от текущей позиции плеера"
              >
                От текущей позиции
              </button>
            </div>
            <div className="sp-fragment-foot">
              <span className={fragmentValid ? "sp-length" : "sp-length invalid"}>
                {fragmentValid
                  ? `Длина: ${formatTime(end - start)}`
                  : end <= start
                    ? "Конец должен быть позже начала"
                    : "Не длиннее 5 минут"}
              </span>
              <button
                className="sp-preview-btn"
                onClick={togglePreview}
                disabled={!localPath || Boolean(busy) || !fragmentValid}
                title={
                  localPath
                    ? "Прослушать фрагмент"
                    : "Превью появится после скачивания трека"
                }
              >
                {previewing ? <Stop size={15} weight="fill" /> : <Play size={15} weight="fill" />}
                {previewing ? "Стоп" : "Превью"}
              </button>
            </div>
          </div>
        )}

        <label className="sp-name-field">
          <span>Название пада</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={Boolean(busy)}
            placeholder={currentTrack.title}
            maxLength={120}
          />
        </label>

        <div className="sp-modal-actions">
          <button className="sp-btn secondary" onClick={onClose} disabled={Boolean(busy)}>
            Отмена
          </button>
          <button className="sp-btn primary" onClick={() => void save()} disabled={!canSave}>
            {busy === "download" ? (
              <>
                <SpinnerGap size={16} /> Скачиваю трек…
              </>
            ) : busy === "save" ? (
              <>
                <SpinnerGap size={16} /> {mode === "fragment" ? "Нарезаю…" : "Сохраняю…"}
              </>
            ) : (
              "Сохранить"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
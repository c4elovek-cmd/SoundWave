/**
 * Страница «Саундпад»: сетка падов с мгновенным запуском.
 *
 * Клик по поду играет звук поверх основного плеера, повторный клик
 * останавливает. Цифры 1–9 запускают первые девять падов — как на
 * настоящем саундпаде. Название редактируется, файл удаляется с диска.
 */

import { useEffect, useState } from "react";
import {
  Apps,
  FolderOpen,
  MusicNotes,
  PencilSimple,
  Play,
  Scissors,
  SpeakerHigh,
  Stop,
  Trash,
} from "../lib/icons";
import {
  SoundpadEntry,
  useSoundpadStore,
} from "../stores/soundpadStore";
import { formatSoundpadTime } from "../lib/soundpadTime";
import { showToast } from "../stores/toastStore";
import "./Pages.css";
import "../components/Soundpad/Soundpad.css";

/** Карточка одного пада. */
function PadCard({ entry, index }: { entry: SoundpadEntry; index: number }) {
  const playingId = useSoundpadStore((s) => s.playingId);
  const progress = useSoundpadStore((s) => (s.playingId === entry.id ? s.progress : 0));
  const play = useSoundpadStore((s) => s.play);
  const remove = useSoundpadStore((s) => s.remove);
  const rename = useSoundpadStore((s) => s.rename);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  const playing = playingId === entry.id;

  const commitRename = () => {
    rename(entry.id, draft);
    setEditing(false);
  };

  const artwork = entry.artworkUrl
    ? entry.artworkUrl.replace("-large", "-t200x200")
    : "";

  return (
    <div
      className={`soundpad-card ${playing ? "playing" : ""}`}
      onClick={() => {
        if (!editing) play(entry.id);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !editing) {
          e.preventDefault();
          // Иначе пробел дойдёт до глобальных хоткеев и тронет основной плеер.
          e.stopPropagation();
          play(entry.id);
        }
      }}
      title={playing ? "Остановить" : "Воспроизвести"}
    >
      {index < 9 && <span className="sp-hotkey">{index + 1}</span>}

      <div className="sp-card-art">
        {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={26} />}
        <span className="sp-card-play">
          {playing ? <Stop size={22} weight="fill" /> : <Play size={22} weight="fill" />}
        </span>
      </div>

      <div className="sp-card-body">
        {editing ? (
          <input
            className="sp-rename-input"
            value={draft}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(entry.name);
                setEditing(false);
              }
            }}
            maxLength={120}
          />
        ) : (
          <span className="sp-card-name" title={entry.name}>
            {entry.name}
          </span>
        )}
        <span className="sp-card-meta">
          {entry.artist ? `${entry.artist} · ` : ""}
          {formatSoundpadTime(entry.duration)}
          {entry.kind === "fragment" && entry.start !== undefined && entry.end !== undefined
            ? ` · ${formatSoundpadTime(entry.start)}–${formatSoundpadTime(entry.end)}`
            : ""}
        </span>
      </div>

      <div className="sp-card-actions" onClick={(e) => e.stopPropagation()}>
        {entry.kind === "fragment" && (
          <span className="sp-fragment-badge" title="Фрагмент трека">
            <Scissors size={13} />
          </span>
        )}
        <button
          className="icon-btn"
          title="Переименовать"
          onClick={() => {
            setDraft(entry.name);
            setEditing(true);
          }}
        >
          <PencilSimple size={15} />
        </button>
        <button
          className="icon-btn sp-delete"
          title="Удалить из саундпада"
          onClick={() => {
            void remove(entry.id).then(() => {
              showToast({
                kind: "info",
                title: "Удалено из саундпада",
                message: entry.name,
                timeout: 3000,
              });
            });
          }}
        >
          <Trash size={15} />
        </button>
      </div>

      {playing && (
        <div className="sp-card-progress">
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export default function SoundpadPage() {
  const entries = useSoundpadStore((s) => s.entries);
  const playingId = useSoundpadStore((s) => s.playingId);
  const volume = useSoundpadStore((s) => s.volume);
  const setVolume = useSoundpadStore((s) => s.setVolume);
  const play = useSoundpadStore((s) => s.play);
  const stop = useSoundpadStore((s) => s.stop);

  // Цифры 1–9 запускают первые девять падов, пока страница открыта.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const digit = Number(e.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
      const entry = useSoundpadStore.getState().entries[digit - 1];
      if (entry) {
        e.preventDefault();
        play(entry.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play]);

  const fragments = entries.filter((entry) => entry.kind === "fragment").length;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Саундпад</div>
        <div className="page-subtitle">
          Звуки играют поверх музыки
          {entries.length > 0
            ? ` · ${entries.length} ${entries.length === 1 ? "пад" : "падов"}${fragments > 0 ? ` · ${fragments} фрагментов` : ""}`
            : ""}
        </div>
      </div>

      <div className="soundpad-toolbar">
        {playingId && (
          <button className="sp-btn secondary sp-stop-all" onClick={stop}>
            <Stop size={15} weight="fill" /> Остановить
          </button>
        )}
        <div className="sp-volume">
          <SpeakerHigh size={16} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            title={`Громкость саундпада: ${Math.round(volume * 100)}%`}
          />
        </div>
        <div className="soundpad-toolbar-spacer" />
        <button
          className="sp-btn secondary"
          onClick={() => void window.electronAPI?.openPath?.("soundpad")}
          title="Открыть папку саундпада в проводнике"
        >
          <FolderOpen size={15} /> Папка
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="soundpad-empty">
          <Apps size={44} />
          <div className="soundpad-empty-title">Пока пусто</div>
          <div className="soundpad-empty-hint">
            Включи песню и нажми <Scissors size={14} className="sp-inline-icon" /> в плеере,
            чтобы сохранить её целиком или вырезать фрагмент
          </div>
        </div>
      ) : (
        <div className="soundpad-grid">
          {entries.map((entry, index) => (
            <PadCard key={entry.id} entry={entry} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}
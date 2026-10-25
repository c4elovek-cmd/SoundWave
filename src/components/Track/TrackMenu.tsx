import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Play,
  ArrowLineUp,
  Playlist,
  Heart,
  HeartBreak,
  DownloadSimple,
  MusicNotes,
  User,
  LinkSimple,
} from "../../lib/icons";
import { SCTrack } from "../../types/soundcloud";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { downloadTrack, useDownloadStore } from "../../stores/downloadStore";
import { trackUrl } from "../../lib/soundcloudLinks";
import { logAction } from "../../lib/actionLog";
import "./TrackMenu.css";

interface Props {
  track: SCTrack;
  /** Очередь, в которую встанет «Играть». */
  queue?: SCTrack[];
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Контекстное меню трека по правому клику.
 *
 * Рендерится в портале на body: внутри горизонтальной прокрутки полок
 * position:fixed обрезался бы родителем с overflow.
 */
export default function TrackMenu({ track, queue, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const likedTracks = useAppStore((s) => s.likedTracks);
  const toggleLike = useAppStore((s) => s.toggleLike);
  const openTrack = useAppStore((s) => s.openTrack);
  const openArtist = useAppStore((s) => s.openArtist);
  const download = useDownloadStore((s) => s.downloads[track.id]);

  const liked = likedTracks.some((t) => t.id === track.id);

  // Меню не должно вылезать за край окна.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  // Закрытие: клик мимо, Esc, прокрутка, потеря фокуса окна.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  const items: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
  }[] = [
    {
      icon: <Play size={15} weight="fill" />,
      label: "Играть",
      onClick: () =>
        usePlayerStore.getState().play(track, queue && queue.length > 0 ? queue : [track], Math.max(0, (queue ?? []).findIndex((t) => t.id === track.id))),
    },
    {
      icon: <ArrowLineUp size={15} />,
      label: "Следующим",
      onClick: () => usePlayerStore.getState().playNext(track),
    },
    {
      icon: <Playlist size={15} />,
      label: "В конец очереди",
      onClick: () => usePlayerStore.getState().addToQueue(track),
    },
    {
      icon: liked ? <HeartBreak size={15} /> : <Heart size={15} weight="fill" />,
      label: liked ? "Убрать из избранного" : "В избранное",
      onClick: () => void toggleLike(track),
    },
    {
      icon: <DownloadSimple size={15} />,
      label: "Скачать",
      disabled: download?.state === "started" || download?.state === "progress",
      onClick: () => {
        logAction("track.download", { id: track.id, title: track.title });
        void downloadTrack(track.id, track.title, track.user?.username ?? "");
      },
    },
  ];

  const url = trackUrl(track);

  return createPortal(
    <div className="track-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`track-menu-item ${item.danger ? "danger" : ""}`}
          disabled={item.disabled}
          onClick={() => run(item.onClick)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}

      <div className="track-menu-sep" />

      <button
        className="track-menu-item"
        onClick={() =>
          run(() => {
            logAction("menu_open_track", { id: track.id });
            openTrack(track.id);
          })
        }
      >
        <MusicNotes size={15} />
        <span>Открыть страницу трека</span>
      </button>

      <button
        className="track-menu-item"
        disabled={!track.user?.id}
        onClick={() =>
          run(() => {
            if (track.user?.id) openArtist(track.user.id);
          })
        }
      >
        <User size={15} />
        <span>Открыть автора</span>
      </button>

      <button
        className="track-menu-item"
        disabled={!url}
        onClick={() =>
          run(() => {
            if (!url) return;
            logAction("menu_copy_link", { url });
            void navigator.clipboard?.writeText(url);
          })
        }
      >
        <LinkSimple size={15} />
        <span>Скопировать ссылку SoundCloud</span>
      </button>
    </div>,
    document.body
  );
}

import { useState } from "react";
import { Play, MusicNotes } from "../../lib/icons";
import { SCTrack } from "../../types/soundcloud";
import { usePlayerStore } from "../../stores/playerStore";
import { logAction } from "../../lib/actionLog";
import TrackMenu from "../Track/TrackMenu";

interface Props {
  track: SCTrack;
  /** Очередь, в которую играет карточка (вся полка). */
  queue: SCTrack[];
}

/**
 * Карточка трека для полок главной: обложка, название, автор.
 *
 * Клик играет трек с контекстом полки, правый клик открывает меню,
 * наведение показывает кнопку воспроизведения.
 */
export default function TrackCard({ track, queue }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const isCurrent = currentTrack?.id === track.id;

  const artwork = track.artwork_url
    ? track.artwork_url.replace("-large", "-t300x300")
    : "";

  const play = () => {
    const index = queue.findIndex((t) => t.id === track.id);
    usePlayerStore.getState().play(track, queue, Math.max(0, index));
  };

  return (
    <>
      <div
        className={`track-card ${isCurrent ? "playing" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          logAction("home_card_play", { id: track.id, title: track.title });
          if (isCurrent) {
            usePlayerStore.getState().togglePlay();
          } else {
            play();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            play();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${track.title} — ${track.user?.username ?? ""}`}
      >
        <div className="track-card-art">
          {artwork ? (
            <img src={artwork} alt="" loading="lazy" />
          ) : (
            <div className="track-card-placeholder">
              <MusicNotes size={36} weight="light" />
            </div>
          )}
          <button
            className={`track-card-play ${isCurrent && isPlaying ? "visible" : ""}`}
            aria-label="Играть"
            onClick={(e) => {
              e.stopPropagation();
              if (isCurrent) {
                usePlayerStore.getState().togglePlay();
              } else {
                play();
              }
            }}
          >
            <Play size={19} weight="fill" style={{ marginLeft: 2 }} />
          </button>
        </div>
        <div className="track-card-title">{track.title}</div>
        <div className="track-card-artist">
          {track.user?.username ?? "Неизвестный автор"}
        </div>
      </div>

      {menu && (
        <TrackMenu
          track={track}
          queue={queue}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

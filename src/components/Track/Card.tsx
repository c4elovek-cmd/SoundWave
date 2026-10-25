import { Play, MusicNotes } from "../../lib/icons";
import "./TrackRow.css";

interface Props {
  title: string;
  subtitle?: string;
  artwork: string | null;
  round?: boolean;
  onPlay?: () => void;
  onClick?: () => void;
}

export default function Card({ title, subtitle, artwork, round, onPlay, onClick }: Props) {
  return (
    <div className={`card ${round ? "round" : ""}`} onClick={onClick}>
      <div className="card-art-wrap">
        {artwork ? (
          <img src={artwork.replace("-large", "-t300x300")} alt="" />
        ) : (
          <div className="card-art-placeholder">
            <MusicNotes size={40} weight="light" />
          </div>
        )}
        {onPlay && (
          <button
            className="card-play"
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
          >
            <Play size={20} weight="fill" style={{ marginLeft: 2 }} />
          </button>
        )}
      </div>
      <div className="card-title" title={title}>{title}</div>
      {subtitle && <div className="card-sub" title={subtitle}>{subtitle}</div>}
    </div>
  );
}

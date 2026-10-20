import { Play, MusicNotes, Heart } from "@phosphor-icons/react";
import { SCTrack } from "../../types/soundcloud";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import { formatDuration, formatNumber } from "../../lib/soundcloud-api";
import "./TrackRow.css";

interface Props {
  track: SCTrack;
  index: number;
  queue?: SCTrack[];
  onLike?: (track: SCTrack) => void;
  isLiked?: boolean;
  showArtist?: boolean;
}

export default function TrackRow({
  track,
  index,
  queue,
  onLike,
  isLiked,
  showArtist = true,
}: Props) {
  const { currentTrack, isPlaying, play, togglePlay } = usePlayerStore();
  const likedTracks = useAppStore((s) => s.likedTracks);
  const toggleLike = useAppStore((s) => s.toggleLike);

  const liked = isLiked ?? likedTracks.some((item) => item.id === track.id);
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingThis = isCurrent && isPlaying;

  const artwork = track.artwork_url
    ? track.artwork_url.replace("-large", "-t120x120")
    : "";

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCurrent) {
      togglePlay();
    } else {
      play(track, queue || [track], index);
    }
  };

  return (
    <div
      className={`track-row ${isCurrent ? "playing" : ""}`}
      onDoubleClick={() => play(track, queue || [track], index)}
    >
      <div className="track-num" onClick={handlePlay}>
        {isPlayingThis ? (
          <div className="bars">
            <span />
            <span />
            <span />
          </div>
        ) : isCurrent ? (
          <Play size={13} weight="fill" className="track-num-play visible" style={{ color: "var(--accent)" }} />
        ) : (
          <>
            <span className="track-num-text">{index + 1}</span>
            <Play size={13} weight="fill" className="track-num-play" />
          </>
        )}
      </div>

      <div className="track-main">
        <div className="track-art">
          {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={18} />}
        </div>
        <div className="track-text">
          <span className="track-title" title={track.title}>
            {track.title}
          </span>
          {showArtist && (
            <span className="track-artist">{track.user?.username ?? "Неизвестный автор"}</span>
          )}
        </div>
      </div>

      <span className="track-genre">{track.genre || "—"}</span>

      <span className="track-stats">
        <Play size={11} weight="fill" />
        {formatNumber(track.playback_count || 0)}
        <Heart size={11} weight="fill" style={{ marginLeft: 8 }} />
        {formatNumber(track.likes_count || 0)}
      </span>

      <span className="track-duration">{formatDuration(track.duration)}</span>

      <button
        className={`track-like ${liked ? "liked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (onLike) onLike(track);
          else void toggleLike(track);
        }}
        title={liked ? "Убрать из избранного" : "В избранное"}
      >
        <Heart size={16} weight={liked ? "fill" : "regular"} />
      </button>
    </div>
  );
}

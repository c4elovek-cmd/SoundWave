import { Play, MusicNotes, Heart, DownloadSimple, Check } from "@phosphor-icons/react";
import { SCTrack } from "../../types/soundcloud";
import { useEffect } from "react";
import { usePlayerStore } from "../../stores/playerStore";
import { useAppStore } from "../../stores/appStore";
import {
  downloadTrack,
  ensureDownloadSubscription,
  useDownloadStore,
} from "../../stores/downloadStore";
import { formatDuration, formatNumber } from "../../lib/soundcloud-api";
import { logAction } from "../../lib/actionLog";
import { trackUrl, userUrl } from "../../lib/soundcloudLinks";
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
  const download = useDownloadStore((s) => s.downloads[track.id]);
  const likedTracks = useAppStore((s) => s.likedTracks);
  const toggleLike = useAppStore((s) => s.toggleLike);

  const liked = isLiked ?? likedTracks.some((item) => item.id === track.id);
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingThis = isCurrent && isPlaying;

  const artwork = track.artwork_url
    ? track.artwork_url.replace("-large", "-t120x120")
    : "";

  // События скачивания приходят из бэкенда — одно на всё приложение.
  useEffect(() => {
    ensureDownloadSubscription();
  }, []);

  /** Открывает страницу трека или автора в браузере. */
  const openLink = (e: React.MouseEvent, url: string | null) => {
    e.stopPropagation();
    if (!url) return;
    logAction("open_external", { url });
    void window.electronAPI?.openExternal?.(url);
  };

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
          {artwork ? (
            <img
              src={artwork}
              alt=""
              onClick={(e) => openLink(e, trackUrl(track))}
              title="Открыть страницу трека"
            />
          ) : (
            <MusicNotes
              size={18}
              onClick={(e) => openLink(e, trackUrl(track))}
            />
          )}
        </div>
        <div className="track-text">
          <span
            className="track-title track-title-link"
            title={`${track.title} — открыть на SoundCloud`}
            onClick={(e) => openLink(e, trackUrl(track))}
          >
            {track.title}
          </span>
          {showArtist && (
            <span
              className="track-artist track-artist-link"
              title="Открыть страницу автора"
              onClick={(e) => openLink(e, userUrl(track.user ?? {}))}
            >
              {track.user?.username ?? "Неизвестный автор"}
            </span>
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
        className={`track-download ${download?.state ?? ""}`}
        onClick={(e) => {
          e.stopPropagation();
          logAction("track.download", { id: track.id, title: track.title });
          void downloadTrack(
            track.id,
            track.title,
            track.user?.username ?? ""
          );
        }}
        title="Скачать трек"
        aria-label="Скачать трек"
        disabled={download?.state === "started" || download?.state === "progress"}
      >
        {download?.state === "done" ? (
          <Check size={16} weight="bold" style={{ color: "var(--success)" }} />
        ) : download?.state === "started" || download?.state === "progress" ? (
          <span className="track-download-percent">{download.percent}%</span>
        ) : download?.state === "error" ? (
          <span className="track-download-percent" title={download.error}>
            !
          </span>
        ) : (
          <DownloadSimple size={16} />
        )}
      </button>

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

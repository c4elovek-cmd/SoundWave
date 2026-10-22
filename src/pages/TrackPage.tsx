import { useEffect, useState } from "react";
import {
  Play,
  Heart,
  DownloadSimple,
  MusicNotes,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { scApi } from "../lib/soundcloud-api";
import { errorText } from "../lib/errorText";
import { usePlayerStore } from "../stores/playerStore";
import { useAppStore } from "../stores/appStore";
import { downloadTrack } from "../stores/downloadStore";
import { logAction } from "../lib/actionLog";
import { SCTrack } from "../types/soundcloud";
import "./Pages.css";

/**
 * Страница трека — как на SoundCloud, но в нашем оформлении.
 *
 * Открывается из списков: клик по обложке или названию.
 */
export default function TrackPage({ trackId }: { trackId: number }) {
  const [track, setTrack] = useState<SCTrack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { play, currentTrack, isPlaying, togglePlay } = usePlayerStore();
  const openArtist = useAppStore((s) => s.openArtist);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    scApi
      .getTrack(trackId)
      .then((data) => {
        if (alive) setTrack(data);
      })
      .catch((e) => {
        if (alive) setError(errorText(e, "Не удалось загрузить трек"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [trackId]);

  if (loading) {
    return <div className="empty-state">Загружаем трек…</div>;
  }

  if (error || !track) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <MusicNotes size={28} />
        </div>
        {error ?? "Трек не найден"}
      </div>
    );
  }

  const artwork = track.artwork_url
    ? track.artwork_url.replace("-large", "-t300x300")
    : "";
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingThis = isCurrent && isPlaying;

  return (
    <div className="detail-page">
      <div className="detail-head">
        <div className="detail-art">
          {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={40} />}
        </div>

        <div className="detail-info">
          <span className="detail-kind">Трек</span>
          <h1 className="detail-title">{track.title}</h1>

          <button
            className="detail-user"
            onClick={() => openArtist(track.user?.id ?? 0)}
            title="Открыть страницу автора"
          >
            {track.user?.avatar_url && (
              <img src={track.user.avatar_url} alt="" />
            )}
            <span>{track.user?.username ?? "Неизвестный автор"}</span>
          </button>

          {track.description && (
            <p className="detail-description">{track.description}</p>
          )}

          <div className="detail-stats">
            <span>▶ {track.playback_count ?? 0}</span>
            <span>♥ {track.likes_count ?? 0}</span>
            {track.genre && <span>{track.genre}</span>}
          </div>

          <div className="detail-actions">
            <button
              className="btn-accent"
              onClick={() => {
                if (isCurrent) togglePlay();
                else play(track, [track], 0);
              }}
            >
              <Play size={16} weight="fill" />
              {isPlayingThis ? "Пауза" : "Слушать"}
            </button>

            <button
              className="btn-ghost"
              onClick={() => {
                logAction("track.download", { id: track.id });
                void downloadTrack(
                  track.id,
                  track.title,
                  track.user?.username ?? ""
                );
              }}
              title="Скачать трек"
            >
              <DownloadSimple size={16} />
              Скачать
            </button>

            {track.permalink_url && (
              <button
                className="btn-ghost"
                onClick={() => {
                  logAction("open_external", { url: track.permalink_url });
                  void window.electronAPI?.openExternal?.(track.permalink_url);
                }}
                title="Открыть на SoundCloud"
              >
                <ArrowSquareOut size={16} />
                SoundCloud
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

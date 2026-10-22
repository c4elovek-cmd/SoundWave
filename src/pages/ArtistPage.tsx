import { useEffect, useState } from "react";
import { MusicNotes, ArrowSquareOut } from "@phosphor-icons/react";
import { scApi } from "../lib/soundcloud-api";
import { errorText } from "../lib/errorText";
import { useAppStore } from "../stores/appStore";
import { logAction } from "../lib/actionLog";
import { SCTrack, SCUser } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import "./Pages.css";

/**
 * Страница автора — как на SoundCloud, но в нашем оформлении.
 *
 * Открывается кликом по имени автора или по аватару в плеере.
 */
export default function ArtistPage({ artistId }: { artistId: number }) {
  const [artist, setArtist] = useState<SCUser | null>(null);
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const openTrack = useAppStore((s) => s.openTrack);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    scApi
      .getUserTracks(artistId, 50)
      .then((res) => {
        if (!alive) return;
        const items = (res as any).collection ?? [];
        setTracks(items.map((i: any) => i.track ?? i).filter(Boolean));
      })
      .catch((e) => {
        if (alive) setError(errorText(e, "Не удалось загрузить треки автора"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    // Карточка автора — отдельный запрос профиля.
    scApi
      .getUser(artistId)
      .then((user) => {
        if (alive) setArtist(user);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [artistId]);

  const avatar = artist?.avatar_url
    ? artist.avatar_url.replace("-large", "-t300x300")
    : "";

  return (
    <div className="detail-page">
      <div className="detail-head">
        <div className="detail-art round">
          {avatar ? <img src={avatar} alt="" /> : <MusicNotes size={40} />}
        </div>

        <div className="detail-info">
          <span className="detail-kind">Автор</span>
          <h1 className="detail-title">{artist?.username ?? "Автор"}</h1>
          {artist?.full_name && (
            <span className="detail-subtitle">{artist.full_name}</span>
          )}

          <div className="detail-stats">
            {artist?.followers_count != null && (
              <span>Подписчиков: {artist.followers_count}</span>
            )}
            {artist?.track_count != null && (
              <span>Треков: {artist.track_count}</span>
            )}
          </div>

          {artist?.permalink_url && (
            <button
              className="btn-ghost"
              onClick={() => {
                const url = artist.permalink_url as string;
                logAction("open_external", { url });
                void window.electronAPI?.openExternal?.(url);
              }}
              title="Открыть на SoundCloud"
            >
              <ArrowSquareOut size={16} />
              SoundCloud
            </button>
          )}
        </div>
      </div>

      <h2 className="detail-section">Треки автора</h2>

      {error ? (
        <div className="empty-state">{error}</div>
      ) : loading ? (
        <div className="empty-state">Загружаем треки…</div>
      ) : tracks.length ? (
        <div className="track-list">
          {tracks.map((track, i) => (
            <TrackRow key={track.id} track={track} index={i} queue={tracks} />
          ))}
        </div>
      ) : (
        <div className="empty-state">У автора нет треков</div>
      )}
    </div>
  );
}

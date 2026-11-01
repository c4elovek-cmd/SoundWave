import { useEffect, useState } from "react";
import { ArrowSquareOut, MusicNotes, Play } from "../lib/icons";
import { scApi } from "../lib/soundcloud-api";
import { errorText } from "../lib/errorText";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { useDownloadStore, downloadTracks } from "../stores/downloadStore";
import { logAction } from "../lib/actionLog";
import { formatDuration } from "../lib/soundcloud-api";
import { SCPlaylist } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import "./Pages.css";

/**
 * Страница плейлиста — список треков с кнопками «слушать всё» и
 * «скачать всё». Открывается кликом по плейлисту в боковой панели.
 */
export default function PlaylistPage({ playlistId }: { playlistId: number }) {
  const [playlist, setPlaylist] = useState<SCPlaylist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const play = usePlayerStore((s) => s.play);
  const batch = useDownloadStore((s) => s.batch);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    scApi
      .getPlaylist(playlistId)
      .then((data) => {
        if (!alive) return;
        setPlaylist(data);
      })
      .catch((e) => {
        if (alive) setError(errorText(e, "Не удалось загрузить плейлист"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [playlistId]);

  const tracks = playlist?.tracks ?? [];
  const artwork = playlist?.artwork_url
    ? playlist.artwork_url.replace("-large", "-t500x500")
    : "";
  const batchRunning = batch !== null;

  return (
    <div className="detail-page">
      <div className="detail-head">
        <div className="detail-art">
          {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={40} />}
        </div>

        <div className="detail-info">
          <span className="detail-kind">Плейлист</span>
          <h1 className="detail-title">{playlist?.title ?? "Плейлист"}</h1>
          {playlist?.user?.username && (
            <span className="detail-subtitle">
              {playlist.user.username}
              {playlist.track_count != null ? ` · ${playlist.track_count} треков` : ""}
              {playlist.duration ? ` · ${formatDuration(playlist.duration)}` : ""}
            </span>
          )}

          <div className="playlist-actions">
            {tracks.length > 0 && (
              <button
                className="big-play"
                onClick={() => play(tracks[0], tracks, 0)}
                title="Слушать всё"
              >
                <Play size={24} weight="fill" style={{ marginLeft: 3 }} />
              </button>
            )}

            {tracks.length > 0 && (
              <button
                className="btn-ghost"
                disabled={batchRunning}
                onClick={() => {
                  logAction("playlist.download_all", { id: playlistId, count: tracks.length });
                  void downloadTracks(tracks, playlist?.title ?? "Плейлист");
                }}
                title={
                  batchRunning
                    ? "Дождитесь окончания текущего скачивания"
                    : "Скачать все треки плейлиста"
                }
              >
                {batch && batch.label === (playlist?.title ?? "Плейлист")
                  ? `Скачиваю… ${batch.done + batch.failed}/${batch.total}`
                  : "Скачать всё"}
              </button>
            )}

            {playlist?.permalink_url && (
              <button
                className="btn-ghost"
                onClick={() => {
                  const url = playlist.permalink_url;
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
      </div>

      {error ? (
        <div className="empty-state">{error}</div>
      ) : loading ? (
        <div className="empty-state">Загружаем плейлист…</div>
      ) : tracks.length ? (
        <div className="track-list">
          {tracks.map((track, i) => (
            <TrackRow key={track.id} track={track} index={i} queue={tracks} />
          ))}
        </div>
      ) : (
        <div className="empty-state">В плейлисте нет треков</div>
      )}
    </div>
  );
}

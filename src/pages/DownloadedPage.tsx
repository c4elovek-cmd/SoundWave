import { useCallback, useEffect, useState } from "react";
import { DownloadSimple, FolderOpen, MusicNotes, Play } from "../lib/icons";
import { usePlayerStore } from "../stores/playerStore";
import { formatFileSize } from "../lib/localFiles";
import { logAction } from "../lib/actionLog";
import { SCTrack } from "../types/soundcloud";
import "./Pages.css";

/** Запись из папки загрузок — то, что отдаёт бэкенд. */
interface DownloadEntry {
  file: string;
  path: string;
  size: number;
  modified: number;
}

/** Стабильный числовой id для псевдо-трека: хеш полного пути. */
function hashPath(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  // Отрицательный id не пересечётся с настоящими id SoundCloud.
  return -(Math.abs(hash) % 1_000_000_000) - 1;
}

/**
 * Имя файла «Артист - Трек.mp3» → псевдо-трек для плеера.
 *
 * Артист и название парсим по первому « - » — именно в таком виде
 * файлы пишет кнопка скачивания.
 */
function entryToTrack(entry: DownloadEntry): SCTrack {
  const base = entry.file.replace(/\.mp3$/i, "");
  const dash = base.indexOf(" - ");
  const artist = dash > 0 ? base.slice(0, dash) : "Неизвестный автор";
  const title = dash > 0 ? base.slice(dash + 3) : base;

  return {
    id: hashPath(entry.path),
    title,
    user: {
      id: 0,
      username: artist,
      full_name: "",
      avatar_url: "",
    },
    artwork_url: null,
    waveform_url: "",
    duration: 0,
    genre: null,
    tag_list: "",
    label_name: null,
    playback_count: 0,
    likes_count: 0,
    reposts_count: 0,
    permalink_url: "",
    stream_url: "",
    downloadable: false,
    created_at: new Date(entry.modified || 0).toISOString(),
    description: null,
    localPath: entry.path,
    localSize: entry.size,
  };
}

/**
 * Страница «Скачанные»: все mp3 из папки загрузок.
 *
 * Играется прямо с диска — работает и без интернета. Артист и название
 * взяты из имени файла, поэтому обложки и статистики здесь нет.
 */
export default function DownloadedPage() {
  const [entries, setEntries] = useState<DownloadEntry[] | null>(null);
  const play = usePlayerStore((s) => s.play);

  const load = useCallback(() => {
    void window.electronAPI
      ?.listDownloads?.()
      .then((list) => setEntries(list ?? []))
      .catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tracks = (entries ?? []).map(entryToTrack);
  const totalSize = (entries ?? []).reduce((sum, entry) => sum + entry.size, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Скачанные</div>
        <div className="page-subtitle">
          Треки из папки загрузок · играются с диска, интернет не нужен
          {tracks.length > 0 ? ` · ${tracks.length} треков` : ""}
          {totalSize > 0 ? ` · ${formatFileSize(totalSize)}` : ""}
        </div>
      </div>

      {entries === null && (
        <div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-row" />
          ))}
        </div>
      )}

      {entries !== null && tracks.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            <DownloadSimple size={30} />
          </div>
          <div className="empty-title">Пока ничего не скачано</div>
          <div className="empty-text">
            Скачай трек или весь плейлист кнопкой «Скачать всё» — они появятся здесь.
          </div>
        </div>
      )}

      {tracks.length > 0 && (
        <>
          <div className="playlist-actions">
            <button
              className="big-play"
              onClick={() => play(tracks[0], tracks, 0)}
              title="Слушать всё"
            >
              <Play size={24} weight="fill" style={{ marginLeft: 3 }} />
            </button>

            <button
              className="btn-ghost"
              onClick={() => {
                logAction("downloads_open_folder");
                void window.electronAPI?.openPath?.("downloads");
              }}
              title="Открыть папку загрузок"
            >
              <FolderOpen size={16} style={{ marginRight: 6, verticalAlign: -2 }} />
              Открыть папку
            </button>
          </div>

          <div className="track-list-header">
            <span>#</span>
            <span>Трек</span>
            <span />
            <span />
            <span className="right">Размер</span>
            <span />
            <span />
          </div>

          {tracks.map((track, i) => {
            return (
              <div
                key={track.id}
                className="track-row"
                onDoubleClick={() => play(track, tracks, i)}
                title="Играть с диска"
              >
                <div
                  className="track-num"
                  onClick={() => play(track, tracks, i)}
                >
                  <span className="track-num-text">{i + 1}</span>
                  <Play size={13} weight="fill" className="track-num-play" />
                </div>

                <div className="track-main">
                  <div className="track-art">
                    <MusicNotes size={18} />
                  </div>
                  <div className="track-text">
                    <span
                      className="track-title"
                      onClick={() => play(track, tracks, i)}
                    >
                      {track.title}
                    </span>
                    <span className="track-artist">{track.user.username}</span>
                  </div>
                </div>

                <span className="track-genre" />

                <span className="track-stats" />

                <span className="track-duration">
                  {formatFileSize(track.localSize ?? 0)}
                </span>

                <span />
                <span />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

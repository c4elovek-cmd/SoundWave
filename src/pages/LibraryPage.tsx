import { useEffect, useState } from "react";
import { Heart, CloudArrowUp, MusicNotes, Play } from "@phosphor-icons/react";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { scApi } from "../lib/soundcloud-api";
import { SCTrack } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import "./Pages.css";

type Mode = "likes" | "uploads";

interface Props {
  mode: Mode;
}

export default function LibraryPage({ mode }: Props) {
  const { isLoggedIn, currentUser, setLikedTracks, setUploadedTracks } = useAppStore();
  const { play } = usePlayerStore();
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = async () => {
    if (!isLoggedIn) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // limit=100 — SoundCloud отдаёт максимум ~100 лайков за раз,
      // а счётчик likes_count может быть больше (часть лайков API не отдаёт)
      const res =
        mode === "likes"
          ? await scApi.getMyLikes(currentUser?.id, 100)
          : await scApi.getMyTracks(currentUser?.id, 100);
      const items = (res as any).collection ?? [];
      const list: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);
      setTracks(list);
      setNextHref((res as any).next_href ?? null);
      if (mode === "likes") setLikedTracks(list);
      else setUploadedTracks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [mode, isLoggedIn]);

  const loadMore = async () => {
    if (!nextHref || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await scApi.loadNext<any>(nextHref);
      const items = res.collection ?? [];
      const list: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);
      setTracks((prev) => [...prev, ...list]);
      // Пустая страница — значит, дальше треков нет
      setNextHref(list.length > 0 ? res.next_href ?? null : null);
    } finally {
      setLoadingMore(false);
    }
  };

  const title = mode === "likes" ? "Мне нравится" : "Мои загрузки";
  const subtitle =
    mode === "likes" ? "Треки, которые ты лайкнул" : "Треки, которые ты загрузил";

  if (!isLoggedIn) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="page-title">{title}</div>
        </div>
        <div className="empty-state">
          <div className="empty-icon">
            {mode === "likes" ? <Heart size={30} /> : <CloudArrowUp size={30} />}
          </div>
          <div className="empty-title">Нужен вход</div>
          <div className="empty-text">Войди в аккаунт SoundCloud, чтобы видеть эту коллекцию.</div>
          <button
            className="btn-accent"
            style={{ marginTop: 8 }}
            onClick={() => window.electronAPI?.openAuthWindow()}
          >
            Войти
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">{title}</div>
        <div className="page-subtitle">
          {subtitle}
          {tracks.length > 0 ? ` · ${tracks.length} треков` : ""}
        </div>
        {/* SoundCloud считает лайки по-своему, но часть из них API не отдаёт */}
        {mode === "likes" &&
          currentUser?.likes_count != null &&
          tracks.length > 0 &&
          currentUser.likes_count > tracks.length && (
            <div className="page-subtitle" style={{ opacity: 0.6, marginTop: 2 }}>
              SoundCloud не отдаёт {currentUser.likes_count - tracks.length} скрытых лайков
            </div>
          )}
      </div>

      {loading && (
        <div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-row" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="empty-state">
          <div className="empty-icon">
            <MusicNotes size={30} />
          </div>
          <div className="empty-title">{error}</div>
          <button className="btn-ghost" onClick={load} style={{ marginTop: 8 }}>
            Повторить
          </button>
        </div>
      )}

      {!loading && !error && tracks.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            {mode === "likes" ? <Heart size={30} /> : <CloudArrowUp size={30} />}
          </div>
          <div className="empty-title">Пока пусто</div>
          <div className="empty-text">
            {mode === "likes"
              ? "Лайкай треки на SoundCloud — они появятся здесь."
              : "Загрузи трек на SoundCloud — он появится здесь."}
          </div>
        </div>
      )}

      {!loading && !error && tracks.length > 0 && (
        <>
          <div className="playlist-actions">
            <button
              className="big-play"
              onClick={() => play(tracks[0], tracks, 0)}
              title="Слушать всё"
            >
              <Play size={24} weight="fill" style={{ marginLeft: 3 }} />
            </button>
          </div>

          <div className="track-list-header">
            <span>#</span>
            <span>Трек</span>
            <span>Жанр</span>
            <span>Статистика</span>
            <span className="right">Время</span>
            <span />
          </div>

          {tracks.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={i}
              queue={tracks}
              isLiked={mode === "likes"}
            />
          ))}

          {nextHref && (
            <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
              <button className="btn-ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Загрузка..." : "Загрузить ещё"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

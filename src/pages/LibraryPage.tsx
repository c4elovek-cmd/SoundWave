import { useEffect, useRef, useState } from "react";
import { DownloadSimple, Heart, CloudArrowUp, MusicNotes, Play } from "../lib/icons";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { downloadTracks, useDownloadStore } from "../stores/downloadStore";
import { logAction } from "../lib/actionLog";
import { scApi } from "../lib/soundcloud-api";
import { SCTrack } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import "./Pages.css";
import { errorText } from "../lib/errorText";
import { useNetworkStore } from "../stores/networkStore";

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

  // Актуальные значения для колбэков, которые живут вне рендера
  // (источник долива очереди и наблюдатель за низом списка).
  const tracksRef = useRef<SCTrack[]>([]);
  const nextHrefRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    nextHrefRef.current = nextHref;
  }, [nextHref]);

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
      setNextHref((res as any).next_href ?? null);
      const list: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);

      if (mode === "likes") {
        // В сторе список дополнен свежими лайками — показываем его.
        setLikedTracks(list);
        setTracks(useAppStore.getState().likedTracks);
      } else {
        setTracks(list);
        setUploadedTracks(list);
      }
    } catch (e) {
      setError(errorText(e, "Ошибка загрузки"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();

    // Автоматическое обновление списка при восстановлении сети
    return useNetworkStore.getState().onReconnect(() => {
      void load();
    });
  }, [mode, isLoggedIn]);

  /**
   * Тянет следующую страницу списка. Возвращает добавленные треки —
   * этим пользуется и кнопка «Загрузить ещё», и очередь плеера.
   * При сетевом сбое бросает исключение: очередь по нему понимает,
   * что список не исчерпан, и попробует ещё раз на следующем треке.
   */
  const fetchNextPage = async (): Promise<SCTrack[]> => {
    const href = nextHrefRef.current;
    if (!href) return [];
    if (loadingMoreRef.current) throw new Error("Страница уже загружается");

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await scApi.loadNext<any>(href);
      const items = res.collection ?? [];
      const list: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);

      if (list.length > 0) {
        setTracks((prev) => [...prev, ...list]);
        // Пустой next_href — значит, дальше треков нет
        setNextHref(res.next_href ?? null);

        if (mode === "likes") {
          setLikedTracks([...useAppStore.getState().likedTracks, ...list]);
        } else {
          setUploadedTracks([...useAppStore.getState().uploadedTracks, ...list]);
        }
      } else {
        setNextHref(null);
      }

      return list;
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const loadMore = () => void fetchNextPage().catch(() => {});

  // Источник долива для плеера: пока играет трек из этого списка,
  // следующая страница подтягивается сама — очередь не обрывается
  // на границе первой сотни треков.
  useEffect(() => {
    const loader = async (): Promise<SCTrack[]> => {
      const player = usePlayerStore.getState();
      const current = player.currentTrack;
      if (!current) return [];
      // Слушают другой список — не подмешиваем в его очередь наши треки.
      if (!tracksRef.current.some((track) => track.id === current.id)) return [];
      return fetchNextPage();
    };

    usePlayerStore.getState().setQueueLoader(loader);
    return () => usePlayerStore.getState().setQueueLoader(null);
  }, [mode, isLoggedIn]);

  // Список догружается и сам, когда до низа остаётся один экран.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextHref) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "400px 0px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [nextHref, mode, isLoggedIn]);

  const title = mode === "likes" ? "Мне нравится" : "Мои загрузки";
  const subtitle =
    mode === "likes" ? "Треки, которые ты лайкнул" : "Треки, которые ты загрузил";

  const batch = useDownloadStore((s) => s.batch);

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

            <button
              className="btn-ghost"
              disabled={Boolean(batch)}
              onClick={() => {
                logAction("library.download_all", { mode, count: tracks.length });
                void downloadTracks(tracks, title);
              }}
              title={
                batch
                  ? "Дождитесь окончания текущего скачивания"
                  : "Скачать все треки списка"
              }
            >
              {batch
                ? `Скачиваю… ${batch.done + batch.failed}/${batch.total}`
                : (
                  <>
                    <DownloadSimple size={16} style={{ marginRight: 6, verticalAlign: -2 }} />
                    Скачать всё
                  </>
                )}
            </button>
          </div>

          <div className="track-list-header">
            <span>#</span>
            <span>Трек</span>
            <span>Жанр</span>
            <span>Статистика</span>
            <span className="right">Время</span>
            <span />
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
            <div
              ref={sentinelRef}
              style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}
            >
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

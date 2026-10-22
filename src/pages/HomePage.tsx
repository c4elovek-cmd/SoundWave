import { useEffect, useState } from "react";
import { MusicNotes, ArrowClockwise } from "@phosphor-icons/react";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { logAction } from "../lib/actionLog";
import { scApi } from "../lib/soundcloud-api";
import { SCTrack, SCUser, SCPlaylist } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import Card from "../components/Track/Card";
import "./Pages.css";
import { errorText } from "../lib/errorText";
import { useNetworkStore } from "../stores/networkStore";

/** Жанры и настроения для главной — как карточки на SoundCloud. */
const MOODS = [
  { title: "Хип-хоп", subtitle: "Ритм и бит", query: "hip hop", from: "#ff5500", to: "#c2410c" },
  { title: "Электроника", subtitle: "Бит и синтез", query: "electronic", from: "#7c3aed", to: "#4c1d95" },
  { title: "Рок", subtitle: "Гитары и драйв", query: "rock", from: "#dc2626", to: "#7f1d1d" },
  { title: "Поп", subtitle: "Хиты сегодня", query: "pop", from: "#ec4899", to: "#9d174d" },
  { title: "Джаз", subtitle: "Живые инструменты", query: "jazz", from: "#0ea5e9", to: "#075985" },
  { title: "Чилл", subtitle: "Спокойный фон", query: "chill", from: "#14b8a6", to: "#0f766e" },
  { title: "Классика", subtitle: "Оркестр и скрипки", query: "classical", from: "#6366f1", to: "#3730a3" },
  { title: "Эмбиент", subtitle: "Для работы и сна", query: "ambient", from: "#64748b", to: "#1e293b" },
];

export default function HomePage() {
  const {
    isLoggedIn,
    currentUser,
    likedTracks,
    setLikedTracks,
    setSearchQuery,
    setView,
  } = useAppStore();
  const { play } = usePlayerStore();
  const [recommended, setRecommended] = useState<SCTrack[]>([]);
  const [artists, setArtists] = useState<SCUser[]>([]);
  const [playlists, setPlaylists] = useState<SCPlaylist[]>([]);
  const [trending, setTrending] = useState<SCTrack[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Для гостей показываем популярное — charts SoundCloud доступен без входа
  useEffect(() => {
    if (isLoggedIn) return;
    let cancelled = false;

    scApi
      .getTrending(20)
      .then((res) => {
        if (!cancelled) setTrending(res.collection ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTrendingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const userId = currentUser?.id;
      const results = await Promise.allSettled([
        scApi.getMyLikes(userId, 20),
        scApi.getMyFollowings(userId, 12),
        scApi.getMyPlaylists(userId, 10),
      ]);

      if (results[0].status === "fulfilled") {
        const items = (results[0].value as any).collection ?? [];
        const tracks: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);
        setRecommended(tracks);
        setLikedTracks(tracks);
      }
      if (results[1].status === "fulfilled") {
        setArtists((results[1].value as any).collection ?? []);
      }
      if (results[2].status === "fulfilled") {
        const items = (results[2].value as any).collection ?? [];
        setPlaylists(items.map((i: any) => i.playlist ?? i).filter(Boolean));
      }

      if (results.every((r) => r.status === "rejected")) {
        setError("Не удалось загрузить данные SoundCloud");
      }
    } catch (e) {
      setError(errorText(e, "Ошибка загрузки"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isLoggedIn) load();
    else setLoading(false);

    // Автоматическое обновление данных при восстановлении сети
    return useNetworkStore.getState().onReconnect(() => {
      if (isLoggedIn) void load();
    });
  }, [isLoggedIn]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "Доброй ночи";
    if (h < 12) return "Доброе утро";
    if (h < 18) return "Доброго дня";
    return "Добрый вечер";
  })();

  if (!isLoggedIn) {
    return (
      <div className="page">
        <div className="hero">
          <div className="hero-title">Добро пожаловать в SoundWave</div>
          <div className="hero-sub">
            Десктопный клиент SoundCloud. Войди в свой аккаунт, чтобы слушать лайки,
            подписки и загрузки без браузера.
          </div>
          <div className="hero-actions">
            <button
              className="btn-accent"
              onClick={() => window.electronAPI?.openAuthWindow()}
            >
              Войти в SoundCloud
            </button>
          </div>
        </div>

        {trendingLoading && (
          <div className="section">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton skeleton-row" />
            ))}
          </div>
        )}

        {trending.length > 0 && (
          <div className="section">
            <div className="section-header">
              <span className="section-title">Популярное сейчас</span>
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
            {trending.map((track, i) => (
              <TrackRow key={track.id} track={track} index={i} queue={trending} />
            ))}
          </div>
        )}

        {/* Жанры и настроения — как на SoundCloud, но в нашем оформлении */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">Жанры и настроения</span>
          </div>
          <div className="mood-grid">
            {MOODS.map((mood) => (
              <button
                key={mood.title}
                className="mood-card"
                style={{
                  background: `linear-gradient(135deg, ${mood.from}, ${mood.to})`,
                }}
                onClick={() => {
                  logAction("mood", { mood: mood.query });
                  setSearchQuery(mood.query);
                  setView("search");
                }}
                title={`Найти: ${mood.query}`}
              >
                <span className="mood-title">{mood.title}</span>
                <span className="mood-subtitle">{mood.subtitle}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {!loading && !error && (
        <div className="hero">
          <div className="hero-title">
            {greeting}{currentUser ? `, ${currentUser.username}` : ""}
          </div>
          <div className="hero-sub">
            Твоя музыка собрана в одном месте. Лайки, подписки и плейлисты — всё под рукой.
          </div>
          <div className="hero-actions">
            {recommended.length > 0 && (
              <button
                className="btn-accent"
                onClick={() => play(recommended[0], recommended, 0)}
              >
                Слушать избранное
              </button>
            )}
            <button className="btn-ghost" onClick={load}>
              <ArrowClockwise size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
              Обновить
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="section">
          {Array.from({ length: 6 }).map((_, i) => (
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
          <div className="empty-text">
            Проверь подключение к интернету или попробуй войти заново.
          </div>
          <button className="btn-ghost" onClick={load} style={{ marginTop: 8 }}>
            Повторить
          </button>
        </div>
      )}

      {!loading && !error && recommended.length > 0 && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Любимые треки</span>
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
          {recommended.map((track, i) => (
            <TrackRow key={track.id} track={track} index={i} queue={recommended} />
          ))}
        </div>
      )}

      {!loading && artists.length > 0 && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Твои артисты</span>
          </div>
          <div className="card-grid">
            {artists.map((artist) => (
              <Card
                key={artist.id}
                title={artist.username}
                subtitle={`${artist.track_count ?? 0} треков`}
                artwork={artist.avatar_url}
                round
              />
            ))}
          </div>
        </div>
      )}

      {!loading && playlists.length > 0 && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Твои плейлисты</span>
          </div>
          <div className="card-grid">
            {playlists.map((pl) => (
              <Card
                key={pl.id}
                title={pl.title}
                subtitle={`${pl.track_count} треков`}
                artwork={pl.artwork_url}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !error && recommended.length === 0 && playedEmpty(likedTracks) && (
        <div className="empty-state">
          <div className="empty-icon">
            <MusicNotes size={30} />
          </div>
          <div className="empty-title">Пока тихо</div>
          <div className="empty-text">
            Лайкай треки в SoundCloud — они появятся здесь. Или зайди в поиск и найди
            что-нибудь новое.
          </div>
        </div>
      )}

      {/* Жанры и настроения — как на SoundCloud, но в нашем оформлении */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Жанры и настроения</span>
        </div>
        <div className="mood-grid">
          {MOODS.map((mood) => (
            <button
              key={mood.title}
              className="mood-card"
              style={{
                background: `linear-gradient(135deg, ${mood.from}, ${mood.to})`,
              }}
              onClick={() => {
                logAction("mood", { mood: mood.query });
                setSearchQuery(mood.query);
                setView("search");
              }}
              title={`Найти: ${mood.query}`}
            >
              <span className="mood-title">{mood.title}</span>
              <span className="mood-subtitle">{mood.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function playedEmpty(arr: SCTrack[]) {
  return arr.length === 0;
}

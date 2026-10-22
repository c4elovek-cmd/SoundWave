import { useEffect } from "react";
import { MusicNotes, ArrowClockwise } from "@phosphor-icons/react";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { logAction } from "../lib/actionLog";
import TrackRow from "../components/Track/TrackRow";
import Card from "../components/Track/Card";
import "./Pages.css";
import { useNetworkStore } from "../stores/networkStore";
import { useHomeStore } from "../stores/homeStore";

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
  const { isLoggedIn, currentUser, likedTracks, setSearchQuery, setView } =
    useAppStore();
  const { play } = usePlayerStore();

  // Данные главной живут в сторе: при возврате на страницу они уже на месте,
  // поэтому скелетоны не мелькают.
  const {
    recommended,
    artists,
    playlists,
    trending,
    loading,
    trendingLoading,
    error,
    load,
    loadTrending,
    reset,
  } = useHomeStore();

  // Для гостей показываем популярное — charts SoundCloud доступен без входа
  useEffect(() => {
    if (isLoggedIn) return;
    void loadTrending();
  }, [isLoggedIn]);

  useEffect(() => {
    if (isLoggedIn) {
      // Первый вход — с скелетонами; повторный — тихое обновление в фоне.
      void load();
    } else {
      reset();
    }

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
            <button className="btn-ghost" onClick={() => void load({ force: true })}>
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
          <button
            className="btn-ghost"
            onClick={() => void load({ force: true })}
            style={{ marginTop: 8 }}
          >
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

      {!loading && !error && recommended.length === 0 && likedTracks.length === 0 && (
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

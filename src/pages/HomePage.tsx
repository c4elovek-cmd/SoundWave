import { useEffect } from "react";
import { MusicNotes, ArrowClockwise } from "@phosphor-icons/react";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { logAction } from "../lib/actionLog";
import "./Pages.css";
import { useNetworkStore } from "../stores/networkStore";
import { useHomeStore } from "../stores/homeStore";
import { useHistoryStore } from "../stores/historyStore";
import Shelf from "../components/Home/Shelf";
import TrackCard from "../components/Home/TrackCard";
import Card from "../components/Track/Card";
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

/** Полка карточек-скелетонов на время первой загрузки. */
function ShelfSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="section shelf">
      <div className="skeleton skeleton-title" />
      <div className="shelf-scroll">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="track-card-skeleton">
            <div className="skeleton skeleton-square" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const { isLoggedIn, currentUser, setSearchQuery, setView } = useAppStore();

  // Данные главной живут в сторе: при возврате на страницу они уже на месте,
  // поэтому скелетоны не мелькают.
  const {
    recommended,
    artists,
    playlists,
    trending,
    more,
    loading,
    trendingLoading,
    error,
    load,
    loadTrending,
    reset,
  } = useHomeStore();

  const history = useHistoryStore((s) => s.tracks);

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

  /** Сетка жанров — общая для гостя и для залогиненного. */
  const moodGrid = (
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
  );

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

        {trendingLoading && <ShelfSkeleton />}

        {trending.length > 0 && (
          <Shelf title="Популярное сейчас">
            {trending.map((track) => (
              <TrackCard key={track.id} track={track} queue={trending} />
            ))}
          </Shelf>
        )}

        {moodGrid}
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
                className="hero-liked"
                onClick={() => setView("likes")}
                title="Открыть любимые треки"
              >
                <div className="hero-liked-art">
                  {recommended[0].artwork_url ? (
                    <img
                      src={recommended[0].artwork_url.replace("-large", "-t120x120")}
                      alt=""
                    />
                  ) : (
                    <MusicNotes size={22} weight="light" />
                  )}
                </div>
                <div className="hero-liked-info">
                  <span className="hero-liked-title">Любимые треки</span>
                  <span className="hero-liked-sub">{recommended.length} треков</span>
                </div>
              </button>
            )}
            {recommended.length > 0 && (
              <button
                className="btn-accent"
                onClick={() =>
                  usePlayerStore.getState().play(recommended[0], recommended, 0)
                }
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
        <>
          <ShelfSkeleton />
          <ShelfSkeleton count={4} />
        </>
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

      {!loading && !error && history.length > 0 && (
        <Shelf title="Недавно слушал">
          {history.slice(0, 12).map((track) => (
            <TrackCard key={`h-${track.id}`} track={track} queue={history.slice(0, 12)} />
          ))}
        </Shelf>
      )}

      {!loading && !error && recommended.length > 0 && (
        <Shelf
          title="Любимые треки"
          action={
            recommended.length > 0
              ? { label: `Показать все (${recommended.length})`, onClick: () => setView("likes") }
              : undefined
          }
        >
          {recommended.slice(0, 12).map((track) => (
            <TrackCard key={track.id} track={track} queue={recommended} />
          ))}
        </Shelf>
      )}

      {!loading && more.length > 0 && (
        <Shelf title="Похоже на то, что ты любишь">
          {more.map((track) => (
            <TrackCard key={`m-${track.id}`} track={track} queue={more} />
          ))}
        </Shelf>
      )}

      {!loading && artists.length > 0 && (
        <Shelf title="Твои артисты">
          {artists.map((artist) => (
            <div key={artist.id} className="shelf-static-card">
              <Card
                title={artist.username}
                subtitle={`${artist.track_count ?? 0} треков`}
                artwork={artist.avatar_url}
                round
                onClick={() => artist.id && useAppStore.getState().openArtist(artist.id)}
              />
            </div>
          ))}
        </Shelf>
      )}

      {!loading && playlists.length > 0 && (
        <Shelf title="Твои плейлисты">
          {playlists.map((pl) => (
            <div key={pl.id} className="shelf-static-card">
              <Card
                title={pl.title}
                subtitle={`${pl.track_count} треков`}
                artwork={pl.artwork_url}
              />
            </div>
          ))}
        </Shelf>
      )}

      {!loading && !error && recommended.length === 0 && history.length === 0 && (
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

      {moodGrid}
    </div>
  );
}

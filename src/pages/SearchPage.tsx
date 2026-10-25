import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, X, MusicNotes, User } from "../lib/icons";
import { useAppStore } from "../stores/appStore";
import { scApi } from "../lib/soundcloud-api";
import { SCTrack, SCUser, SCPlaylist } from "../types/soundcloud";
import TrackRow from "../components/Track/TrackRow";
import Card from "../components/Track/Card";
import "./Pages.css";
import { errorText } from "../lib/errorText";
import { useNetworkStore } from "../stores/networkStore";

type Tab = "tracks" | "artists" | "playlists";

export default function SearchPage() {
  // Запрос может прийти с другой страницы — например, с карточек жанров.
  const { isLoggedIn, searchQuery } = useAppStore();
  const [query, setQuery] = useState(searchQuery);
  const [tab, setTab] = useState<Tab>("tracks");
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [artists, setArtists] = useState<SCUser[]>([]);
  const [playlists, setPlaylists] = useState<SCPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  // Ctrl+F — фокус в поиск
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setTracks([]);
      setArtists([]);
      setPlaylists([]);
      setError(null);
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      runSearch(query.trim());
    }, 350);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, tab]);

  // Автоматический повтор поиска при восстановлении сети
  useEffect(() => {
    return useNetworkStore.getState().onReconnect(() => {
      if (query.trim().length >= 2) {
        void runSearch(query.trim());
      }
    });
  }, [query, tab]);

  const runSearch = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "tracks") {
        const res = await scApi.searchTracks(q, 40);
        // В результатах SoundCloud иногда попадаются объекты без user
        // (и без id) — такие строки рендерить нельзя
        setTracks(
          ((res as any).collection ?? []).filter(
            (t: any) => t && typeof t.id === "number" && t.title
          )
        );
      } else if (tab === "artists") {
        const res = await scApi.searchUsers(q, 24);
        setArtists((res as any).collection ?? []);
      } else {
        const res = await scApi.searchPlaylists(q, 24);
        setPlaylists(
          ((res as any).collection ?? []).map((i: any) => i.playlist ?? i).filter(Boolean)
        );
      }
    } catch (e) {
      setError(errorText(e, "Ошибка поиска"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Поиск</div>
        <div className="page-subtitle">
          Треки, артисты и плейлисты SoundCloud
        </div>
      </div>

      <div className="search-input-wrap">
        <MagnifyingGlass size={18} style={{ color: "var(--text-secondary)" }} />
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Что хочешь послушать?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            style={{ display: "flex", color: "var(--text-secondary)" }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="search-tabs">
        {(
          [
            { id: "tracks", label: "Треки" },
            { id: "artists", label: "Артисты" },
            { id: "playlists", label: "Плейлисты" },
          ] as { id: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            className={`search-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-row" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="empty-state">
          <div className="empty-icon">
            <MagnifyingGlass size={30} />
          </div>
          <div className="empty-title">{error}</div>
          {!isLoggedIn && (
            <div className="empty-text">
              Войди в аккаунт в настройках, чтобы искать музыку.
            </div>
          )}
        </div>
      )}

      {!loading && !error && query.trim().length < 2 && (
        <div className="empty-state">
          <div className="empty-icon">
            <MagnifyingGlass size={30} />
          </div>
          <div className="empty-title">Начни вводить запрос</div>
          <div className="empty-text">
            Ищи треки, артистов и плейлисты. Минимум 2 символа.
          </div>
        </div>
      )}

      {!loading && !error && query.trim().length >= 2 && tab === "tracks" && (
        <>
          {tracks.length === 0 ? (
            <NoResults query={query} />
          ) : (
            <>
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
                <TrackRow key={track.id} track={track} index={i} queue={tracks} />
              ))}
            </>
          )}
        </>
      )}

      {!loading && !error && tab === "artists" && (
        <>
          {artists.length === 0 ? (
            <NoResults query={query} />
          ) : (
            <div className="card-grid">
              {artists.map((a) => (
                <Card
                  key={a.id}
                  title={a.username}
                  subtitle={`${a.track_count ?? 0} треков · ${a.followers_count ?? 0} подписчиков`}
                  artwork={a.avatar_url}
                  round
                />
              ))}
            </div>
          )}
        </>
      )}

      {!loading && !error && tab === "playlists" && (
        <>
          {playlists.length === 0 ? (
            <NoResults query={query} />
          ) : (
            <div className="card-grid">
              {playlists.map((p) => (
                <Card
                  key={p.id}
                  title={p.title}
                  subtitle={p.user?.username}
                  artwork={p.artwork_url}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <MusicNotes size={30} />
      </div>
      <div className="empty-title">Ничего не нашлось</div>
      <div className="empty-text">По запросу «{query}» пусто. Попробуй другое название.</div>
    </div>
  );
}

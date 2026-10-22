import { useEffect, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  Gear,
  Queue,
  X,
  SignIn,
  Trash,
} from "@phosphor-icons/react";
import Sidebar from "./components/Sidebar/Sidebar";
import TitleBar from "./components/TitleBar/TitleBar";
import ToastHost from "./components/Toast/Toast";
import OfflineBanner from "./components/OfflineBanner/OfflineBanner";
import TrackPage from "./pages/TrackPage";
import ArtistPage from "./pages/ArtistPage";
import { logAction } from "./lib/actionLog";
import Player from "./components/Player/Player";
import LyricsPanel from "./components/Lyrics/LyricsPanel";
import KaraokeFullscreen from "./components/Lyrics/KaraokeFullscreen";
import SettingsModal from "./components/Settings/SettingsModal";
import HomePage from "./pages/HomePage";
import WavePage from "./pages/WavePage";
import SearchPage from "./pages/SearchPage";
import LibraryPage from "./pages/LibraryPage";
import AuthPage from "./pages/AuthPage";
import ManualAuthPage from "./pages/ManualAuthPage";
import { useAppStore } from "./stores/appStore";
import { usePlayerStore } from "./stores/playerStore";
import { setAuthCookies } from "./lib/soundcloud-api";
import { startAgentBridge } from "./lib/agentBridge";
import { syncCustomFonts } from "./lib/fonts";
import { pushDiscordPresence } from "./lib/discordPresence";
import { runtimeName } from "./lib/runtime";
import { setActionLogEnabled } from "./lib/actionLog";
import { useSettingsStore } from "./stores/settingsStore";
import { initNetworkMonitoring, useNetworkStore } from "./stores/networkStore";
import "./components/Layout/Layout.css";

export default function App() {
  const {
    view,
    setView,
    currentTrackId,
    currentArtistId,
    openTrack,
    openArtist,
    goBack,
    history,
    isLoggedIn,
    setLoggedIn,
    currentUser,
    queueVisible,
    toggleQueue,
    lyricsVisible,
    karaokeFullscreen,
    settingsOpen,
  } = useAppStore();
  const { queue, queueIndex, play, currentTrack, isPlaying, togglePlay, next, prev, removeFromQueue } =
    usePlayerStore();
  const [isAuthRoute, setIsAuthRoute] = useState<"none" | "real" | "manual">("none");
  const [loginMenuOpen, setLoginMenuOpen] = useState(false);

  // Определяем, какое окно открыто (главное или окно входа)
  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/auth/manual")) setIsAuthRoute("manual");
      else if (hash.startsWith("#/auth")) setIsAuthRoute("real");
      else setIsAuthRoute("none");
    };

    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  // Локальный API для агентов — только в главном окне, не в окне входа.
  useEffect(() => {
    if (!window.electronAPI || window.location.hash.startsWith("#/auth")) return;
    return startAgentBridge();
  }, []);

  // Защита от потери интернета: мониторинг статуса сети и автовозобновление
  useEffect(() => {
    const cleanup = initNetworkMonitoring();
    const unsub = useNetworkStore.subscribe((state, prev) => {
      if (state.isOnline !== prev.isOnline) {
        if (!state.isOnline) {
          usePlayerStore.getState().handleNetworkOffline();
        } else {
          usePlayerStore.getState().handleNetworkOnline();
        }
      }
    });

    return () => {
      cleanup();
      unsub();
    };
  }, []);

  // Настройки внешнего вида: анимации, плотность и стиль оформления.
  useEffect(() => {
    const apply = () => {
      const settings = useSettingsStore.getState();
      document.documentElement.classList.toggle("no-animations", !settings.animations);
      document.documentElement.classList.toggle(
        "density-compact",
        settings.density === "compact"
      );
      document.documentElement.dataset.style = settings.style;
    };

    apply();
    return useSettingsStore.subscribe(apply);
  }, []);

  // Журнал действий: включается по настройке, пишет в logs/actions.log
  useEffect(() => {
    const apply = () => setActionLogEnabled(useSettingsStore.getState().actionLog);
    apply();
    return useSettingsStore.subscribe(apply);
  }, []);

  // Громкость живёт в настройках — так она переживает перезапуск.
  useEffect(() => {
    const unsub = usePlayerStore.subscribe((state, prev) => {
      if (state.volume !== prev.volume) {
        useSettingsStore.getState().set("volume", state.volume);
      }
    });
    return unsub;
  }, []);

  // Стартовое состояние плеера и сайдбара из настроек.
  useEffect(() => {
    const settings = useSettingsStore.getState();

    useAppStore.getState().setSidebarCollapsed(settings.sidebarCollapsed);

    const player = usePlayerStore.getState();
    player.setVolume(settings.volume);
    player.setRepeat(settings.repeatOnStart);
    if (settings.shuffleOnStart && !player.isShuffled) player.toggleShuffle();
  }, []);

  // Свои шрифты: регистрируем в document.fonts при старте.
  useEffect(() => {
    void syncCustomFonts().then((fonts) =>
      useSettingsStore.getState().setCustomFonts(fonts)
    );
  }, []);

  // Discord Rich Presence: держим активность в текущем состоянии.
  useEffect(() => {
    pushDiscordPresence();

    return usePlayerStore.subscribe((state, prev) => {
      const trackChanged = state.currentTrack?.id !== prev.currentTrack?.id;
      if (trackChanged || state.isPlaying !== prev.isPlaying) {
        pushDiscordPresence();
      }
    });
  }, []);

  // Загрузка конфига при старте
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.getConfig().then((cfg) => {
      // Восстанавливаем тему (включая сохранённую кастомную)
      const savedTheme = typeof cfg.theme === "string" && cfg.theme ? cfg.theme : "dark";
      useAppStore.getState().setTheme(savedTheme);

      // Версия и оболочка — для надписи по центру тайтбара.
      useAppStore
        .getState()
        .setAppInfo(typeof cfg.version === "string" ? cfg.version : "", runtimeName());
    });

    // Настройка «закрывать в трей» живёт в настройках интерфейса, а бэкенду
    // нужна сразу при старте — сообщаем ему текущее значение.
    void window.electronAPI.setCloseToTray?.(
      useSettingsStore.getState().closeToTray
    );

    // Восстанавливаем сохранённую сессию
    window.electronAPI.restoreSession?.().then((res) => {
      if (res?.loggedIn && res.cookies) {
        setAuthCookies(res.cookies);
        setLoggedIn(true);
        import("./lib/soundcloud-api")
          .then(({ scApi }) => scApi.getMe())
          .then((me) => setLoggedIn(true, me))
          .catch(() => {
            // Сессия протухла — показываем кнопку входа, а не пустое меню.
            setLoggedIn(false);
          });
      }
    });

    // Подписки на события
    window.electronAPI.onAuthSuccess(async (cookies) => {
      setAuthCookies(cookies);
      // Загружаем профиль
      try {
        const { scApi } = await import("./lib/soundcloud-api");
        const me = await scApi.getMe();
        setLoggedIn(true, me);
      } catch {
        setLoggedIn(true);
      }
    });

    window.electronAPI.onLoggedOut(() => {
      setLoggedIn(false);
    });

    window.electronAPI.onTrayPlayPause(() => togglePlay());
    window.electronAPI.onTrayNext(() => next());
    window.electronAPI.onTrayPrev(() => prev());
    window.electronAPI.onMediaPlayPause(() => togglePlay());
    window.electronAPI.onMediaNext(() => next());
    window.electronAPI.onMediaPrev(() => prev());

    return () => {
      // Отписываемся от всех каналов, на которые подписались выше.
      // В режиме разработки React вызывает эффект дважды — без этого
      // команда play/pause срабатывала бы дважды, то есть никак.
      [
        "auth-success",
        "logged-out",
        "tray-play-pause",
        "tray-next",
        "tray-prev",
        "media-play-pause",
        "media-next",
        "media-prev",
      ].forEach((channel) => {
        window.electronAPI?.removeAllListeners(channel);
      });
    };
  }, []);

  // Если это окно авторизации — рендерим только его
  if (isAuthRoute === "manual") {
    return <ManualAuthPage />;
  }
  if (isAuthRoute === "real") {
    return <AuthPage />;
  }

  const renderView = () => {
    switch (view) {
      case "home":
        return <HomePage />;
      case "wave":
        return <WavePage />;
      case "search":
        return <SearchPage />;
      case "likes":
        return <LibraryPage mode="likes" />;
      case "uploads":
        return <LibraryPage mode="uploads" />;
      case "library":
        return <LibraryPage mode="likes" />;
      case "track":
        return currentTrackId ? (
          <TrackPage trackId={currentTrackId} />
        ) : (
          <HomePage />
        );
      case "artist":
        return currentArtistId ? (
          <ArtistPage artistId={currentArtistId} />
        ) : (
          <HomePage />
        );
      default:
        return <HomePage />;
    }
  };

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar />

        <div className="app-main">
          <div className="top-bar">
            <div className="nav-arrows">
              <button
                className="nav-arrow"
                disabled={!history.length}
                onClick={goBack}
                title="Назад"
              >
                <CaretLeft size={18} weight="bold" />
              </button>
              <button className="nav-arrow" disabled title="Вперёд">
                <CaretRight size={18} weight="bold" />
              </button>
            </div>

            <div className="top-bar-spacer" />

            <div className="top-bar-actions">
              <button className="icon-btn" onClick={toggleQueue} title="Очередь">
                <Queue size={19} />
              </button>

              {isLoggedIn ? (
                <button
                  className="user-chip"
                  title="Открыть профиль внутри приложения"
                  onClick={() => {
                    if (currentUser?.id) openArtist(currentUser.id);
                  }}
                >
                  <div className="user-avatar">
                    {currentUser?.avatar_url ? (
                      <img src={currentUser.avatar_url} alt="" />
                    ) : (
                      (currentUser?.username?.[0] ?? "S").toUpperCase()
                    )}
                  </div>
                  <span className="user-name">{currentUser?.username ?? "Аккаунт"}</span>
                </button>
              ) : (
                <div style={{ position: "relative" }}>
                  <button
                    className="btn-accent"
                    onClick={() => setLoginMenuOpen((v) => !v)}
                  >
                    Войти
                  </button>
                  {loginMenuOpen && (
                    <div className="login-menu">
                      <button
                        className="login-menu-item"
                        onClick={() => {
                          setLoginMenuOpen(false);
                          window.electronAPI?.openRealLogin();
                        }}
                      >
                        Войти через SoundCloud
                      </button>
                      <button
                        className="login-menu-item"
                        onClick={() => {
                          setLoginMenuOpen(false);
                          window.electronAPI?.openManualLogin();
                        }}
                      >
                        Войти вручную (cookies из браузера)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <OfflineBanner />

          <div className="content-scroll">{renderView()}</div>
        </div>

        {queueVisible && (
          <div className="queue-panel">
            <div className="queue-header">
              <span>Очередь</span>
              <button className="icon-btn" onClick={toggleQueue}>
                <X size={16} />
              </button>
            </div>
            <div className="queue-list">
              {queue.length === 0 && (
                <div style={{ padding: 16, fontSize: 13, color: "var(--text-secondary)" }}>
                  Очередь пуста
                </div>
              )}
              {queue.map((t, i) => (
                <div
                  key={`${t.id}-${i}`}
                  className={`track-row ${currentTrack?.id === t.id ? "playing" : ""}`}
                  style={{ gridTemplateColumns: "1fr 28px", height: 46 }}
                >
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span className="track-title" style={{ fontSize: 13 }}>
                      {t.title}
                    </span>
                    <span className="track-artist" style={{ fontSize: 11 }}>
                      {t.user?.username ?? "Неизвестный автор"}
                    </span>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => removeFromQueue(i)}
                    title="Убрать"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {lyricsVisible && <LyricsPanel />}
      </div>

      <Player />

      <ToastHost />

      {karaokeFullscreen && <KaraokeFullscreen />}
      {settingsOpen && <SettingsModal />}
    </div>
  );
}

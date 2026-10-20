import { useState } from "react";
import {
  House,
  MagnifyingGlass,
  MusicNotes,
  Heart,
  CloudArrowUp,
  CaretLeft,
  CaretRight,
  SidebarSimple,
  Queue,
  Gear,
  SignOut,
  Waveform,
} from "@phosphor-icons/react";
import { useAppStore, Theme } from "../../stores/appStore";
import "./Sidebar.css";

const THEMES: { id: Theme; label: string }[] = [
  { id: "dark", label: "Тёмная (SoundCloud Orange)" },
  { id: "light", label: "Светлая" },
  { id: "purple", label: "Фиолетовая" },
  { id: "green", label: "Зелёная" },
];

export default function Sidebar() {
  const {
    view,
    setView,
    sidebarCollapsed,
    toggleSidebar,
    playlists,
    theme,
    setTheme,
    isLoggedIn,
    currentUser,
  } = useAppStore();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const navItems = [
    { id: "home" as const, label: "Главная", icon: House },
    { id: "wave" as const, label: "Моя волна", icon: Waveform },
    { id: "search" as const, label: "Поиск", icon: MagnifyingGlass },
    { id: "library" as const, label: "Библиотека", icon: MusicNotes },
    { id: "likes" as const, label: "Мне нравится", icon: Heart },
    { id: "uploads" as const, label: "Мои загрузки", icon: CloudArrowUp },
  ];

  return (
    <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="logo" onClick={() => setView("home")} style={{ cursor: "pointer" }}>
        <div className="logo-mark">S</div>
        <span>SoundWave</span>
      </div>

      <nav className="nav-list">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "active" : ""}`}
            onClick={() => setView(id)}
            title={label}
          >
            <span className="nav-icon">
              <Icon size={20} weight={view === id ? "fill" : "regular"} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-section-title">Плейлисты</div>
      <div className="playlist-list">
        {playlists.length === 0 && (
          <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-disabled)" }}>
            Пока пусто
          </div>
        )}
        {playlists.map((pl) => (
          <button
            key={pl.id}
            className="playlist-item"
            onClick={() => setView("playlist")}
            title={pl.title}
          >
            <div className="playlist-cover">
              {pl.artwork_url ? (
                <img src={pl.artwork_url} alt="" />
              ) : (
                <MusicNotes size={16} />
              )}
            </div>
            <span className="playlist-name">{pl.title}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-divider" />

      <div className="nav-list">
        <button
          className="nav-item"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "Развернуть" : "Свернуть"}
        >
          <span className="nav-icon">
            <SidebarSimple size={20} />
          </span>
          <span>Свернуть</span>
        </button>

        <div style={{ position: "relative" }}>
          <button className="nav-item" onClick={() => setThemeMenuOpen((v) => !v)} title="Тема">
            <span className="nav-icon">
              <Gear size={20} />
            </span>
            <span>Настройки</span>
          </button>
          {themeMenuOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 8,
                right: 8,
                background: "var(--bg-elevated)",
                borderRadius: "var(--radius-md)",
                padding: 6,
                boxShadow: "var(--shadow-lg)",
                zIndex: 10,
                marginBottom: 6,
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-disabled)", padding: "6px 8px", textTransform: "uppercase", fontWeight: 700 }}>
                Тема
              </div>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className="nav-item"
                  style={{ padding: "8px 10px", fontSize: 12 }}
                  onClick={() => {
                    setTheme(t.id);
                    setThemeMenuOpen(false);
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background:
                        t.id === "dark" ? "#ff5500" :
                        t.id === "light" ? "#f5f5f5" :
                        t.id === "purple" ? "#a855f7" : "#1db954",
                      border: theme === t.id ? "2px solid var(--text-primary)" : "1px solid var(--border)",
                    }}
                  />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoggedIn && (
          <button
            className="nav-item"
            onClick={() => {
              window.electronAPI?.logout();
            }}
            title="Выйти"
          >
            <span className="nav-icon">
              <SignOut size={20} />
            </span>
            <span>Выйти {currentUser ? `(${currentUser.username})` : ""}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

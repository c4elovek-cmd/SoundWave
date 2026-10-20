import { useState } from "react";
import {
  House,
  MagnifyingGlass,
  MusicNotes,
  Heart,
  CloudArrowUp,
  CaretRight,
  SidebarSimple,
  Queue,
  Gear,
  SignOut,
  Waveform,
  Plus,
  PencilSimple,
  Sliders,
} from "@phosphor-icons/react";
import { useAppStore } from "../../stores/appStore";
import { BUILTIN_THEMES, CustomTheme, themeDataId } from "../../lib/themes";
import ThemeEditor from "../ThemeEditor/ThemeEditor";
import "./Sidebar.css";

export default function Sidebar() {
  const {
    view,
    setView,
    sidebarCollapsed,
    toggleSidebar,
    playlists,
    theme,
    setTheme,
    customThemes,
    saveCustomTheme,
    deleteCustomTheme,
    isLoggedIn,
    currentUser,
    openSettings,
  } = useAppStore();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [editor, setEditor] = useState<"new" | CustomTheme | null>(null);

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
      <div className="sidebar-header">
        <div className="logo" onClick={() => setView("home")} title="На главную">
          <div className="logo-mark">S</div>
          <span className="logo-text">SoundWave</span>
        </div>
        <button
          className="sidebar-toggle"
          onClick={() => {
            if (!sidebarCollapsed) setThemeMenuOpen(false);
            toggleSidebar();
          }}
          title={sidebarCollapsed ? "Развернуть панель" : "Свернуть панель"}
          aria-label={sidebarCollapsed ? "Развернуть панель" : "Свернуть панель"}
        >
          {sidebarCollapsed ? (
            <CaretRight size={18} weight="bold" />
          ) : (
            <SidebarSimple size={18} />
          )}
        </button>
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
            <span className="nav-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-section-title">Плейлисты</div>
      <div className="playlist-list">
        {playlists.length === 0 && (
          <div
            className="sidebar-empty"
            style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-disabled)" }}
          >
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
        <div style={{ position: "relative" }}>
          <button
            className="nav-item"
            onClick={() => {
              // В свёрнутой панели меню тем не помещается — сначала разворачиваем.
              if (sidebarCollapsed) {
                toggleSidebar();
                setThemeMenuOpen(true);
                return;
              }
              setThemeMenuOpen((v) => !v);
            }}
            title="Тема"
          >
            <span className="nav-icon">
              <Gear size={20} />
            </span>
            <span className="nav-label">Настройки</span>
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
              <div className="theme-menu-label">Тема</div>
              {BUILTIN_THEMES.map((t) => (
                <button
                  key={t.id}
                  className="nav-item theme-menu-item"
                  onClick={() => {
                    setTheme(t.id);
                    setThemeMenuOpen(false);
                  }}
                >
                  <span
                    className="theme-dot"
                    style={{
                      background: t.accent,
                      border:
                        theme === t.id
                          ? "2px solid var(--text-primary)"
                          : "1px solid var(--border)",
                    }}
                  />
                  <span>{t.label}</span>
                </button>
              ))}

              {customThemes.length > 0 && (
                <div className="theme-menu-label">Свои темы</div>
              )}

              {customThemes.map((t) => {
                const id = themeDataId(t);
                return (
                  <div key={t.id} className="theme-custom-row">
                    <button
                      className="nav-item theme-menu-item"
                      onClick={() => {
                        setTheme(id);
                        setThemeMenuOpen(false);
                      }}
                      title={t.name}
                    >
                      <span
                        className="theme-dot"
                        style={{
                          background: t.accent,
                          border:
                            theme === id
                              ? "2px solid var(--text-primary)"
                              : "1px solid var(--border)",
                        }}
                      />
                      <span className="theme-custom-name">{t.name}</span>
                    </button>
                    <button
                      className="theme-edit-btn"
                      onClick={() => {
                        setEditor(t);
                        setThemeMenuOpen(false);
                      }}
                      title="Изменить тему"
                    >
                      <PencilSimple size={13} />
                    </button>
                  </div>
                );
              })}

              <button
                className="nav-item theme-menu-item"
                onClick={() => {
                  setEditor("new");
                  setThemeMenuOpen(false);
                }}
              >
                <span className="nav-icon">
                  <Plus size={16} />
                </span>
                <span className="nav-label">Своя тема</span>
              </button>

              <div className="sidebar-divider" style={{ margin: "6px 4px" }} />

              <button
                className="nav-item theme-menu-item"
                onClick={() => {
                  setThemeMenuOpen(false);
                  openSettings();
                }}
                title="Все настройки: шрифты, плеер, Discord, API"
              >
                <span className="nav-icon">
                  <Sliders size={16} />
                </span>
                <span className="nav-label">Все настройки…</span>
              </button>
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
            <span className="nav-label">Выйти {currentUser ? `(${currentUser.username})` : ""}</span>
          </button>
        )}
      </div>

      {editor && (
        <ThemeEditor
          initial={editor === "new" ? undefined : editor}
          onSave={(nextTheme) => {
            saveCustomTheme(nextTheme);
            setEditor(null);
          }}
          onDelete={(id) => {
            deleteCustomTheme(id);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </aside>
  );
}

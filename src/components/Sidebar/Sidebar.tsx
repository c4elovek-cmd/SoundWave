import { useRef, useState } from "react";
import {
  House,
  MagnifyingGlass,
  MusicNotes,
  Heart,
  CloudArrowUp,
  CaretRight,
  SidebarSimple,
  Gear,
  SignOut,
  Waveform,
} from "../../lib/icons";
import { useAppStore } from "../../stores/appStore";
import { CustomTheme } from "../../lib/themes";
import ThemeEditor from "../ThemeEditor/ThemeEditor";
import ThemeMenu from "./ThemeMenu";
import "./Sidebar.css";

export default function Sidebar() {
  const {
    view,
    setView,
    sidebarCollapsed,
    toggleSidebar,
    playlists,
    saveCustomTheme,
    deleteCustomTheme,
    isLoggedIn,
    currentUser,
  } = useAppStore();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [editor, setEditor] = useState<"new" | CustomTheme | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

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
        <button
          ref={settingsBtnRef}
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
          aria-haspopup="menu"
          aria-expanded={themeMenuOpen}
        >
          <span className="nav-icon">
            <Gear size={20} />
          </span>
          <span className="nav-label">Настройки</span>
        </button>

        {themeMenuOpen && settingsBtnRef.current && (
          <ThemeMenu
            anchor={settingsBtnRef.current}
            onClose={() => setThemeMenuOpen(false)}
            onEditTheme={(next) => setEditor(next)}
          />
        )}

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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PencilSimple, Plus, Sliders } from "../../lib/icons";
import { BUILTIN_THEMES, CustomTheme, themeDataId } from "../../lib/themes";
import { useAppStore } from "../../stores/appStore";
import "./ThemeMenu.css";

interface Props {
  /** Кнопка, от которой открылось меню: к ней привязываем позицию. */
  anchor: HTMLElement;
  onClose: () => void;
  onEditTheme: (theme: CustomTheme | "new") => void;
}

/**
 * Меню выбора темы.
 *
 * Раньше оно рисовалось инлайново внутри сайдбара: z-index 10 не спасал,
 * и содержимое списка плейлистов просвечивало сквозь панель. Теперь это
 * портал на body — своя подложка, свой слой, ничего не перекрывается.
 */
export default function ThemeMenu({ anchor, onClose, onEditTheme }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const { theme, setTheme, customThemes, openSettings } = useAppStore();

  // Позиция: над кнопкой, по её левому краю; не вылезаем за окно.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = anchor.getBoundingClientRect();
    const menu = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.width - 8));
    const bottom = Math.max(8, window.innerHeight - rect.top + 6);
    setPos({ left, bottom });
  }, [anchor]);

  // Закрытие: клик мимо, Esc, потеря фокуса окна.
  // Клик по самой кнопке-якорю не считаем «мимо»: иначе mousedown
  // закрывал бы меню, а следующий click тут же открывал его снова.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  const pick = (id: string) => {
    setTheme(id);
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="theme-menu"
      role="menu"
      aria-label="Тема оформления"
      style={
        pos
          ? { left: pos.left, bottom: pos.bottom }
          : { left: 0, bottom: 0, visibility: "hidden" }
      }
    >
      <div className="theme-menu-label">Тема</div>
      {BUILTIN_THEMES.map((t) => (
        <button
          key={t.id}
          className={`theme-menu-item ${theme === t.id ? "active" : ""}`}
          onClick={() => pick(t.id)}
          role="menuitemradio"
          aria-checked={theme === t.id}
        >
          <span
            className="theme-dot"
            style={{ background: t.accent }}
            aria-hidden="true"
          />
          <span className="theme-menu-text">{t.label}</span>
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
              className={`theme-menu-item ${theme === id ? "active" : ""}`}
              onClick={() => pick(id)}
              title={t.name}
              role="menuitemradio"
              aria-checked={theme === id}
            >
              <span
                className="theme-dot"
                style={{ background: t.accent }}
                aria-hidden="true"
              />
              <span className="theme-menu-text theme-custom-name">{t.name}</span>
            </button>
            <button
              className="theme-edit-btn"
              onClick={() => {
                onClose();
                onEditTheme(t);
              }}
              title="Изменить тему"
              aria-label={`Изменить тему ${t.name}`}
            >
              <PencilSimple size={13} />
            </button>
          </div>
        );
      })}

      <button
        className="theme-menu-item"
        onClick={() => {
          onClose();
          onEditTheme("new");
        }}
      >
        <span className="theme-menu-icon">
          <Plus size={16} />
        </span>
        <span className="theme-menu-text">Своя тема</span>
      </button>

      <div className="theme-menu-sep" />

      <button
        className="theme-menu-item"
        onClick={() => {
          onClose();
          openSettings();
        }}
        title="Все настройки: шрифты, плеер, Discord, API"
      >
        <span className="theme-menu-icon">
          <Sliders size={16} />
        </span>
        <span className="theme-menu-text">Все настройки…</span>
      </button>
    </div>,
    document.body
  );
}

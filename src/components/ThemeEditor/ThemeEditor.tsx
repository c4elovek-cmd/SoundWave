import { useEffect, useState } from "react";
import { FloppyDisk, Trash, X } from "@phosphor-icons/react";
import {
  ACCENT_PRESETS,
  CustomTheme,
  ThemeBase,
  newThemeId,
  normalizeHex,
  readableTextColor,
} from "../../lib/themes";
import "./ThemeEditor.css";

interface ThemeEditorProps {
  initial?: CustomTheme;
  onSave: (theme: CustomTheme) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

export default function ThemeEditor({ initial, onSave, onDelete, onClose }: ThemeEditorProps) {
  const [name, setName] = useState(initial?.name ?? "Моя тема");
  const [base, setBase] = useState<ThemeBase>(initial?.base ?? "dark");
  const [accent, setAccent] = useState(normalizeHex(initial?.accent ?? "#ff5500") ?? "#ff5500");
  const [hexInput, setHexInput] = useState(accent);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chooseAccent = (value: string) => {
    const normalized = normalizeHex(value);
    if (!normalized) return;
    setAccent(normalized);
    setHexInput(normalized);
  };

  const handleSave = () => {
    onSave({
      id: initial?.id ?? newThemeId(),
      name: name.trim() || "Моя тема",
      base,
      accent,
    });
  };

  return (
    <div
      className="theme-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="theme-modal" role="dialog" aria-modal="true" aria-label="Своя тема">
        <div className="theme-modal-header">
          <span>{initial ? "Изменить тему" : "Своя тема"}</span>
          <button className="icon-btn" onClick={onClose} title="Закрыть">
            <X size={16} />
          </button>
        </div>

        <div className="theme-preview" data-base={base}>
          <div className="theme-preview-card">
            <span
              className="theme-preview-logo"
              style={{ background: accent, color: readableTextColor(accent) }}
            >
              S
            </span>
            <div className="theme-preview-lines">
              <span className="theme-preview-title">SoundWave</span>
              <span className="theme-preview-sub">Предпросмотр темы</span>
            </div>
            <span
              className="theme-preview-button"
              style={{ background: accent, color: readableTextColor(accent) }}
            >
              Слушать
            </span>
          </div>
        </div>

        <label className="theme-field">
          <span className="theme-field-label">Название</span>
          <input
            className="theme-name-input"
            value={name}
            maxLength={32}
            onChange={(event) => setName(event.target.value)}
            placeholder="Моя тема"
          />
        </label>

        <div className="theme-field">
          <span className="theme-field-label">Основа</span>
          <div className="theme-base-toggle">
            <button
              className={base === "dark" ? "active" : ""}
              onClick={() => setBase("dark")}
            >
              Тёмная
            </button>
            <button
              className={base === "light" ? "active" : ""}
              onClick={() => setBase("light")}
            >
              Светлая
            </button>
          </div>
        </div>

        <div className="theme-field">
          <span className="theme-field-label">Акцент</span>
          <div className="theme-accent-row">
            <input
              type="color"
              className="theme-color-input"
              value={accent}
              onChange={(event) => chooseAccent(event.target.value)}
              title="Выбрать цвет"
            />
            <input
              className="theme-hex-input"
              value={hexInput}
              maxLength={7}
              spellCheck={false}
              onChange={(event) => {
                setHexInput(event.target.value);
                const normalized = normalizeHex(event.target.value);
                if (normalized) setAccent(normalized);
              }}
              onBlur={() => setHexInput(accent)}
            />
          </div>

          <div className="theme-swatches">
            {ACCENT_PRESETS.map((color) => (
              <button
                key={color}
                className={`theme-swatch ${accent === color ? "active" : ""}`}
                style={{ background: color }}
                onClick={() => chooseAccent(color)}
                title={color}
              />
            ))}
          </div>
        </div>

        <div className="theme-modal-actions">
          {initial && onDelete && (
            <button className="theme-delete" onClick={() => onDelete(initial.id)}>
              <Trash size={14} />
              Удалить
            </button>
          )}
          <button className="theme-cancel" onClick={onClose}>
            Отмена
          </button>
          <button className="theme-save" onClick={handleSave}>
            <FloppyDisk size={15} />
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

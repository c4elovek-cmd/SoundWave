import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "../../lib/icons";
import { logAction } from "../../lib/actionLog";
import { useAppStore } from "../../stores/appStore";
import "./TitleBar.css";

/**
 * Своя рамка окна: системный заголовок и кнопки убраны (frame: false),
 * поэтому свернуть / развернуть / закрыть рисуем здесь.
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const appVersion = useAppStore((state) => state.appVersion);
  const runtime = useAppStore((state) => state.runtime);

  useEffect(() => {
    let active = true;
    void window.electronAPI?.windowIsMaximized?.().then((value) => {
      if (active) setMaximized(value);
    });

    if (!window.electronAPI?.onWindowMaximizedChanged) {
      return () => {
        active = false;
      };
    }

    const unsubscribe = window.electronAPI.onWindowMaximizedChanged(setMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-mark">S</span>
        <span className="titlebar-name">SoundWave</span>
      </div>

      {/* Версия и оболочка — по центру рамки окна */}
      {(appVersion || runtime) && (
        <div className="titlebar-version">
          <span className="titlebar-version-number">{appVersion || "—"}</span>
          {runtime && <span className="titlebar-version-runtime">{runtime}</span>}
        </div>
      )}

      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          onClick={async () => {
            logAction("window.minimize");
            try {
              await window.electronAPI?.windowMinimize?.();
            } catch (error) {
              console.error("Не удалось свернуть окно:", error);
            }
          }}
          title="Свернуть"
          aria-label="Свернуть"
        >
          <Minus size={16} />
        </button>

        <button
          className="titlebar-btn"
          onClick={async () => {
            logAction("window.maximize");
            try {
              const value = await window.electronAPI?.windowToggleMaximize?.();
              if (typeof value === "boolean") setMaximized(value);
            } catch (error) {
              console.error("Не удалось изменить размер окна:", error);
            }
          }}
          title={maximized ? "Восстановить" : "Развернуть"}
          aria-label={maximized ? "Восстановить" : "Развернуть"}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>

        <button
          className="titlebar-btn close"
          onClick={async () => {
            logAction("window.close");
            try {
              await window.electronAPI?.windowClose?.();
            } catch (error) {
              console.error("Не удалось закрыть окно:", error);
            }
          }}
          title="Закрыть"
          aria-label="Закрыть"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

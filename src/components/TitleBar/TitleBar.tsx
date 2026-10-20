import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "@phosphor-icons/react";
import "./TitleBar.css";

/**
 * Своя рамка окна: системный заголовок и кнопки убраны (frame: false),
 * поэтому свернуть / развернуть / закрыть рисуем здесь.
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.electronAPI?.windowIsMaximized?.().then(setMaximized);

    if (!window.electronAPI?.onWindowMaximizedChanged) return;
    return window.electronAPI.onWindowMaximizedChanged(setMaximized);
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-mark">S</span>
        <span className="titlebar-name">SoundWave</span>
      </div>

      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          onClick={() => void window.electronAPI?.windowMinimize?.()}
          title="Свернуть"
          aria-label="Свернуть"
        >
          <Minus size={16} />
        </button>

        <button
          className="titlebar-btn"
          onClick={async () =>
            setMaximized((await window.electronAPI?.windowToggleMaximize?.()) ?? false)
          }
          title={maximized ? "Восстановить" : "Развернуть"}
          aria-label={maximized ? "Восстановить" : "Развернуть"}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>

        <button
          className="titlebar-btn close"
          onClick={() => void window.electronAPI?.windowClose?.()}
          title="Закрыть"
          aria-label="Закрыть"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { Globe, ShieldCheck, MusicNotes, Cookie } from "@phosphor-icons/react";
import "./Pages.css";

/**
 * Экран выбора способа входа (показывается в окне входа).
 *
 * Оба способа работают в этом же окне — приложение открывает не больше
 * двух окон: главное и одно окно входа.
 */
export default function AuthPage() {
  useEffect(() => {
    document.title = "Вход в SoundCloud — SoundWave";
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">S</div>
        <div className="auth-title">Вход в SoundCloud</div>
        <div className="auth-text">
          Выбери способ входа. Пароль вводится на самом SoundCloud — приложение его
          не видит и не хранит.
        </div>

        <button
          className="auth-btn"
          onClick={() => window.electronAPI?.openRealLogin()}
        >
          Войти через SoundCloud
        </button>

        <button
          className="btn-ghost"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => window.electronAPI?.openManualLogin()}
        >
          <Cookie size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          Войти вручную (cookies из браузера)
        </button>

        <div className="auth-note">
          <ShieldCheck size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Пароль передаётся и проверяется только SoundCloud.
        </div>

        <div className="auth-note">
          <Globe size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Требуется подключение к soundcloud.com
        </div>

        <div className="auth-note">
          <MusicNotes size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          SoundWave не является официальным клиентом SoundCloud.
        </div>
      </div>
    </div>
  );
}

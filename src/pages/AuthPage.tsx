import { useEffect, useState } from "react";
import { Globe, ShieldCheck, MusicNotes, Cookie, SignOut } from "@phosphor-icons/react";
import "./Pages.css";

/**
 * Экран выбора способа входа (показывается в окне входа).
 *
 * Оба способа работают в этом же окне — приложение открывает не больше
 * двух окон: главное и одно окно входа.
 */
export default function AuthPage() {
  const [hasSession, setHasSession] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Вход в SoundCloud — SoundWave";
    window.electronAPI?.hasSession?.().then(setHasSession).catch(() => setHasSession(false));
  }, []);

  // Выйти из аккаунта и войти заново — чистим cookies раздела,
  // иначе signin сразу редиректит на /discover и пароль не спросят.
  const relogin = async () => {
    setBusy(true);
    try {
      await window.electronAPI?.logout();
      await window.electronAPI?.openRealLogin();
    } finally {
      setBusy(false);
    }
  };

  if (hasSession) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">S</div>
          <div className="auth-title">Вы уже вошли</div>
          <div className="auth-text">
            Сессия SoundCloud активна — приложение уже работает с твоим аккаунтом.
            Можно закрыть окно или выйти и войти в другой аккаунт.
          </div>

          <button
            className="auth-btn"
            onClick={() => window.electronAPI?.closeLoginWindow()}
          >
            Закрыть окно
          </button>

          <button
            className="btn-ghost"
            style={{ width: "100%", marginTop: 10 }}
            disabled={busy}
            onClick={relogin}
          >
            <SignOut size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy ? "Открываем SoundCloud…" : "Выйти и войти в другой аккаунт"}
          </button>

          <div className="auth-note">
            <ShieldCheck size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Пароль передаётся и проверяется только SoundCloud.
          </div>
        </div>
      </div>
    );
  }

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

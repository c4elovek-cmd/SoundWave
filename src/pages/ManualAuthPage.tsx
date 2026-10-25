import { useState } from "react";
import {
  ShieldCheck,
  ClipboardText,
  CheckCircle,
  WarningCircle,
  Cookie,
  ArrowSquareOut,
} from "../lib/icons";
import "./Pages.css";

/**
 * Ручной импорт cookies из браузера.
 *
 * Принимает три формата:
 *  - строку заголовка Cookie: "oauth_token=abc; tz=Europe/Moscow"
 *  - JSON из Cookie-Editor / EditThisCookie: [{"name":"oauth_token","value":"abc"}]
 *  - Netscape cookies.txt
 */
export default function ManualAuthPage() {
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "ok"; count: number } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [pasteBusy, setPasteBusy] = useState(false);

  const submit = async () => {
    if (!window.electronAPI) {
      setStatus({ kind: "error", message: "Доступно только в десктопном приложении" });
      return;
    }
    setBusy(true);
    try {
      const res = await window.electronAPI.importCookies(raw);
      if (res.ok) {
        setStatus({ kind: "ok", count: res.count ?? 0 });
      } else {
        setStatus({ kind: "error", message: res.error ?? "Не удалось распознать cookies" });
      }
    } finally {
      setBusy(false);
    }
  };

  const pasteFromClipboard = async () => {
    setPasteBusy(true);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRaw(text);
        setStatus({ kind: "idle" });
      }
    } catch {
      setStatus({
        kind: "error",
        message: "Нет доступа к буферу обмена — вставь вручную через Ctrl+V",
      });
    } finally {
      setPasteBusy(false);
    }
  };

  return (
    <div className="auth-page" style={{ alignItems: "flex-start", overflowY: "auto" }}>
      <div className="manual-card">
        <div className="manual-head">
          <Cookie size={22} style={{ color: "var(--accent)" }} />
          <div>
            <div className="manual-title">Ручной вход</div>
            <div className="manual-sub">Вставь cookies своего аккаунта SoundCloud</div>
          </div>
        </div>

        <ol className="manual-steps">
          <li>
            Открой <b>soundcloud.com</b> в своём браузере и войди в аккаунт.
          </li>
          <li>
            Поставь расширение{" "}
            <a
              href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm"
              target="_blank"
              rel="noreferrer"
            >
              Cookie-Editor <ArrowSquareOut size={11} style={{ verticalAlign: -1 }} />
            </a>{" "}
            (или EditThisCookie).
          </li>
          <li>
            На вкладке SoundCloud нажми <b>Export</b> → <b>Export as JSON</b> (или
            скопируй строку <code>oauth_token=…; …</code>).
          </li>
          <li>Вставь сюда и нажми «Войти».</li>
        </ol>

        <div className="manual-field-wrap">
          <textarea
            className="manual-textarea"
            placeholder={`oauth_token=2-123456-abcdef...; tz=Europe/Moscow; ...\n\nили JSON:\n[{"name":"oauth_token","value":"..."}]`}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setStatus({ kind: "idle" });
            }}
            spellCheck={false}
          />
          <button
            className="manual-paste"
            onClick={pasteFromClipboard}
            disabled={pasteBusy}
            title="Вставить из буфера обмена"
          >
            <ClipboardText size={15} />
            {pasteBusy ? "Читаем…" : "Вставить"}
          </button>
        </div>

        {status.kind === "ok" && (
          <div className="manual-status ok">
            <CheckCircle size={16} weight="fill" />
            Вход выполнен, получено {status.count} cookies. Окно закроется.
          </div>
        )}
        {status.kind === "error" && (
          <div className="manual-status error">
            <WarningCircle size={16} weight="fill" />
            {status.message}
          </div>
        )}

        <button
          className="auth-btn"
          onClick={submit}
          disabled={busy || !raw.trim()}
          style={{ opacity: busy || !raw.trim() ? 0.5 : 1 }}
        >
          {busy ? "Проверяем…" : "Войти"}
        </button>

        <div className="manual-alt">
          <button
            className="link-btn"
            onClick={() => window.electronAPI?.openRealLogin()}
          >
            Войти через SoundCloud
          </button>
        </div>

        <div className="auth-note">
          <ShieldCheck size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Не передавай cookies другим: они дают доступ к аккаунту.
        </div>
      </div>
    </div>
  );
}

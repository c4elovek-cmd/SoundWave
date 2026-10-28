import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, DownloadSimple, SpinnerGap, X } from "../../lib/icons";
import { showToast } from "../../stores/toastStore";
import { logAction } from "../../lib/actionLog";
import "./UpdateBanner.css";

/**
 * Плашка обновления.
 *
 * Приложение само проверяет релиз при старте и раз в полчаса. Как только
 * обновление найдено (в Electron — уже скачано), сверху появляется полоса
 * с кнопкой «Обновить и перезапустить».
 */

type Phase = "available" | "ready" | "installing";

interface UpdateState {
  phase: Phase;
  version: string;
}

/** Первая проверка — не сразу, чтобы не мешать запуску и загрузке треков. */
const FIRST_CHECK_DELAY = 12_000;
/** Периодичность фоновых проверок. */
const CHECK_INTERVAL = 30 * 60_000;

export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.checkForUpdates) return;

    let cancelled = false;

    const adopt = (version: string, phase: Phase) => {
      if (cancelled || !version) return;
      // Уже скачанное обновление не понижаем до «доступно».
      setUpdate((prev) => (prev && prev.phase !== "available" ? prev : { phase, version }));
    };

    const check = async () => {
      try {
        const result = await api.checkForUpdates?.();
        if (cancelled || !result?.ok || result.upToDate !== false) return;
        if (result.version) adopt(result.version, "available");
      } catch {
        // Нет сети или лента недоступна — молчим, попробуем позже.
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL);

    const offAvailable = api.onUpdateAvailable?.((info) => adopt(info.version, "available"));

    const offDownloaded = api.onUpdateDownloaded?.((info) => {
      if (cancelled || !info.version) return;
      // Скачалось — показываем снова, даже если «доступно» когда-то скрыли.
      setDismissedVersion(null);
      setUpdate({ phase: "ready", version: info.version });
    });

    // Ошибку скачивания показывает настройки; здесь не мешаем слушать музыку.
    const offError = api.onUpdateError?.(() => {});

    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      offAvailable?.();
      offDownloaded?.();
      offError?.();
    };
  }, []);

  if (!update || dismissedVersion === update.version) return null;

  const install = async () => {
    const api = window.electronAPI;
    if (!api?.installUpdate) return;

    const version = update.version;
    const previousPhase = update.phase;
    logAction("update_install", { version });
    setUpdate((prev) => (prev ? { ...prev, phase: "installing" } : prev));

    const result = await api.installUpdate();
    if (result?.ok) return;

    // Не получилось — возвращаем кнопку и объясняем причину.
    setUpdate((prev) => (prev ? { ...prev, phase: previousPhase } : prev));
    showToast({
      kind: "error",
      title: "Не удалось установить обновление",
      message: result?.error ?? "Попробуйте позже",
    });
  };

  const title =
    update.phase === "installing"
      ? "Обновляем SoundWave…"
      : update.phase === "ready"
        ? `Обновление ${update.version} готово`
        : `Доступно обновление ${update.version}`;

  const subtitle =
    update.phase === "installing"
      ? "Приложение перезапустится автоматически. Музыка на пару секунд прервётся."
      : update.phase === "ready"
        ? "Перезапустите приложение, чтобы применить обновление."
        : "Скачаем новую версию и перезапустим приложение.";

  const Icon =
    update.phase === "installing"
      ? SpinnerGap
      : update.phase === "ready"
        ? CheckCircle
        : DownloadSimple;

  return (
    <div className={`update-banner ${update.phase}`} role="status">
      <div className="update-banner-content">
        <div className="update-icon-box">
          <Icon size={18} weight="bold" className={update.phase === "installing" ? "spin" : ""} />
        </div>

        <div className="update-text-block">
          <span className="update-title">{title}</span>
          <span className="update-subtitle">{subtitle}</span>
        </div>
      </div>

      <div className="update-actions">
        <button
          className="update-btn update-btn-install"
          onClick={() => void install()}
          disabled={update.phase === "installing"}
        >
          {update.phase === "installing" ? (
            <SpinnerGap size={14} weight="bold" className="spin" />
          ) : (
            <ArrowClockwise size={14} weight="bold" />
          )}
          <span>{update.phase === "installing" ? "Обновляем…" : "Обновить и перезапустить"}</span>
        </button>

        {update.phase !== "installing" && (
          <button
            className="update-close-btn"
            onClick={() => {
              logAction("update_dismiss", { version: update.version });
              setDismissedVersion(update.version);
            }}
            title="Скрыть до следующего запуска"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

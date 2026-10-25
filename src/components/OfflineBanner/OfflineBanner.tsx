import { useState } from "react";
import {
  WifiSlash,
  WifiHigh,
  ArrowClockwise,
  Folder,
  X,
} from "../../lib/icons";
import { useNetworkStore } from "../../stores/networkStore";
import { usePlayerStore } from "../../stores/playerStore";
import { logAction } from "../../lib/actionLog";
import "./OfflineBanner.css";

/**
 * Плашка защиты от потери интернета.
 *
 * Отображается в верхней части окна:
 * - При потере сети: предупреждает пользователя, даёт проверить соединение
 *   и открыть папку со скачанными треками.
 * - При восстановлении сети: сообщает, что связь восстановлена, и плавно исчезает.
 */
export default function OfflineBanner() {
  const { isOnline, wasOffline, isChecking, checkConnectivity } =
    useNetworkStore();
  const { waitingForNetwork, currentTrack } = usePlayerStore();
  const [dismissed, setDismissed] = useState(false);

  // Если всё хорошо и отключений не было — не рендерим
  if (isOnline && !wasOffline) {
    return null;
  }

  // Пользователь вручную скрыл плашку для текущего периода офлайна
  if (dismissed && !isOnline) {
    return null;
  }

  const handleOpenDownloads = () => {
    logAction("offline_open_downloads");
    void window.electronAPI?.openPath?.("downloads");
  };

  const handleCheck = () => {
    logAction("offline_check_network");
    void checkConnectivity();
  };

  if (!isOnline) {
    return (
      <div className="offline-banner offline-lost" role="alert">
        <div className="offline-banner-content">
          <div className="offline-icon-box">
            <WifiSlash size={20} weight="bold" />
          </div>

          <div className="offline-text-block">
            <div className="offline-title-row">
              <span className="offline-badge">ОФЛАЙН</span>
              <span className="offline-title">Нет подключения к интернету</span>
            </div>
            <p className="offline-subtitle">
              {waitingForNetwork && currentTrack
                ? `Воспроизведение «${currentTrack.title}» продолжится автоматически при появлении сети.`
                : "Проверьте Wi-Fi или сетевой кабель. Вы можете слушать ранее скачанные треки."}
            </p>
          </div>
        </div>

        <div className="offline-actions">
          <button
            className="offline-btn offline-btn-check"
            onClick={handleCheck}
            disabled={isChecking}
            title="Проверить интернет-соединение"
          >
            <ArrowClockwise
              size={14}
              weight="bold"
              className={isChecking ? "spin" : ""}
            />
            <span>{isChecking ? "Проверяем…" : "Проверить сеть"}</span>
          </button>

          <button
            className="offline-btn offline-btn-downloads"
            onClick={handleOpenDownloads}
            title="Открыть системную папку «Загрузки» с сохранёнными треками"
          >
            <Folder size={14} weight="bold" />
            <span>Скачанные треки</span>
          </button>

          <button
            className="offline-close-btn"
            onClick={() => setDismissed(true)}
            title="Скрыть плашку"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  // Режим восстановления сети (isOnline && wasOffline)
  return (
    <div className="offline-banner offline-restored" role="status">
      <div className="offline-banner-content">
        <div className="offline-icon-box restored">
          <WifiHigh size={20} weight="bold" />
        </div>

        <div className="offline-text-block">
          <div className="offline-title-row">
            <span className="offline-badge restored">СВЯЗЬ ЕСТЬ</span>
            <span className="offline-title">Подключение к сети восстановлено</span>
          </div>
          <p className="offline-subtitle">
            SoundWave снова онлайн. Поиск, волна и воспроизведение работают в штатном режиме.
          </p>
        </div>
      </div>
    </div>
  );
}

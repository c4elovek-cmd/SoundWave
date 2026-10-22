import { create } from "zustand";
import { logAction } from "../lib/actionLog";

type ReconnectCallback = () => void;

interface NetworkState {
  /** Есть ли подключение к интернету прямо сейчас. */
  isOnline: boolean;
  /**
   * Было ли отключение недавно.
   * Нужно для показа зелёной плашки «Подключение восстановлено»,
   * которая исчезает через 3.5 секунды.
   */
  wasOffline: boolean;
  /** Время последнего отключения (мс). */
  disconnectedAt: number | null;
  /** Проверяется ли соединение прямо сейчас (по кнопке «Проверить сеть»). */
  isChecking: boolean;
  /** Принудительная проверка сети с пингом. */
  checkConnectivity: () => Promise<boolean>;
  /** Подписка на восстановление сети (для автообновления страниц). */
  onReconnect: (cb: ReconnectCallback) => () => void;
  /** Установить текущий статус сети. */
  setOnline: (online: boolean) => void;
}

const reconnectListeners = new Set<ReconnectCallback>();
let restoreTimer: number | null = null;
let pollTimer: number | null = null;

export const useNetworkStore = create<NetworkState>((set, get) => ({
  isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  wasOffline: false,
  disconnectedAt: null,
  isChecking: false,

  setOnline: (online: boolean) => {
    const prev = get().isOnline;
    if (prev === online) return;

    if (!online) {
      logAction("network_offline", { time: Date.now() });
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      set({ isOnline: false, disconnectedAt: Date.now(), wasOffline: true });

      // Когда оффлайн, периодически проверяем сеть лёгким запросом,
      // если Windows не прислала событие 'online'
      if (!pollTimer) {
        pollTimer = window.setInterval(() => {
          if (!get().isOnline) {
            void get().checkConnectivity();
          } else if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, 8000);
      }
    } else {
      logAction("network_online", { time: Date.now() });
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      set({ isOnline: true });

      // Уведомляем страницы и плеер о возвращении сети
      reconnectListeners.forEach((cb) => {
        try {
          cb();
        } catch (e) {
          console.error("Ошибка обработчика восстановления сети:", e);
        }
      });

      // Плашка «Подключение восстановлено» висит 3.5 секунды и плавно уходит
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        set({ wasOffline: false, disconnectedAt: null });
        restoreTimer = null;
      }, 3500);
    }
  },

  checkConnectivity: async () => {
    set({ isChecking: true });
    try {
      // Проверяем реальное соединение через HEAD-запрос с коротким таймаутом
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);

      // HEAD-запрос на CDN SoundCloud: ответ no-cors непрозрачный, но
      // успешное завершение означает, что интернет и домен доступны.
      const ok = await fetch("https://a-v2.sndcdn.com/assets/images/sc-icons/favicon-2cadd14bdb.ico", {
        method: "HEAD",
        mode: "no-cors",
        cache: "no-cache",
        signal: controller.signal,
      })
        .then(() => true)
        .catch(() => false);

      clearTimeout(timer);

      // Не снимаем флаг офлайна, если тест выполнялся, когда приложение уже
      // было онлайн: иначе фоновые проверки генерируют ложное восстановление.
      if (!ok) {
        get().setOnline(false);
      } else if (!get().isOnline) {
        get().setOnline(true);
      }

      set({ isChecking: false });
      return ok;
    } catch {
      get().setOnline(false);
      set({ isChecking: false });
      return false;
    }
  },

  onReconnect: (cb: ReconnectCallback) => {
    reconnectListeners.add(cb);
    return () => {
      reconnectListeners.delete(cb);
    };
  },
}));

let initialized = false;

/**
 * Инициализирует глобальный мониторинг состояния сети.
 */
export function initNetworkMonitoring(): () => void {
  if (initialized || typeof window === "undefined") {
    return () => {};
  }
  initialized = true;

  const handleOnline = () => {
    // navigator.onLine сообщает только о сетевом интерфейсе — проверяем,
    // что доступен сам интернет, прежде чем снимать режим офлайна.
    void useNetworkStore.getState().checkConnectivity();
  };

  const handleOffline = () => {
    useNetworkStore.getState().setOnline(false);
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  // Когда окно снова получает фокус — перепроверяем сеть
  const handleFocus = () => {
    if (!navigator.onLine) {
      useNetworkStore.getState().setOnline(false);
    } else if (!useNetworkStore.getState().isOnline) {
      void useNetworkStore.getState().checkConnectivity();
    }
  };

  window.addEventListener("focus", handleFocus);

  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    window.removeEventListener("focus", handleFocus);
    initialized = false;
  };
}

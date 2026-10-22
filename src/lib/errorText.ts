/**
 * Текст ошибки из отказа промиса.
 *
 * Под Electron отказ приходит как `Error`, под Tauri — как строка
 * (так отдаёт `invoke`, если команда вернула `Err(String)`).
 * Распознаёт сетевые сбои и возвращает понятный русский текст вместо
 * сырых системных дампов вроде «os error 10051» или «Failed to fetch».
 */
export function errorText(error: unknown, fallback: string): string {
  let raw = "";

  if (typeof error === "string" && error.trim()) {
    raw = error;
  } else if (error instanceof Error && error.message) {
    raw = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      raw = message;
    }
  }

  if (!raw) return fallback;

  // Ошибки отсутствия сети или обрыва соединения
  const lower = raw.toLowerCase();
  const isNetworkFailure =
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("err_internet_disconnected") ||
    lower.includes("err_name_not_resolved") ||
    lower.includes("err_network_changed") ||
    lower.includes("err_connection_refused") ||
    lower.includes("err_connection_reset") ||
    lower.includes("err_timed_out") ||
    lower.includes("dns error") ||
    lower.includes("запрос не ушёл") ||
    lower.includes("error sending request") ||
    lower.includes("os error 10051") ||
    lower.includes("os error 10054") ||
    lower.includes("os error 10065") ||
    lower.includes("os error 11001") ||
    (typeof navigator !== "undefined" &&
      !navigator.onLine &&
      (lower.includes("network") || lower.includes("fetch") || lower.includes("connect")));

  if (isNetworkFailure) {
    return "Нет подключения к интернету";
  }

  return raw;
}

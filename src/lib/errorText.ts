/**
 * Текст ошибки из отказа промиса.
 *
 * Под Electron отказ приходит как `Error`, под Tauri — как строка
 * (так отдаёт `invoke`, если команда вернула `Err(String)`).
 * Поэтому проверяем оба случая.
 */
export function errorText(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

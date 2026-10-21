// Журнал действий пользователя.
//
// Нужен, чтобы воспроизвести баг: когда включён, каждое значимое действие
// пишется в logs/actions.log рядом с основным логом приложения. Файл можно
// прислать — по нему видно, что нажимали и в каком порядке.

let enabled = false;

export function setActionLogEnabled(value: boolean): void {
  enabled = value;
}

export function isActionLogEnabled(): boolean {
  return enabled;
}

/**
 * Записывает действие. Детали пишем только безопасные: никаких токенов,
 * cookie и паролей.
 */
export function logAction(action: string, details?: Record<string, unknown>): void {
  if (!enabled) return;
  void window.electronAPI?.logAction?.(action, details ?? {});
}

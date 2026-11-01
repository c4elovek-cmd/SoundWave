import { create } from "zustand";

/** Кнопка в плашке — например, «Открыть файл». */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  title: string;
  message?: string;
  /** Действие — кнопка справа в плашке. */
  action?: ToastAction;
  /** Тип плашки: `info`, `success`, `error`. */
  kind?: "info" | "success" | "error";
  /** Через сколько миллисекунд плашка исчезнет. 0 — не исчезает. */
  timeout?: number;
  /**
   * Группа для схлопывания: новая плашка той же группы заменяет старую.
   *
   * Без этого повторяющиеся события (например, «Трек скачан» на каждую
   * песню) заваливают экран одинаковыми плашками.
   */
  group?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
/** Таймеры автоскрытия: при замене плашки старый таймер нужно снять. */
const timers = new Map<number, number>();
/** Сколько плашек показываем одновременно, остальные вытесняем старыми. */
const MAX_TOASTS = 3;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    // Плашка той же группы уже на экране — обновляем её на месте,
    // а не добавляем ещё одну.
    const existing = toast.group
      ? get().toasts.find((t) => t.group === toast.group)
      : undefined;

    if (existing) {
      const timer = timers.get(existing.id);
      if (timer) {
        window.clearTimeout(timer);
        timers.delete(existing.id);
      }

      set((state) => ({
        toasts: state.toasts.map((t) =>
          t.id === existing.id ? { ...toast, id: existing.id } : t
        ),
      }));

      return existing.id;
    }

    const id = nextId++;
    set((state) => {
      const toasts = [...state.toasts, { ...toast, id }];

      // Стопка длиннее лимита — старые плашки убираем совсем.
      const extra = toasts.length - MAX_TOASTS;
      if (extra > 0) {
        for (const t of toasts.slice(0, extra)) {
          const timer = timers.get(t.id);
          if (timer) {
            window.clearTimeout(timer);
            timers.delete(t.id);
          }
        }
        return { toasts: toasts.slice(extra) };
      }

      return { toasts };
    });

    return id;
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.delete(id);
    }

    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Показать плашку.
 *
 * По умолчанию она висит 5 секунд; с `timeout: 0` — пока не закроют.
 */
export function showToast(toast: Omit<Toast, "id">): number {
  const id = useToastStore.getState().push(toast);
  const timeout = toast.timeout ?? 5000;

  if (timeout > 0) {
    timers.set(id, window.setTimeout(() => useToastStore.getState().dismiss(id), timeout));
  }

  return id;
}

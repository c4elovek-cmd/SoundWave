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
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
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
    window.setTimeout(() => useToastStore.getState().dismiss(id), timeout);
  }

  return id;
}

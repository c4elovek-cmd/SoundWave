import { useEffect } from "react";
import { X, CheckCircle, WarningCircle, Info } from "@phosphor-icons/react";
import { useToastStore } from "../../stores/toastStore";
import "./Toast.css";

/** Всплывающие плашки в правом нижнем углу окна. */
export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    // Плашки живут поверх окна, но не мешают кликать по приложению.
    const stop = (e: MouseEvent) => e.stopPropagation();
    document.addEventListener("mousedown", stop, true);
    return () => document.removeEventListener("mousedown", stop, true);
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toast-host">
      {toasts.map((toast) => {
        const Icon =
          toast.kind === "success"
            ? CheckCircle
            : toast.kind === "error"
              ? WarningCircle
              : Info;

        return (
          <div key={toast.id} className={`toast ${toast.kind ?? "info"}`}>
            <Icon size={18} className="toast-icon" weight="fill" />

            <div className="toast-body">
              <span className="toast-title">{toast.title}</span>
              {toast.message && (
                <span className="toast-message" title={toast.message}>
                  {toast.message}
                </span>
              )}
            </div>

            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}

            <button
              className="toast-close"
              onClick={() => dismiss(toast.id)}
              title="Закрыть"
              aria-label="Закрыть"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

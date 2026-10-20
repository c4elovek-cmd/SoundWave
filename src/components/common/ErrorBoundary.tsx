import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Ловит ошибки рендера React.
 *
 * Без него любая ошибка в компоненте (например, трек без поля `user`,
 * который иногда приходит из поиска SoundCloud) приводит к тому, что
 * React размонтирует всё дерево и приложение превращается в чёрное окно.
 * С ErrorBoundary вместо пустого экрана показывается текст ошибки
 * и кнопка перезагрузки.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Ошибка рендера:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;

    if (!error) return this.props.children;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          height: "100vh",
          padding: 32,
          background: "#121212",
          color: "#fff",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40 }}>:(</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Что-то сломалось</div>
        <div style={{ color: "#b3b3b3", maxWidth: 640, fontSize: 13, lineHeight: 1.5 }}>
          {error.message}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#ff5500",
              color: "#fff",
              border: 0,
              borderRadius: 999,
              padding: "10px 22px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Перезагрузить
          </button>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: "transparent",
              color: "#b3b3b3",
              border: "1px solid #3a3a3a",
              borderRadius: 999,
              padding: "10px 22px",
              cursor: "pointer",
            }}
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }
}

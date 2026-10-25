import { useEffect, useMemo } from "react";
import {
  ArrowsClockwise,
  MusicNotes,
  Pause,
  Play,
  SignIn,
  ThumbsDown,
  Waveform,
} from "../lib/icons";
import { useAppStore } from "../stores/appStore";
import { usePlayerStore } from "../stores/playerStore";
import { useWaveStore } from "../stores/waveStore";
import { WAVE_MODES } from "../lib/wave";
import { formatDuration } from "../lib/soundcloud-api";
import { useNetworkStore } from "../stores/networkStore";
import "./Pages.css";
import "./WavePage.css";

/** Полоски, из которых складывается анимированная «волна» в шапке. */
const BARS = 44;

function artworkUrl(trackArtwork: string | null): string {
  return trackArtwork ? trackArtwork.replace("-large", "-t120x120") : "";
}

export default function WavePage() {
  const { isLoggedIn } = useAppStore();
  const {
    active,
    loading,
    mode,
    error,
    played,
    artistScores,
    start,
    stop,
    restart,
    setMode,
    dislike,
    resetHistory,
  } = useWaveStore();
  const { queue, queueIndex, currentTrack, isPlaying, progress, play, togglePlay } =
    usePlayerStore();

  // Очередь волны не дублируется в сторе: показываем то, что ещё не сыграло
  const upcoming = useMemo(
    () => (active ? queue.slice(queueIndex + 1) : []),
    [active, queue, queueIndex]
  );

  // Автоматический перезапуск волны при восстановлении сети, если была ошибка
  useEffect(() => {
    return useNetworkStore.getState().onReconnect(() => {
      if (active && error) {
        void restart();
      }
    });
  }, [active, error]);

  if (!isLoggedIn) {
    return (
      <div className="page">
        <div className="wave-hero">
          <div className="wave-hero-inner">
            <div className="wave-badge">
              <Waveform size={16} weight="fill" />
              Моя волна
            </div>
            <h1 className="wave-title">Музыка, которая знает твои вкусы</h1>
            <p className="wave-sub">
              Волна собирается из твоих лайков, подписок и похожих треков. Войди в
              SoundCloud — и она заиграет.
            </p>
            <div className="wave-actions">
              <button
                className="wave-primary"
                onClick={() => window.electronAPI?.openAuthWindow()}
              >
                <SignIn size={18} weight="bold" />
                Войти в SoundCloud
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page wave-page">
      <div className={`wave-hero ${active ? "active" : ""}`}>
        <div className="wave-bars" aria-hidden="true">
          {Array.from({ length: BARS }, (_, i) => (
            <span
              key={i}
              style={{
                height: `${16 + ((i * 37) % 72)}%`,
                animationDelay: `${(i % 11) * 0.13}s`,
                animationDuration: `${2 + (i % 5) * 0.38}s`,
              }}
            />
          ))}
        </div>

        <div className="wave-hero-inner">
          <div className="wave-badge">
            <Waveform size={16} weight="fill" />
            Моя волна
          </div>

          <h1 className="wave-title">Бесконечный поток по твоим вкусам</h1>
          <p className="wave-sub">
            Лайки, подписки и похожие треки. Волна сама решает, что поставить дальше —
            и не заканчивается.
          </p>

          <div className="wave-actions">
            {active ? (
              <>
                <button className="wave-primary" onClick={stop}>
                  <Pause size={18} weight="fill" />
                  Остановить
                </button>
                <button className="btn-ghost" onClick={restart} disabled={loading}>
                  <ArrowsClockwise size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
                  Другая волна
                </button>
              </>
            ) : (
              <button className="wave-primary" onClick={start} disabled={loading}>
                {loading ? (
                  <>
                    <span className="wave-spinner" />
                    Собираю волну…
                  </>
                ) : (
                  <>
                    <Play size={18} weight="fill" />
                    Включить волну
                  </>
                )}
              </button>
            )}
          </div>

          {error && <div className="wave-error">{error}</div>}

          <div className="wave-meta">
            <span>{played.length} треков в истории</span>
            {active && <span>{upcoming.length} впереди</span>}
          </div>
        </div>
      </div>

      <div className="wave-modes">
        {WAVE_MODES.map((item) => (
          <button
            key={item.id}
            className={`wave-mode ${mode === item.id ? "active" : ""}`}
            onClick={() => setMode(item.id)}
          >
            <span className="wave-mode-name">{item.label}</span>
            <span className="wave-mode-hint">{item.hint}</span>
          </button>
        ))}
      </div>

      {active && currentTrack && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Сейчас играет</h2>
          </div>

          <div className="wave-now">
            <div className="wave-now-art">
              {artworkUrl(currentTrack.artwork_url) ? (
                <img src={artworkUrl(currentTrack.artwork_url)} alt="" />
              ) : (
                <MusicNotes size={28} />
              )}
            </div>

            <div className="wave-now-text">
              <div className="wave-now-title">{currentTrack.title}</div>
              <div className="wave-now-artist">
                {currentTrack.user?.username ?? "Неизвестный автор"}
              </div>
              <div className="wave-progress">
                <span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
              </div>
            </div>

            <button
              className="wave-play"
              onClick={togglePlay}
              title={isPlaying ? "Пауза" : "Играть"}
            >
              {isPlaying ? (
                <Pause size={20} weight="fill" />
              ) : (
                <Play size={20} weight="fill" />
              )}
            </button>
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-header">
          <h2 className="section-title">Дальше в волне</h2>
          {upcoming.length > 0 && <span className="wave-count">{upcoming.length}</span>}
        </div>

        {upcoming.length > 0 ? (
          <div className="wave-list">
            {upcoming.map((track, i) => {
              const artwork = artworkUrl(track.artwork_url);

              return (
                <div className="wave-row" key={track.id}>
                  <button
                    className="wave-row-art"
                    onClick={() => play(track, queue, queueIndex + 1 + i, { allowDrm: true })}
                    title="Играть"
                  >
                    {artwork ? <img src={artwork} alt="" /> : <MusicNotes size={18} />}
                    <span className="wave-row-play">
                      <Play size={14} weight="fill" />
                    </span>
                  </button>

                  <div className="wave-row-text">
                    <div className="wave-row-title">{track.title}</div>
                    <div className="wave-row-artist">
                      {track.user?.username ?? "Неизвестный автор"}
                    </div>
                  </div>

                  <span className="wave-row-genre">{track.genre ?? ""}</span>
                  <span className="wave-row-time">
                    {formatDuration(track.duration ?? 0)}
                  </span>

                  <button
                    className="wave-dislike"
                    onClick={() => dislike(track)}
                    title="Больше не предлагать"
                  >
                    <ThumbsDown size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <Waveform size={28} />
            </div>
            <div className="empty-title">
              {active ? "Волна собирает следующие треки" : "Волна выключена"}
            </div>
            <div className="empty-text">
              {active
                ? "Как только очередь дойдёт до конца, здесь появятся новые — без остановки."
                : "Нажми «Включить волну» — музыка пойдёт сама и не кончится."}
            </div>
          </div>
        )}
      </section>

      {(played.length > 0 || Object.keys(artistScores).length > 0) && (
        <button className="wave-reset" onClick={resetHistory}>
          Сбросить историю и дизлайки
        </button>
      )}
    </div>
  );
}

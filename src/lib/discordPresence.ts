// Активность Discord Rich Presence.
//
// Renderer знает, что сейчас играет, а подключением к Discord занимается
// main-процесс. Здесь собираем payload и отправляем его в main.

import { usePlayerStore } from "../stores/playerStore";

let startedAt = Math.floor(Date.now() / 1000);
let lastTrackId: number | null = null;

/** Отправляет текущее состояние плеера в Discord. */
export function pushDiscordPresence(): void {
  const { currentTrack, isPlaying } = usePlayerStore.getState();

  if (!currentTrack) {
    void window.electronAPI?.setDiscordPresence?.(null);
    return;
  }

  if (currentTrack.id !== lastTrackId) {
    lastTrackId = currentTrack.id;
    startedAt = Math.floor(Date.now() / 1000);
  }

  void window.electronAPI?.setDiscordPresence?.({
    details: currentTrack.title,
    state: isPlaying ? (currentTrack.user?.username ?? "SoundWave") : "пауза",
    largeText: "SoundWave",
    smallText: isPlaying ? "Сейчас играет" : "На паузе",
    startTimestamp: startedAt,
  });
}

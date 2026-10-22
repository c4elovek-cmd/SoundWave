// Активность Discord Rich Presence.
//
// Renderer знает, что сейчас играет, а подключением к Discord занимается
// main-процесс. Здесь собираем payload и отправляем его в main.

import { usePlayerStore } from "../stores/playerStore";

let startedAt = Math.floor(Date.now() / 1000);
let lastTrackId: number | null = null;

/**
 * Ссылка на обложку в размере, который Discord покажет без мыла.
 *
 * SoundCloud отдаёт картинки вида `artworks-...-large.jpg` (100×100).
 * Discord умеет принимать внешний URL вместо ассета из Developer Portal,
 * поэтому подставляем обложку самого трека — так в профиле видно, что играет.
 */
function artworkForDiscord(url: string | null | undefined): string {
  if (!url) return "";

  // Меняем суффикс размера на 500×500: у SoundCloud это готовый вариант.
  const resized = url.replace(
    /-(large|t\d+x\d+|small|badge|crop|original)\.(jpg|jpeg|png|webp)$/i,
    "-t500x500.$2"
  );

  return resized.startsWith("https://") ? resized : "";
}

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
    // Обложка трека вместо статичного ассета приложения.
    artworkUrl: artworkForDiscord(currentTrack.artwork_url),
    largeText: currentTrack.title,
    smallText: isPlaying ? "Сейчас играет" : "На паузе",
    startTimestamp: startedAt,
  });
}

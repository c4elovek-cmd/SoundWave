// Мост между HTTP API в main-процессе и состоянием приложения в renderer.
//
// Агент вызывает HTTP-эндпоинт, main отправляет команду сюда, а здесь
// она выполняется над zustand-сторами и API SoundCloud. Ответ уходит
// обратно в main и превращается в JSON.

import { usePlayerStore } from "../stores/playerStore";
import { useAppStore, View } from "../stores/appStore";
import { scApi, getArtwork } from "./soundcloud-api";
import { parseLrc } from "./lyrics";
import { logAction } from "./actionLog";
import { SCPlaylist, SCTrack, SCUser } from "../types/soundcloud";

interface AgentRequest {
  id: string;
  type: string;
  payload?: unknown;
}

interface AgentResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

class BridgeError extends Error {
  code: string;

  constructor(message: string, code = "error") {
    super(message);
    this.code = code;
  }
}

function fail(message: string): never {
  throw new BridgeError(message, "bad_request");
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function isPlayable(track: SCTrack | null | undefined): track is SCTrack {
  if (!track || typeof track.id !== "number" || !track.title) return false;
  if (track.streamable === false) return false;
  return track.policy !== "BLOCK" && track.policy !== "SNIP";
}

function simplifyTrack(track: SCTrack | null): Record<string, unknown> | null {
  if (!track) return null;

  return {
    id: track.id,
    title: track.title,
    artist: track.user?.username ?? null,
    artistId: track.user?.id ?? null,
    artwork: getArtwork(track) || null,
    duration: Math.round((track.duration ?? 0) / 1000),
    genre: track.genre ?? null,
    permalink: track.permalink_url ?? null,
    playable: isPlayable(track),
    likes: track.likes_count ?? null,
    plays: track.playback_count ?? null,
  };
}

function simplifyUser(user: SCUser | null): Record<string, unknown> | null {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name || null,
    followers: user.followers_count ?? null,
    tracks: user.track_count ?? null,
    permalink: `https://soundcloud.com/${user.username}`,
  };
}

function simplifyPlaylist(playlist: SCPlaylist): Record<string, unknown> {
  return {
    id: playlist.id,
    title: playlist.title,
    artist: playlist.user?.username ?? null,
    artwork: playlist.artwork_url ?? null,
    trackCount: playlist.track_count ?? null,
    duration: Math.round((playlist.duration ?? 0) / 1000),
    permalink: playlist.permalink_url ?? null,
  };
}

function stateSnapshot() {
  const player = usePlayerStore.getState();
  const app = useAppStore.getState();
  const audio = player.audio;

  const duration =
    audio?.duration && Number.isFinite(audio.duration)
      ? audio.duration
      : (player.duration ?? 0) / 1000;

  const position =
    audio && Number.isFinite(audio.currentTime)
      ? audio.currentTime
      : player.progress * duration;

  return {
    app: "SoundWave",
    user: simplifyUser(app.currentUser),
    loggedIn: app.isLoggedIn,
    view: app.view,
    theme: app.theme,
    track: simplifyTrack(player.currentTrack),
    playing: player.isPlaying,
    position: Math.round(position * 10) / 10,
    duration: Math.round((duration || 0) * 10) / 10,
    progress: Math.round((player.progress || 0) * 1000) / 1000,
    volume: Math.round(player.volume * 100) / 100,
    muted: player.isMuted,
    shuffle: player.isShuffled,
    repeat: player.repeat,
    queue: { index: player.queueIndex, length: player.queue.length },
    panels: { queue: app.queueVisible, lyrics: app.lyricsVisible },
    error: player.error,
    serverTime: new Date().toISOString(),
  };
}

function queueSnapshot() {
  const player = usePlayerStore.getState();
  return {
    index: player.queueIndex,
    length: player.queue.length,
    tracks: player.queue.map(simplifyTrack),
  };
}

async function resolveTracks(payload: Record<string, unknown>): Promise<{
  list: SCTrack[];
  index: number;
}> {
  if (payload.id !== undefined) {
    const id = Number(payload.id);
    if (!Number.isFinite(id)) fail("id должен быть числом");
    const track = await scApi.getTrack(id);
    if (!isPlayable(track)) fail("Этот трек нельзя воспроизвести");
    return { list: [track], index: 0 };
  }

  if (typeof payload.url === "string" && payload.url.trim()) {
    const resolved = (await window.electronAPI.scRequest("resolve", {
      url: payload.url.trim(),
    })) as Record<string, unknown>;

    if (resolved?.kind === "track") {
      const track = resolved as unknown as SCTrack;
      if (!isPlayable(track)) fail("Этот трек нельзя воспроизвести");
      return { list: [track], index: 0 };
    }

    if (resolved?.kind === "playlist" && Array.isArray(resolved.tracks)) {
      const list = (resolved.tracks as SCTrack[]).filter(isPlayable);
      if (list.length === 0) fail("В плейлисте нет доступных треков");
      return { list, index: 0 };
    }

    fail("Ссылка не ведёт на трек или плейлист SoundCloud");
  }

  if (typeof payload.query === "string" && payload.query.trim().length >= 2) {
    const found = await scApi.searchTracks(payload.query.trim(), 10);
    const list = found.collection.filter(isPlayable);
    if (list.length === 0) fail("По запросу ничего не найдено");
    return { list, index: 0 };
  }

  fail("Нужен id, url или query (не короче 2 символов)");
}

async function handleRequest(request: AgentRequest): Promise<unknown> {
  const payload = (request.payload && typeof request.payload === "object"
    ? request.payload
    : {}) as Record<string, unknown>;

  logAction("agent.command", { type: request.type });

  switch (request.type) {
    case "state":
      return stateSnapshot();

    case "play": {
      const { list, index } = await resolveTracks(payload);
      const track = list[index];
      // play объявлен как void, но внутри async — ждём подготовку потока.
      await Promise.resolve(usePlayerStore.getState().play(track, list, index));
      return {
        track: simplifyTrack(track),
        queueLength: list.length,
        state: stateSnapshot(),
      };
    }

    case "control": {
      const player = usePlayerStore.getState();
      const action = String(payload.action ?? "");

      switch (action) {
        case "play":
          player.resume();
          break;
        case "pause":
          player.pause();
          break;
        case "toggle":
          player.togglePlay();
          break;
        case "next":
          player.next();
          break;
        case "prev":
          player.prev();
          break;
        case "seek": {
          const total =
            player.audio?.duration && Number.isFinite(player.audio.duration)
              ? player.audio.duration
              : player.duration / 1000;
          if (!total) fail("Длительность трека ещё неизвестна");

          let seconds = Number(payload.seconds);
          if (!Number.isFinite(seconds) && Number.isFinite(Number(payload.percent))) {
            seconds = Number(payload.percent) * total;
          }
          if (!Number.isFinite(seconds)) fail("Нужен seconds или percent");

          player.seek(clamp(seconds / total, 0, 1));
          break;
        }
        case "volume": {
          const value = Number(payload.value);
          if (!Number.isFinite(value)) fail("Нужен value от 0 до 1");
          player.setVolume(clamp(value, 0, 1));
          break;
        }
        case "mute":
          if (!player.isMuted) player.toggleMute();
          break;
        case "unmute":
          if (player.isMuted) player.toggleMute();
          break;
        case "shuffle": {
          const want =
            typeof payload.value === "boolean" ? payload.value : !player.isShuffled;
          if (want !== player.isShuffled) player.toggleShuffle();
          break;
        }
        case "repeat": {
          const mode = String(payload.value ?? "");
          if (!["off", "all", "one"].includes(mode)) {
            fail("repeat: off, all или one");
          }
          player.setRepeat(mode as "off" | "all" | "one");
          break;
        }
        default:
          fail(
            "action: play, pause, toggle, next, prev, seek, volume, mute, unmute, shuffle, repeat"
          );
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      return stateSnapshot();
    }

    case "search": {
      const query = String(payload.query ?? "").trim();
      if (query.length < 2) fail("Запрос должен быть не короче 2 символов");

      const type = String(payload.type ?? "tracks");
      const limit = clamp(Number(payload.limit ?? 10) || 10, 1, 50);

      if (type === "users") {
        const result = await scApi.searchUsers(query, limit);
        return {
          query,
          type,
          count: result.collection.length,
          results: result.collection.map((user) => simplifyUser(user)),
        };
      }

      if (type === "playlists") {
        const result = await scApi.searchPlaylists(query, limit);
        return {
          query,
          type,
          count: result.collection.length,
          results: result.collection.map((playlist) => simplifyPlaylist(playlist)),
        };
      }

      const result = await scApi.searchTracks(query, limit);
      return {
        query,
        type: "tracks",
        count: result.collection.length,
        results: result.collection.map((track) => simplifyTrack(track)),
      };
    }

    case "queue": {
      const player = usePlayerStore.getState();
      const action = String(payload.action ?? "list");

      if (action === "list") return queueSnapshot();

      if (action === "clear") {
        player.clearQueue();
        return queueSnapshot();
      }

      if (action === "add") {
        const id = Number(payload.trackId);
        if (!Number.isFinite(id)) fail("Нужен trackId");
        const track = await scApi.getTrack(id);
        if (!isPlayable(track)) fail("Этот трек нельзя добавить в очередь");
        player.addToQueue(track);
        return queueSnapshot();
      }

      if (action === "remove") {
        const index = Number(payload.index);
        if (Number.isFinite(index)) {
          player.removeFromQueue(index);
        } else {
          const id = Number(payload.trackId);
          if (!Number.isFinite(id)) fail("Нужен index или trackId");
          player.removeTrackById(id);
        }
        return queueSnapshot();
      }

      fail("action: list, add, remove или clear");
    }

    case "lyrics": {
      const player = usePlayerStore.getState();
      let track = player.currentTrack;

      if (payload.trackId !== undefined) {
        const id = Number(payload.trackId);
        if (!Number.isFinite(id)) fail("trackId должен быть числом");
        if (!track || track.id !== id) track = await scApi.getTrack(id);
      }

      if (!track) fail("Сейчас ничего не играет — передайте trackId");

      const title = track.title;
      const artist = track.user?.username ?? "";
      const wantSynced = payload.synced !== false;

      const [lyricsResult, syncedResult] = await Promise.allSettled([
        window.electronAPI.getLyrics(title, artist),
        wantSynced
          ? window.electronAPI.getSyncedLyrics(title, artist, track.duration ?? 0)
          : Promise.resolve(null),
      ]);

      const lyrics: {
        found: boolean;
        title?: string;
        artist?: string;
        url?: string;
        lyrics?: string;
        error?: string;
      } =
        lyricsResult.status === "fulfilled"
          ? lyricsResult.value
          : {
              found: false,
              error:
                lyricsResult.reason instanceof Error
                  ? lyricsResult.reason.message
                  : "Ошибка Genius",
            };

      const synced =
        syncedResult.status === "fulfilled" && syncedResult.value
          ? syncedResult.value
          : null;

      const lrcLines =
        synced?.found && synced.syncedLyrics ? parseLrc(synced.syncedLyrics) : [];

      const isCurrent = !player.currentTrack || player.currentTrack.id === track.id;
      const position = isCurrent ? player.audio?.currentTime ?? 0 : 0;
      let activeIndex = -1;
      if (isCurrent) {
        lrcLines.forEach((line, index) => {
          if (line.time <= position) activeIndex = index;
        });
      }

      return {
        track: simplifyTrack(track),
        found: Boolean(lyrics.found && lyrics.lyrics),
        title: lyrics.title ?? null,
        artist: lyrics.artist ?? null,
        url: lyrics.url ?? null,
        lyrics: lyrics.lyrics ?? null,
        error: lyrics.error ?? null,
        synced: {
          found: lrcLines.length > 0,
          source: lrcLines.length > 0 ? "lrclib" : "none",
          lines: lrcLines.map((line) => ({
            time: Math.round(line.time * 1000) / 1000,
            text: line.text,
          })),
          activeLineIndex: activeIndex,
          activeLine: activeIndex >= 0 ? lrcLines[activeIndex].text : null,
        },
      };
    }

    case "likes": {
      const limit = clamp(Number(payload.limit ?? 20) || 20, 1, 100);
      const result = await scApi.getMyLikes(undefined, limit);
      return {
        count: result.collection.length,
        tracks: result.collection.map((track) => simplifyTrack(track)),
      };
    }

    case "playlists": {
      const result = await scApi.getMyPlaylists(undefined, 50);
      return {
        count: result.collection.length,
        playlists: result.collection.map((playlist) => simplifyPlaylist(playlist)),
      };
    }

    case "playlist": {
      const id = Number(payload.id);
      if (!Number.isFinite(id)) fail("Нужен id плейлиста");
      const playlist = await scApi.getPlaylist(id);
      return {
        ...simplifyPlaylist(playlist),
        description: playlist.description ?? null,
        tracks: (playlist.tracks ?? []).map((track) => simplifyTrack(track)),
      };
    }

    case "track": {
      const id = Number(payload.id);
      if (!Number.isFinite(id)) fail("Нужен id трека");
      const track = await scApi.getTrack(id);
      return {
        ...simplifyTrack(track),
        description: track.description ?? null,
        tags: track.tag_list ?? null,
        downloadable: Boolean(track.downloadable),
        streamable: track.streamable ?? null,
        policy: track.policy ?? null,
      };
    }

    case "navigate": {
      const allowed: View[] = [
        "home",
        "wave",
        "search",
        "library",
        "likes",
        "uploads",
        "playlist",
        "artist",
      ];
      const view = String(payload.view ?? "") as View;
      if (!allowed.includes(view)) fail(`view: ${allowed.join(", ")}`);

      useAppStore.setState({
        view,
        currentPlaylistId: Number.isFinite(Number(payload.playlistId))
          ? Number(payload.playlistId)
          : null,
        currentArtistId: Number.isFinite(Number(payload.artistId))
          ? Number(payload.artistId)
          : null,
        ...(view === "search" && typeof payload.query === "string"
          ? { searchQuery: payload.query }
          : {}),
      });

      return { view, query: useAppStore.getState().searchQuery };
    }

    case "show":
      await window.electronAPI.showWindow();
      return { shown: true };

    case "karaoke": {
      const enabled = payload.enabled !== false;
      if (enabled) {
        // Караоке имеет смысла показывать: иначе агент откроет его в фоне.
        await window.electronAPI.showWindow();
        useAppStore.getState().openKaraokeFullscreen();
      } else {
        useAppStore.getState().closeKaraokeFullscreen();
      }
      return { karaoke: enabled };
    }

    default:
      fail(`Неизвестная команда: ${request.type}`);
  }
}

let activeDispose: (() => void) | null = null;

/** Подключает обработчик команд агента. Возвращает функцию отписки. */
export function startAgentBridge(): () => void {
  if (activeDispose) return activeDispose;

  const api = window.electronAPI;
  if (!api?.onAgentRequest || !api?.sendAgentResponse) {
    return () => undefined;
  }

  const unsubscribe = api.onAgentRequest((request) => {
    void (async () => {
      let response: AgentResponse;

      try {
        response = {
          id: request.id,
          ok: true,
          data: await handleRequest(request),
        };
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : "Неизвестная ошибка",
          code: error instanceof BridgeError ? error.code : "error",
        };
      }

      api.sendAgentResponse(response);
    })();
  });

  activeDispose = () => {
    unsubscribe();
    activeDispose = null;
  };

  return activeDispose;
}

/**
 * SoundCloud API wrapper (внутренний API веб-версии)
 *
 * Официального API у SoundCloud нет, поэтому используем внутреннее API
 * веб-клиента (api-v2.soundcloud.com).
 *
 * Запросы уходят в main-процесс: оттуда нет CORS-ограничений, и там можно
 * передать заголовок Cookie — в renderer браузер такой заголовок вырезает.
 * Авторизация — cookie сессии, полученные после входа в окне входа.
 */

const API_V2 = "https://api-v2.soundcloud.com";

let scCookies: string | null = null;

export function setAuthCookies(cookies: string) {
  scCookies = cookies;
}

export function getAuthCookies(): string | null {
  return scCookies;
}

/**
 * Запрос к внутреннему API SoundCloud через main-процесс.
 * Путь может быть относительным ("/search") или абсолютным (next_href).
 */
async function apiRequest<T>(
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  if (!window.electronAPI?.scRequest) {
    throw new Error("API SoundCloud доступно только в десктопном приложении");
  }

  return window.electronAPI.scRequest(path, params) as Promise<T>;
}

// ———————————————————————————————————————————————
// Endpoints
// ———————————————————————————————————————————————

export const scApi = {
  // Профиль текущего пользователя
  async getMe(): Promise<import("../types/soundcloud").SCUser> {
    return apiRequest("/me");
  },

  // Треки текущего пользователя (загрузки)
  async getMyTracks(limit = 50): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    return apiRequest("/me/tracks", { limit });
  },

  // Лайкнутые треки
  async getMyLikes(limit = 50): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    return apiRequest("/me/likes", { limit });
  },

  // Плейлисты текущего пользователя
  async getMyPlaylists(limit = 50): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCPlaylist>> {
    return apiRequest("/me/playlists", { limit });
  },

  // Подписки (артисты)
  async getMyFollowings(limit = 50): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCUser>> {
    return apiRequest("/me/followings", { limit });
  },

  // Треки пользователя
  async getUserTracks(userId: number, limit = 50): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    return apiRequest(`/users/${userId}/tracks`, { limit });
  },

  // Плейлист по ID
  async getPlaylist(id: number): Promise<import("../types/soundcloud").SCPlaylist> {
    return apiRequest(`/playlists/${id}`);
  },

  // Трек по ID
  async getTrack(id: number): Promise<import("../types/soundcloud").SCTrack> {
    return apiRequest(`/tracks/${id}`);
  },

  // Прямая ссылка на аудиофайл трека
  async getStreamUrl(trackId: number): Promise<string> {
    if (!window.electronAPI?.resolveStream) {
      throw new Error("Воспроизведение доступно только в десктопном приложении");
    }
    const res = await window.electronAPI.resolveStream(trackId);
    return res.url;
  },

  // Поиск
  async search(
    query: string,
    type: "tracks" | "users" | "playlists" = "tracks",
    limit = 30
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<any>> {
    return apiRequest("/search", { q: query, type, limit });
  },

  // Поиск треков
  async searchTracks(query: string, limit = 30) {
    return this.search(query, "tracks", limit);
  },

  // Поиск пользователей
  async searchUsers(query: string, limit = 20) {
    return this.search(query, "users", limit) as Promise<
      import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCUser>
    >;
  },

  // Поиск плейлистов
  async searchPlaylists(query: string, limit = 20) {
    return this.search(query, "playlists", limit) as Promise<
      import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCPlaylist>
    >;
  },

  // Загрузить следующую страницу
  async loadNext<T>(nextHref: string): Promise<import("../types/soundcloud").SCPaginatedResponse<T>> {
    return apiRequest(nextHref);
  },

  // Трендовые/популярные треки (для главной)
  async getTrending(limit = 20): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    const res = await apiRequest<any>("/charts", {
      kind: "trending",
      genre: "soundcloud:genres:all-music",
      limit,
    });

    // charts отдаёт элементы вида { track: {...} }
    const collection = (res?.collection ?? []).map((item: any) => item.track ?? item).filter(Boolean);

    return {
      collection,
      next_href: res?.next_href ?? null,
    };
  },
};

// Утилиты

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Заглушки изображений
export function getArtwork(track: { artwork_url: string | null }): string {
  if (track.artwork_url) {
    return track.artwork_url.replace("-large", "-t300x300");
  }
  return "";
}

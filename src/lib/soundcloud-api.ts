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

// ID текущего пользователя: нужен для приватных коллекций
let currentUserId: number | null = null;

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

/**
 * ID пользователя, под которым мы вошли.
 * В api-v2 приватные коллекции лежат по пути /users/{id}/..., а не /me/...
 */
async function myId(): Promise<number> {
  if (currentUserId) return currentUserId;
  const me = await apiRequest<import("../types/soundcloud").SCUser>("/me");
  currentUserId = me.id;
  return me.id;
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
  async getMyTracks(
    userId?: number,
    limit = 50
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    const id = userId ?? (await myId());
    return apiRequest(`/users/${id}/tracks`, { limit });
  },

  // Лайкнутые треки
  async getMyLikes(
    userId?: number,
    limit = 50
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    const id = userId ?? (await myId());
    return apiRequest(`/users/${id}/likes`, { limit });
  },

  // Плейлисты текущего пользователя
  async getMyPlaylists(
    userId?: number,
    limit = 50
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCPlaylist>> {
    const id = userId ?? (await myId());
    return apiRequest(`/users/${id}/playlists`, { limit });
  },

  // Подписки (артисты)
  async getMyFollowings(
    userId?: number,
    limit = 50
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCUser>> {
    const id = userId ?? (await myId());
    return apiRequest(`/users/${id}/followings`, { limit });
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

  // Похожие треки — основа «Моей волны»
  async getRelated(
    trackId: number,
    limit = 20
  ): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    const res = await apiRequest<any>(`/tracks/${trackId}/related`, { limit });
    const collection = (res?.collection ?? [])
      .map((item: any) => item?.track ?? item)
      .filter((t: any) => t && typeof t.id === "number" && t.title && t.user);
    return { collection, next_href: res?.next_href ?? null };
  },

  // Прямая ссылка на аудиофайл трека
  async getStreamUrl(trackId: number): Promise<{ url: string; protocol: string }> {
    if (!window.electronAPI?.resolveStream) {
      throw new Error("Воспроизведение доступно только в десктопном приложении");
    }
    return window.electronAPI.resolveStream(trackId) as Promise<{
      url: string;
      protocol: string;
    }>;
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
  //
  // SoundCloud подмешивает в выдачу `type=tracks` профили пользователей
  // (`kind=user`): у них нет ни `title`, ни `user`, и рендер на них падал
  // с «Cannot read properties of undefined (reading 'username')» —
  // React размонтировал всё дерево, и окно становилось чёрным.
  async searchTracks(query: string, limit = 30) {
    const res = (await this.search(query, "tracks", limit)) as import("../types/soundcloud").SCPaginatedResponse<any>;
    const collection = (res.collection ?? []).filter(
      (t: any) => t && (t.kind === undefined || t.kind === "track") && typeof t.id === "number" && t.title
    );
    return { ...res, collection } as typeof res;
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

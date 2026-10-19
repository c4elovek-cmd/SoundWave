/**
 * SoundCloud API wrapper (internal API веб-версии)
 *
 * Официального API у SoundCloud нет, поэтому используем внутреннее API
 * веб-клиента (api-v2.soundcloud.com). Авторизация происходит через
 * cookie сессии, полученные после входа в WebView-окне.
 */

const API_V2 = "https://api-v2.soundcloud.com";
const API_WEB = "https://soundcloud.com";

let scCookies: string | null = null;
let clientId: string | null = null;

export function setAuthCookies(cookies: string) {
  scCookies = cookies;
}

export function getAuthCookies(): string | null {
  return scCookies;
}

/**
 * Получаем client_id из HTML-страницы SoundCloud.
 * client_id — публичный, но меняется со временем, поэтому извлекаем при необходимости.
 */
async function getClientId(): Promise<string> {
  if (clientId) return clientId;

  const html = await fetch(`${API_WEB}/`).then((r) => r.text());
  const scriptUrls = html.match(/src="(https:\/\/[^"]+\.js)"/g) || [];

  for (const match of scriptUrls) {
    const src = match?.match(/src="([^"]+)"/)?.[1];
    if (!src) continue;

    try {
      const script = await fetch(src).then((r) => r.text());
      const idMatch = script.match(/"client_id":"([a-zA-Z0-9]{32})"/);
      if (idMatch) {
        clientId = idMatch[1];
        return clientId;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Не удалось получить client_id SoundCloud");
}

async function apiRequest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const id = await getClientId();
  const url = new URL(`${API_V2}${path}`);
  url.searchParams.set("client_id", id);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (scCookies) {
    headers["Cookie"] = scCookies;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    throw new Error(`SoundCloud API error ${response.status}: ${path}`);
  }

  return response.json();
}

function fromUrl<T>(url: string): Promise<T> {
  return fetch(url).then((r) => r.json());
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

  // Стрим трека
  async getStreamUrl(trackId: number): Promise<string> {
    const id = await getClientId();
    return `${API_V2}/tracks/${trackId}/stream?client_id=${id}`;
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
    return fromUrl(nextHref);
  },

  // Трендовые/популярные треки (для главной)
  async getTrending(limit = 20): Promise<import("../types/soundcloud").SCPaginatedResponse<import("../types/soundcloud").SCTrack>> {
    return apiRequest("/charts", { kind: "top", genre: "soundcloud:genres:all-music", limit });
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

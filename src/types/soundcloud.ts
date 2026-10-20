// Типы данных SoundCloud

export interface SCUser {
  id: number;
  username: string;
  full_name: string;
  avatar_url: string;
  followers_count?: number;
  following_count?: number;
  playlist_count?: number;
  track_count?: number;
  likes_count?: number;
}

export interface SCTrack {
  id: number;
  title: string;
  user: SCUser;
  // "track" для треков, "user" для профилей, которые SoundCloud
  // иногда подмешивает в выдачу поиска
  kind?: string;
  /**
   * Политика стриминга: "ALLOW" и "MONETIZE" — обычные треки,
   * "SNIP" — только 30-секундный фрагмент, "BLOCK" — играть нельзя.
   */
  policy?: string;
  streamable?: boolean;
  artwork_url: string | null;
  waveform_url: string;
  duration: number; // мс
  genre: string | null;
  tag_list: string;
  label_name: string | null;
  playback_count: number;
  likes_count: number;
  reposts_count: number;
  permalink_url: string;
  stream_url: string;
  downloadable: boolean;
  created_at: string;
  description: string | null;
  // Для отображения
  display_title?: string;
}

export interface SCPlaylist {
  id: number;
  title: string;
  user: SCUser;
  artwork_url: string | null;
  duration: number;
  track_count: number;
  permalink_url: string;
  description: string | null;
  tracks?: SCTrack[];
  created_at: string;
  likes_count?: number;
  reposts_count?: number;
}

export interface SCLike {
  track: SCTrack;
  created_at: string;
}

export interface SCComment {
  id: number;
  body: string;
  user: SCUser;
  timestamp: number;
  created_at: string;
}

// Типы для внутреннего API
export interface SCAuthToken {
  access_token: string;
  expires_in: number;
  scope: string;
  client_id: string;
}

export interface SCPaginatedResponse<T> {
  collection: T[];
  next_href: string | null;
  query_urn?: string;
}

// Player state
export type RepeatMode = "off" | "all" | "one";
export type PlayerView = "home" | "search" | "library" | "likes" | "playlist" | "artist" | "upload" | "auth";

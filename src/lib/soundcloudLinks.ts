/**
 * Ссылки на SoundCloud.
 *
 * У трека permalink_url приходит из API, а у автора его можно собрать
 * из имени пользователя.
 */
export function trackUrl(track: { permalink_url?: string }): string | null {
  if (track.permalink_url) return track.permalink_url;
  return null;
}

export function userUrl(user: {
  permalink_url?: string;
  username?: string;
}): string | null {
  if (user.permalink_url) return user.permalink_url;
  if (user.username) return `https://soundcloud.com/${user.username}`;
  return null;
}
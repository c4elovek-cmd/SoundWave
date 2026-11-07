/**
 * Поиск «сиблинга» — другого перезалива той же песни.
 *
 * Перезаливы часто переименовывают песню: в названии оказывается строка
 * из текста плюс ник исполнителя — «enveel время на часах уже 2» вместо
 * «2:00» от enveel. По такому названию LRCLIB и Genius не находят ничего.
 *
 * Идея: сам SoundCloud знает о перезаливах. Ищем по слову из названия,
 * среди результатов берём трек с той же длительностью (±2.5 с), у которого
 * артист написан в нашем названии, — и его название/артист отдаём как
 * новую пару для поиска текста.
 *
 * Защита от чужого текста: совпадение длительности само по себе ничего
 * не решает («8 миля» перезалива и оригинал madk1d одной длины) — мостик
 * принимается, только если артист сиблинга узнаётся в нашем названии.
 */

import { SCTrack } from "../types/soundcloud";
import { scApi } from "./soundcloud-api";

export interface SiblingQuery {
  title: string;
  artist: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function findSiblingTitle(
  track: SCTrack
): Promise<SiblingQuery | null> {
  const ourDuration = track.duration ?? 0;
  if (!ourDuration) return null;

  const ourTitle = normalize(track.title);
  const ourJoined = ourTitle.replace(/ /g, "");
  if (!ourJoined) return null;

  // Слова-кандидаты для поиска: достаточно длинные, без повторов.
  const tokens = [...new Set(ourTitle.split(" "))]
    .filter((word) => word.length >= 4)
    .slice(0, 3);

  for (const token of tokens) {
    let collection: SCTrack[] = [];
    try {
      const res = await scApi.searchTracks(token, 20);
      collection = res.collection ?? [];
    } catch {
      continue;
    }

    for (const candidate of collection) {
      if (!candidate || candidate.id === track.id) continue;

      // Та же длительность: перезаливы не меняют хронометраж.
      const duration = candidate.duration ?? 0;
      if (!duration || Math.abs(duration - ourDuration) > 2500) continue;

      // Артист сиблинга должен узнаваться в нашем названии — так
      // «2:00 - enveel» проходит для «enveel время на часах уже 2»,
      // а чужая «8 миля» madk1d не проходит для перезалива raveisdead.
      const candidateArtist =
        normalize(candidate.user?.username ?? "").replace(/ /g, "") ?? "";
      if (candidateArtist.length < 4 || !ourJoined.includes(candidateArtist)) {
        continue;
      }

      // Совершенно то же название и артист — это дубль, а не сиблинг.
      const candidateTitle = normalize(candidate.title);
      if (candidateTitle === ourTitle) continue;

      return {
        title: candidate.title,
        artist: candidate.user?.username ?? "",
      };
    }
  }

  return null;
}

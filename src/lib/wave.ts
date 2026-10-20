/**
 * Движок «Моей волны» — бесконечного потока рекомендаций.
 *
 * Официального API рекомендаций у SoundCloud нет, поэтому волна собирается
 * из того, что отдаёт внутреннее API:
 *   • /tracks/{id}/related  — похожие треки на лайкнутые;
 *   • /users/{id}/tracks     — треки артистов из подписок и лайков;
 *   • /search?q=<жанр>       — свежие треки любимых жанров;
 *   • /charts?kind=trending  — общие тренды.
 *
 * Каждый источник даёт треки со своим весом, дальше идёт взвешенная
 * случайная выборка. Поэтому два запуска волны подряд не повторяются.
 */

import { SCTrack, SCUser } from "../types/soundcloud";
import { scApi } from "./soundcloud-api";

export type WaveMode = "familiar" | "mixed" | "fresh";

export const WAVE_MODES: { id: WaveMode; label: string; hint: string }[] = [
  { id: "familiar", label: "Знакомое", hint: "Больше похожего на лайки" },
  { id: "mixed", label: "Всё вместе", hint: "Любимое и новое вперемешку" },
  { id: "fresh", label: "Новое", hint: "Больше незнакомых артистов" },
];

export interface WaveSeed {
  likes: SCTrack[];
  followings: SCUser[];
}

export interface CollectOptions {
  seed: WaveSeed;
  mode: WaveMode;
  /** id треков, которые нельзя предлагать: уже играли или дизлайкнули */
  exclude: Set<number>;
  /** артисты, которых пользователь дизлайкнул несколько раз */
  blockedArtists?: Set<number>;
  limit?: number;
}

interface Candidate {
  track: SCTrack;
  weight: number;
}

interface WeightSet {
  /** сколько случайных лайков берём за якоря */
  anchors: number;
  related: number;
  /** сколько артистов из подписок опрашиваем */
  followedArtists: number;
  followed: number;
  /** сколько любимых артистов из лайков опрашиваем */
  favouriteArtists: number;
  favourite: number;
  /** сколько жанров ищем */
  genres: number;
  genre: number;
  trending: number;
}

const WEIGHTS: Record<WaveMode, WeightSet> = {
  familiar: {
    anchors: 5,
    related: 3.2,
    followedArtists: 2,
    followed: 2.4,
    favouriteArtists: 2,
    favourite: 2.6,
    genres: 1,
    genre: 1.4,
    trending: 0.6,
  },
  mixed: {
    anchors: 4,
    related: 2.4,
    followedArtists: 3,
    followed: 2.2,
    favouriteArtists: 2,
    favourite: 2,
    genres: 2,
    genre: 1.8,
    trending: 1.2,
  },
  fresh: {
    anchors: 2,
    related: 1.2,
    followedArtists: 4,
    followed: 1.8,
    favouriteArtists: 1,
    favourite: 1,
    genres: 3,
    genre: 2.4,
    trending: 2,
  },
};

/**
 * Трек годится в волну: есть id, название, автор и SoundCloud разрешает
 * его воспроизведение.
 *
 * Важно: `policy` бывает "ALLOW" и "MONETIZE" — оба варианта нормально
 * играются (MONETIZE стоит почти на всех треках). Неиграбельные — только
 * "SNIP" (30-секундный фрагмент) и "BLOCK".
 */
export function isPlayableTrack(value: unknown): value is SCTrack {
  const track = value as SCTrack | null | undefined;
  const policy = String(track?.policy ?? "").toUpperCase();

  return Boolean(
    track &&
      typeof track.id === "number" &&
      typeof track.title === "string" &&
      track.title.length > 0 &&
      track.user &&
      typeof track.user.id === "number" &&
      (track.kind === undefined || track.kind === "track") &&
      policy !== "BLOCK" &&
      policy !== "SNIP" &&
      track.streamable !== false
  );
}

/** Лайки приходят как { track: ... }, иногда как сам трек. */
export function normalizeLikes(items: unknown[]): SCTrack[] {
  return (items ?? [])
    .map((item) => {
      const entry = item as { track?: SCTrack } | SCTrack | null;
      return entry && "track" in entry && entry.track ? entry.track : (entry as SCTrack);
    })
    .filter(isPlayableTrack);
}

function pickRandom<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];

  const copy = [...items];
  const result: T[] = [];

  while (result.length < count && copy.length > 0) {
    result.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }

  return result;
}

function topGenres(likes: SCTrack[], count: number): string[] {
  const counter = new Map<string, number>();

  for (const track of likes) {
    const genre = (track.genre ?? "").trim();
    // Год в поле genre встречается часто, но жанром не является
    if (!genre || /^\d{4}$/.test(genre)) continue;
    counter.set(genre, (counter.get(genre) ?? 0) + 1);
  }

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([genre]) => genre);
}

function topArtists(likes: SCTrack[], count: number): SCUser[] {
  const counter = new Map<number, { user: SCUser; likes: number }>();

  for (const track of likes) {
    if (!isPlayableTrack(track)) continue;
    const prev = counter.get(track.user.id);
    if (prev) prev.likes += 1;
    else counter.set(track.user.id, { user: track.user, likes: 1 });
  }

  return [...counter.values()]
    .sort((a, b) => b.likes - a.likes)
    .slice(0, count)
    .map((item) => item.user);
}

/** Взвешенная выборка без повторов. */
function weightedSample(pool: Map<number, Candidate>, count: number): SCTrack[] {
  const items = [...pool.values()];
  const result: SCTrack[] = [];

  while (result.length < count && items.length > 0) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    let index = 0;

    for (; index < items.length - 1; index++) {
      roll -= items[index].weight;
      if (roll <= 0) break;
    }

    result.push(items[index].track);
    items.splice(index, 1);
  }

  return result;
}

/**
 * Собирает порцию треков для волны.
 *
 * Все источники опрашиваются параллельно; если один упал (сеть, 404),
 * волна всё равно собирается из остальных.
 */
export async function collectWaveCandidates({
  seed,
  mode,
  exclude,
  blockedArtists = new Set<number>(),
  limit = 12,
}: CollectOptions): Promise<SCTrack[]> {
  const weights = WEIGHTS[mode];
  const pool = new Map<number, Candidate>();

  const add = (track: SCTrack, weight: number) => {
    if (!isPlayableTrack(track)) return;
    if (exclude.has(track.id)) return;
    if (blockedArtists.has(track.user.id)) return;

    const prev = pool.get(track.id);
    if (prev) prev.weight = Math.max(prev.weight, weight);
    else pool.set(track.id, { track, weight });
  };

  const jobs: Promise<void>[] = [];

  // Источник не должен ронять всю волну: ошибки просто пропускаем
  const fromSource = <T>(request: Promise<T>, apply: (data: T) => void) => {
    jobs.push(
      request
        .then((data) => {
          try {
            apply(data);
          } catch {
            /* некорректный ответ источника — пропускаем */
          }
        })
        .catch(() => undefined)
    );
  };

  // 1. Похожие треки на случайные лайки
  const anchors = pickRandom(seed.likes.filter(isPlayableTrack), weights.anchors);
  for (const anchor of anchors) {
    fromSource(scApi.getRelated(anchor.id, 15), (res) => {
      for (const track of res?.collection ?? []) add(track, weights.related);
    });
  }

  // 2. Новое у артистов, на которых подписан
  const followed = pickRandom(seed.followings, weights.followedArtists);
  for (const artist of followed) {
    fromSource(scApi.getUserTracks(artist.id, 12), (res) => {
      for (const track of res?.collection ?? []) add(track, weights.followed);
    });
  }

  // 3. Любимые артисты из лайков
  const favourites = pickRandom(topArtists(seed.likes, 6), weights.favouriteArtists);
  for (const artist of favourites) {
    fromSource(scApi.getUserTracks(artist.id, 10), (res) => {
      for (const track of res?.collection ?? []) add(track, weights.favourite);
    });
  }

  // 4. Поиск по жанрам лайков
  const genres = pickRandom(topGenres(seed.likes, 6), weights.genres);
  for (const genre of genres) {
    fromSource(scApi.searchTracks(genre, 15), (res) => {
      for (const track of res?.collection ?? []) add(track, weights.genre);
    });
  }

  // 5. Общие тренды — источник свежего
  if (weights.trending > 0) {
    fromSource(scApi.getTrending(25), (res) => {
      for (const track of res?.collection ?? []) add(track, weights.trending);
    });
  }

  await Promise.allSettled(jobs);

  return weightedSample(pool, limit);
}

/** Загружает лайки и подписки, из которых собирается волна. */
export async function loadWaveSeed(): Promise<WaveSeed> {
  const [likesResult, followingsResult] = await Promise.allSettled([
    scApi.getMyLikes(undefined, 100),
    scApi.getMyFollowings(undefined, 50),
  ]);

  const likes =
    likesResult.status === "fulfilled"
      ? normalizeLikes((likesResult.value.collection ?? []) as unknown[])
      : [];

  const followings =
    followingsResult.status === "fulfilled" ? followingsResult.value.collection ?? [] : [];

  return { likes, followings };
}

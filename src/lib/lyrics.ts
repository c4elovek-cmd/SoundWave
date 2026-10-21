// Разбор текста и синхронизация строк для режима караоке.
//
// Genius отдаёт только plain text, без времени. Если LRCLIB нашёл LRC —
// выравниваем его строки с текстом Genius и берём настоящие тайминги.
// Если нет — раскладываем строки по длительности трека, взвешивая их
// по количеству символов.

export interface LyricsLine {
  text: string;
  isBlank: boolean;
  isSection: boolean;
  /** Время начала строки в секундах; null — строка без тайминга. */
  start: number | null;
}

interface LrcLine {
  time: number;
  text: string;
}

const SECTION_RE = /^\[[^\]]+\]$/;

function normalizeLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Разбирает plain text Genius на строки, сохраняя пустые и секции. */
export function parseLyrics(lyrics: string): LyricsLine[] {
  return lyrics.split("\n").map((raw) => {
    const text = raw.trim();
    return {
      text,
      isBlank: text.length === 0,
      isSection: SECTION_RE.test(text),
      start: null,
    };
  });
}

/** Разбирает LRC: поддерживает несколько меток времени в одной строке. */
export function parseLrc(lrc: string): LrcLine[] {
  const result: LrcLine[] = [];

  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;

    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;

    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fractionRaw = stamp[3] ?? "0";
      const fraction = Number(fractionRaw.padEnd(3, "0").slice(0, 3)) / 1000;

      result.push({ time: minutes * 60 + seconds + fraction, text });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

function sungIndices(lines: LyricsLine[]): number[] {
  const result: number[] = [];
  lines.forEach((line, index) => {
    if (!line.isBlank && !line.isSection) result.push(index);
  });
  return result;
}

/**
 * Сопоставляет строки LRC со строками Genius по порядку.
 * Возвращает карту «индекс строки Genius → время начала».
 */
export function alignLrc(lines: LyricsLine[], lrcLines: LrcLine[]): Map<number, number> {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.isBlank && !line.isSection);

  if (candidates.length === 0 || lrcLines.length === 0) return new Map();

  const a = candidates.map(({ line }) => normalizeLine(line.text));
  const b = lrcLines.map((entry) => normalizeLine(entry.text));

  const n = a.length;
  const m = b.length;

  // dp[i][j] — длина наибольшей общей подпоследовательности a[i..] и b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result = new Map<number, number>();
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();

  // Восстанавливаем выравнивание
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.set(candidates[i].index, lrcLines[j].time);
      matchedA.add(i);
      matchedB.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // Второй проход: оставшиеся строки ищем нечётко, рядом с ожидаемой позицией.
  for (let k = 0; k < n; k++) {
    if (matchedA.has(k)) continue;

    const expected = Math.round((k * m) / Math.max(1, n));
    for (let offset = -3; offset <= 3; offset++) {
      const index = expected + offset;
      if (index < 0 || index >= m || matchedB.has(index)) continue;
      if (!sameLine(a[k], b[index])) continue;

      result.set(candidates[k].index, lrcLines[index].time);
      matchedA.add(k);
      matchedB.add(index);
      break;
    }
  }

  return result;
}

/**
 * Раскладывает строки между двумя известными моментами.
 *
 * Промежуток делится на n+1 частей: первая доля — хвост предыдущей строки,
 * последняя — пауза перед следующей. Благодаря этому промежуточная строка
 * начинается строго позже предыдущей и не делит с ней одно время — иначе
 * караоке «перескакивал» через строку.
 */
function distribute(
  indices: number[],
  from: number,
  to: number,
  lines: LyricsLine[],
  times: Map<number, number>
) {
  if (indices.length === 0) return;

  const weights = indices.map((index) => Math.max(8, lines[index].text.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(0.001, to - from);

  // Средняя доля — это «хвост» предыдущей строки, он же отступ перед первой.
  const avg = total / indices.length;
  const denom = total + avg;

  let acc = avg;
  indices.forEach((index, i) => {
    times.set(index, from + (span * acc) / denom);
    acc += weights[i];
  });
}

/**
 * Строит тайминги для всех поющихся строк.
 * mapped — известные времена из LRC; промежутки заполняются оценкой.
 */
function fillTimings(
  lines: LyricsLine[],
  mapped: Map<number, number>,
  duration: number
): LyricsLine[] {
  const result = lines.map((line) => ({ ...line }));

  if (duration <= 0) return result;

  const sung = sungIndices(result);
  if (sung.length === 0) return result;

  const times = new Map<number, number>();
  const start = duration * 0.03;
  const end = duration * 0.98;

  const known = [...mapped.entries()]
    .filter(([index]) => result[index] && !result[index].isBlank && !result[index].isSection)
    .sort((a, b) => a[0] - b[0]);

  if (known.length === 0) {
    distribute(sung, start, end, result, times);
  } else {
    const first = known[0];
    distribute(
      sung.filter((index) => index < first[0]),
      start,
      Math.max(start, first[1]),
      result,
      times
    );

    for (let i = 0; i < known.length - 1; i++) {
      const [prevIndex, prevTime] = known[i];
      const [nextIndex, nextTime] = known[i + 1];
      distribute(
        sung.filter((index) => index > prevIndex && index < nextIndex),
        prevTime,
        Math.max(prevTime, nextTime),
        result,
        times
      );
    }

    const last = known[known.length - 1];
    distribute(
      sung.filter((index) => index > last[0]),
      last[1],
      Math.max(last[1], end),
      result,
      times
    );

    known.forEach(([index, time]) => times.set(index, time));
  }

  times.forEach((time, index) => {
    result[index].start = time;
  });

  return result;
}

/**
 * Точность синхронизации:
 * - `exact` — строки LRC совпали с текстом Genius, тайминги настоящие;
 * - `aligned` — тексты расходятся, но тайминги подобраны по смещению;
 * - `estimate` — точных данных нет, время распределено по длительности.
 */
export type SyncQuality = "exact" | "aligned" | "estimate";

export interface TimedLyrics {
  lines: LyricsLine[];
  quality: SyncQuality;
}

/** Строки считаются одинаковыми, если совпадают или одна входит в другую. */
function sameLine(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length > 4 && b.includes(a)) return true;
  if (b.length > 4 && a.includes(b)) return true;
  return false;
}

/**
 * Совмещает LRC со строками Genius по постоянному смещению.
 *
 * Нужен, когда тексты отличаются (перевод, другая разбивка на строки), а
 * тайминги у LRC настоящие: без такого выравнивания мы их теряли и
 * оценивали время по длительности трека.
 */
function alignByOffset(
  lines: LyricsLine[],
  lrcLines: LrcLine[]
): { map: Map<number, number>; matches: number } {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.isBlank && !line.isSection);

  if (candidates.length === 0 || lrcLines.length === 0) {
    return { map: new Map(), matches: 0 };
  }

  const lrcText = lrcLines.map((entry) => normalizeLine(entry.text));
  const geniusText = candidates.map(({ line }) => normalizeLine(line.text));

  let best: { map: Map<number, number>; matches: number } = {
    map: new Map(),
    matches: 0,
  };

  // 1. Ровно тот же порядок строк, но со сдвигом на несколько строк.
  for (let offset = -4; offset <= 4; offset++) {
    const map = new Map<number, number>();
    let matches = 0;

    for (let i = 0; i < geniusText.length; i++) {
      const j = i + offset;
      if (j < 0 || j >= lrcText.length) continue;
      if (!sameLine(geniusText[i], lrcText[j])) continue;

      map.set(candidates[i].index, lrcLines[j].time);
      matches += 1;
    }

    if (matches > best.matches) best = { map, matches };
  }

  // 2. Пропорциональное совмещение: строк в LRC может быть больше или меньше.
  const ratio = lrcLines.length / candidates.length;
  if (Math.abs(ratio - 1) > 0.15) {
    const map = new Map<number, number>();
    let matches = 0;

    for (let i = 0; i < geniusText.length; i++) {
      const j = Math.min(lrcText.length - 1, Math.round(i * ratio));
      if (j < 0) continue;
      if (!sameLine(geniusText[i], lrcText[j])) continue;

      map.set(candidates[i].index, lrcLines[j].time);
      matches += 1;
    }

    if (matches > best.matches) best = { map, matches };
  }

  return best;
}

/**
 * Главная функция: plain text + (необязательный) LRC + длительность.
 *
 * LRC используется, если с ним совпала хотя бы половина строк, — иначе
 * лучше честная равномерная раскладка, чем чужие тайминги. Если точных
 * совпадений мало, но структура строк похожа, тайминги всё равно подбираются
 * по смещению: они настоящие, просто текст немного другой.
 */
export function buildTimedLyricsDetailed(
  lyrics: string,
  duration: number,
  lrc?: string | null
): TimedLyrics {
  const lines = parseLyrics(lyrics);
  const sung = sungIndices(lines);

  if (lrc && sung.length > 0) {
    const lrcLines = parseLrc(lrc);
    const mapped = alignLrc(lines, lrcLines);

    if (mapped.size >= Math.max(3, sung.length * 0.4)) {
      return { lines: fillTimings(lines, mapped, duration), quality: "exact" };
    }

    // Точных совпадений мало — пробуем подобрать тайминги по смещению.
    const aligned = alignByOffset(lines, lrcLines);
    const threshold = Math.max(2, Math.round(sung.length * 0.15));

    if (aligned.matches >= threshold) {
      return {
        lines: fillTimings(lines, aligned.map, duration),
        quality: "aligned",
      };
    }
  }

  return { lines: fillTimings(lines, new Map(), duration), quality: "estimate" };
}

/** Только строки — для обратной совместимости. */
export function buildTimedLyrics(
  lyrics: string,
  duration: number,
  lrc?: string | null
): LyricsLine[] {
  return buildTimedLyricsDetailed(lyrics, duration, lrc).lines;
}

/** Индекс строки, которая звучит в момент time. */
export function findActiveLine(lines: LyricsLine[], time: number): number {
  let active = -1;

  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start;
    if (start === null) continue;
    if (start <= time) active = i;
    else break;
  }

  return active;
}

/**
 * Доля пройденного времени внутри строки (0..1).
 * Нужна для посимвольной заливки текста: она идёт ровно по звуку.
 */
export function lineProgress(lines: LyricsLine[], index: number, time: number): number {
  if (index < 0 || index >= lines.length) return 0;

  const line = lines[index];
  if (line.start === null) return 0;

  let end: number | null = null;
  for (let i = index + 1; i < lines.length; i++) {
    const start = lines[i].start;
    if (start !== null && start > line.start) {
      end = start;
      break;
    }
  }

  // У последней строки явного конца нет — считаем её ровно четыре секунды.
  const span = end !== null ? end - line.start : 4;
  if (span <= 0) return 1;

  return Math.min(1, Math.max(0, (time - line.start) / span));
}

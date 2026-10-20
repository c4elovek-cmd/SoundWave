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
  const result = new Map<number, number>();
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.isBlank && !line.isSection);

  let cursor = 0;

  for (const lrcLine of lrcLines) {
    const target = normalizeLine(lrcLine.text);
    if (!target) continue;

    let found = -1;

    // Ищем в пределах следующих строк: LRC может пропускать повторы.
    for (let i = cursor; i < Math.min(candidates.length, cursor + 12); i++) {
      const candidate = candidates[i];
      if (normalizeLine(candidate.line.text) === target) {
        found = i;
        break;
      }
    }

    // Иногда LRC режет длинную строку на части — допускаем вхождение.
    if (found === -1) {
      for (let i = cursor; i < Math.min(candidates.length, cursor + 12); i++) {
        const candidate = candidates[i];
        const normalized = normalizeLine(candidate.line.text);
        if (
          normalized.length > 4 &&
          target.length > 4 &&
          (normalized.includes(target) || target.includes(normalized))
        ) {
          found = i;
          break;
        }
      }
    }

    if (found !== -1) {
      result.set(candidates[found].index, lrcLine.time);
      cursor = found + 1;
    }
  }

  return result;
}

/** Равномерно распределяет строки между двумя моментами с учётом их длины. */
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

  let acc = 0;
  indices.forEach((index, i) => {
    times.set(index, from + (span * acc) / total);
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
 * Главная функция: plain text + (необязательный) LRC + длительность.
 * LRC используется, только если с ним совпала хотя бы половина строк —
 * иначе лучше честная равномерная раскладка, чем чужие тайминги.
 */
export function buildTimedLyrics(
  lyrics: string,
  duration: number,
  lrc?: string | null
): LyricsLine[] {
  const lines = parseLyrics(lyrics);
  const sung = sungIndices(lines);

  if (lrc && sung.length > 0) {
    const lrcLines = parseLrc(lrc);
    const mapped = alignLrc(lines, lrcLines);

    if (mapped.size >= Math.max(3, sung.length * 0.4)) {
      return fillTimings(lines, mapped, duration);
    }
  }

  return fillTimings(lines, new Map(), duration);
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

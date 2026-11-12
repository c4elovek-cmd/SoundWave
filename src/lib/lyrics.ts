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
  /** Конец строки из LRC (если файл его задаёт), секунды. */
  end?: number | null;
  /**
   * Точные пословные тайминги (секунды) — из Enhanced LRC или
   * нормализованной модели бэкенда. Есть только у строк, совпавших
   * со строкой источника: заливка караоке идёт по настоящим границам
   * слов, а не по оценке длины.
   */
  words?: LrcWord[];
}

/** Слово с настоящим временем из расширенного LRC. */
export interface LrcWord {
  text: string;
  /** Абсолютное время начала слова в песне, секунды. */
  start: number;
  /** Абсолютное время конца слова в песне, секунды. */
  end: number;
}

export interface LrcLine {
  time: number;
  text: string;
  /** Конец строки, если его задаёт следующая метка времени. */
  end?: number;
  /** Пословные тайминги из Enhanced LRC (метки <mm:ss.xx>). */
  words?: LrcWord[];
}

/** Слово из нормализованной модели бэкенда (`wordSyncedLyrics`). */
export interface KaraokeModelWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Строка из нормализованной модели бэкенда. */
export interface KaraokeModelLine {
  startMs: number;
  endMs: number;
  background?: boolean;
  words: KaraokeModelWord[];
}

/** Нормализованная модель караоке: `{syncType, lines}` от Tauri-бэкенда. */
export interface KaraokeModel {
  syncType: "word" | "syllable" | "line" | "plain";
  lines: KaraokeModelLine[];
}

/**
 * Разбирает JSON слово-таймингов бэкенда (`wordSyncedLyrics`).
 *
 * Бэкенд нормализует TTML/QRC/YRC/Enhanced LRC в единую модель — здесь она
 * превращается в `LrcLine` с готовыми пословными таймингами, чтобы караоке
 * красило слова по точным границам из источника, а не по эвристике букв.
 */
export function parseKaraokeModel(json: string): LrcLine[] {
  let model: KaraokeModel;
  try {
    model = JSON.parse(json) as KaraokeModel;
  } catch {
    return [];
  }
  if (!Array.isArray(model?.lines)) return [];

  const lines: LrcLine[] = [];
  for (const line of model.lines) {
    if (!Array.isArray(line?.words) || line.words.length === 0) continue;
    const text = line.words.map((w) => w.text).join("").trim();
    if (!text) continue;

    const words: LrcWord[] = [];
    for (const word of line.words) {
      if (!word?.text?.trim()) continue;
      words.push({
        text: word.text,
        start: word.startMs / 1000,
        end: word.endMs / 1000,
      });
    }
    if (words.length === 0) continue;

    lines.push({
      time: line.startMs / 1000,
      end: line.endMs / 1000,
      text,
      words,
    });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

const SECTION_RE = /^\[[^\]]+\]$/;

/** Метки времени строки, пословные метки и глобальный сдвиг [offset:±ms]. */
const LRC_TIME_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_WORD_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const LRC_OFFSET_RE = /\[offset:\s*([+-]?\d+)\s*\]/i;

/** Секунды из частей метки [mm:ss.xx]. */
function stampSeconds(minutes: string, seconds: string, fraction?: string): number {
  const millis = Number((fraction ?? "0").padEnd(3, "0").slice(0, 3)) / 1000;
  return Number(minutes) * 60 + Number(seconds) + millis;
}

/** Пословные тайминги строки Enhanced LRC: <00:12.60>слово <00:13.10>другое. */
function parseWordStamps(body: string, offset: number): LrcWord[] {
  const matches = [...body.matchAll(LRC_WORD_RE)];
  if (matches.length === 0) return [];

  const words: LrcWord[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = stampSeconds(match[1], match[2], match[3]) + offset;
    const from = (match.index ?? 0) + match[0].length;
    const to = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
    const text = body.slice(from, to).trim();
    if (text) words.push({ text, start, end: 0 });
  }

  // Конец слова — начало следующего; у последнего — оценка по длине.
  for (let i = 0; i < words.length; i++) {
    words[i].end =
      i + 1 < words.length
        ? words[i + 1].start
        : words[i].start + Math.max(0.4, words[i].text.length * 0.08);
  }

  return words;
}

/**
 * Проставляет каждой метке конец — начало следующей по времени.
 *
 * Пустые метки («[00:14.12]» без текста) в LRC часто отмечают паузу: строка
 * должна догаснуть в её начале, а не тянуться до следующей поющейся строки.
 */
function assignLrcEnds(lrcLines: LrcLine[]) {
  for (let i = 0; i < lrcLines.length; i++) {
    for (let j = i + 1; j < lrcLines.length; j++) {
      if (lrcLines[j].time > lrcLines[i].time) {
        lrcLines[i].end = lrcLines[j].time;
        break;
      }
    }
  }
}

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

/**
 * Разбирает LRC: несколько меток времени в одной строке, глобальный сдвиг
 * [offset:±ms], пустые метки-паузы и пословные метки Enhanced LRC (<mm:ss.xx>).
 */
export function parseLrc(lrc: string): LrcLine[] {
  const result: LrcLine[] = [];

  // [offset:+500] в спецификации сдвигает текст раньше на указанное время.
  const offsetMatch = lrc.match(LRC_OFFSET_RE);
  const offset = offsetMatch ? -Number(offsetMatch[1]) / 1000 : 0;

  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(LRC_TIME_RE)];
    if (stamps.length === 0) continue;

    const body = raw.replace(LRC_TIME_RE, "");
    const words = parseWordStamps(body, offset);
    // Метки слов из текста убираем: в караоке они не должны быть видны.
    const text = body.replace(LRC_WORD_RE, "").trim();

    for (const stamp of stamps) {
      const time = stampSeconds(stamp[1], stamp[2], stamp[3]) + offset;
      result.push({
        time,
        text,
        ...(words.length > 0 ? { words: words.map((word) => ({ ...word })) } : {}),
      });
    }
  }

  result.sort((a, b) => a.time - b.time);
  // Пустые метки тоже оставляем: по ним видно, где строка догасает.
  assignLrcEnds(result);
  return result;
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
 * Возвращает карту «индекс строки Genius → время начала»; если передан
 * ends, в неё же складываются концы строк из LRC, а в words — точные
 * пословные тайминги совпавшей строки.
 */
export function alignLrc(
  lines: LyricsLine[],
  lrcLines: LrcLine[],
  ends?: Map<number, number>,
  words?: Map<number, LrcWord[]>
): Map<number, number> {
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

  // Конец строки и слова из LRC — по индексу строки Genius: fillTimings
  // читает обе карты именно по нему (раньше концы писались по индексу
  // строки LRC и доставались не тем строкам).
  const takeMatch = (geniusIndex: number, lrcIndex: number) => {
    const entry = lrcLines[lrcIndex];
    if (!entry) return;
    if (ends) {
      const end = entry.end;
      if (end != null && end > entry.time) ends.set(geniusIndex, end);
    }
    if (words && entry.words && entry.words.length > 0) {
      words.set(geniusIndex, entry.words.map((word) => ({ ...word })));
    }
  };

  // Восстанавливаем выравнивание
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.set(candidates[i].index, lrcLines[j].time);
      takeMatch(candidates[i].index, j);
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
      takeMatch(candidates[k].index, index);
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
 * mapped — известные времена из LRC; ends — концы строк из LRC;
 * words — точные пословные тайминги совпавших строк (Enhanced LRC
 * или нормализованная модель бэкенда);
 * промежутки заполняются оценкой.
 */
function fillTimings(
  lines: LyricsLine[],
  mapped: Map<number, number>,
  duration: number,
  ends?: Map<number, number>,
  words?: Map<number, LrcWord[]>
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

  // Концы строк из LRC: заливка гаснет ровно там, где кончилось пение,
  // а не в момент начала следующей строки.
  if (ends) {
    ends.forEach((end, index) => {
      const start = result[index]?.start;
      if (start != null && end > start) result[index].end = end;
    });
  }

  // Точные пословные тайминги: попадают только строкам, совпавшим со
  // строкой источника, — у остальных слов нет, заливка пойдёт по оценке.
  if (words) {
    words.forEach((lineWords, index) => {
      if (result[index] && lineWords.length > 0) {
        result[index].words = lineWords;
      }
    });
  }

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
  lrcLines: LrcLine[],
  ends?: Map<number, number>,
  words?: Map<number, LrcWord[]>
): { map: Map<number, number>; matches: number } {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.isBlank && !line.isSection);

  if (candidates.length === 0 || lrcLines.length === 0) {
    return { map: new Map(), matches: 0 };
  }

  const lrcText = lrcLines.map((entry) => normalizeLine(entry.text));
  const geniusText = candidates.map(({ line }) => normalizeLine(line.text));

  // Конец строки из LRC — как и в основном выравнивании.
  const takeEnd = (lrcIndex: number, time: number, geniusIndex: number) => {
    if (!ends) return;
    const end = lrcLines[lrcIndex]?.end;
    if (end != null && end > time) ends.set(geniusIndex, end);
    if (words) {
      const lineWords = lrcLines[lrcIndex]?.words;
      if (lineWords && lineWords.length > 0) {
        words.set(geniusIndex, lineWords.map((word) => ({ ...word })));
      }
    }
  };

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
      takeEnd(j, lrcLines[j].time, candidates[i].index);
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
      takeEnd(j, lrcLines[j].time, candidates[i].index);
      matches += 1;
    }

    if (matches > best.matches) best = { map, matches };
  }

  return best;
}

/**
 * Калибрует тайминги LRC по длительности трека.
 *
 * Перезалитые (speed up / slowed) или чуть несовпадающие версии дают
 * постоянный множитель: строки постепенно разъезжаются со звуком.
 *
 * Если известна длительность записи, с которой снят LRC, решаем только по
 * ней: у версий с изменённым темпом весь таймлайн сжат или растянут ровно
 * во столько раз. Без неё масштабируем лишь когда последняя метка вылезает
 * за конец трека — это верный признак другой версии. Просто «текст кончился
 * раньше трека» ничего не значит: в финале часто длинный проигрыш.
 */
export function calibrateLrcDuration(
  lrcLines: LrcLine[],
  duration: number,
  sourceDuration?: number | null
): void {
  if (duration <= 0 || lrcLines.length < 8) return;

  const first = lrcLines[0].time;
  const last = lrcLines[lrcLines.length - 1].time;
  const span = last - first;
  // Слишком короткий фрагмент (живой минус, обрезка) — не калибруем.
  if (span < 30) return;

  // Точный масштаб по длительности исходной записи LRCLIB. Если она
  // известна, решение принимаем только по ней и дальше не идём: тайминги
  // относятся именно к этой записи, и «дотягивать» их до конца трека нельзя.
  if (sourceDuration && sourceDuration > 0) {
    const ratio = duration / sourceDuration;
    // Совсем другая длительность — скорее всего, другая версия песни:
    // масштабировать такое опасно. Небольшое расхождение считаем шумом.
    if (ratio >= 0.6 && ratio <= 1.6 && Math.abs(ratio - 1) >= 0.005) {
      for (const line of lrcLines) {
        line.time *= ratio;
        if (line.end != null) line.end *= ratio;
        if (line.words) {
          for (const word of line.words) {
            word.start *= ratio;
            word.end *= ratio;
          }
        }
      }
    }
    return;
  }

  // Без длительности записи остаётся один надёжный признак другой версии:
  // последняя метка вылезает за конец трека. Тянуть весь текст до конца
  // трека нельзя — у песен бывает длинный проигрыш в финале, и тогда
  // строки уезжают тем сильнее, чем ближе к концу. Именно так «что тебя
  // гложет» (метки до 1:51 при треке 2:33) отставало почти на полминуты.
  if (last <= duration + 1) return;

  const expected = Math.max(30, duration - first);
  const ratio = span / expected;
  // Слишком большое расхождение — скорее всего, другая версия песни.
  if (ratio < 0.6 || ratio > 1.6) return;

  const k = expected / span;
  for (const line of lrcLines) {
    line.time = first + (line.time - first) * k;
    if (line.end != null) line.end = first + (line.end - first) * k;
    if (line.words) {
      for (const word of line.words) {
        word.start = first + (word.start - first) * k;
        word.end = first + (word.end - first) * k;
      }
    }
  }
}

/**
 * Главная функция: plain text + (необязательный) LRC + длительность.
 *
 * LRC используется, если с ним совпала хотя бы половина строк, — иначе
 * лучше честная равномерная раскладка, чем чужие тайминги. Если точных
 * совпадений мало, но структура строк похожа, тайминги всё равно подбираются
 * по смещению: они настоящие, просто текст немного другой.
 *
 * `karaokeModel` — JSON `wordSyncedLyrics` от бэкенда: нормализованная
 * модель (TTML/QRC/YRC/Enhanced LRC) с точными таймингами слов. Она
 * предпочтительнее разбора LRC-строки: словные границы там не теряются
 * при конвертации, а караоке красит по настоящим границам слов.
 */
export function buildTimedLyricsDetailed(
  lyrics: string,
  duration: number,
  lrc?: string | null,
  sourceDuration?: number | null,
  karaokeModel?: string | null
): TimedLyrics {
  const lines = parseLyrics(lyrics);
  const sung = sungIndices(lines);

  // Модель слово-таймингов приоритетнее: у неё точные границы слов.
  // Если модель не разобралась — падаем на обычный разбор LRC.
  let lrcLines: LrcLine[] = [];
  if (karaokeModel) {
    lrcLines = parseKaraokeModel(karaokeModel);
  }
  if (lrcLines.length === 0 && lrc) {
    lrcLines = parseLrc(lrc);
  }

  if (lrcLines.length > 0 && sung.length > 0) {
    calibrateLrcDuration(lrcLines, duration, sourceDuration);

    const ends = new Map<number, number>();
    const words = new Map<number, LrcWord[]>();
    const mapped = alignLrc(lines, lrcLines, ends, words);

    if (mapped.size >= Math.max(3, sung.length * 0.4)) {
      return { lines: fillTimings(lines, mapped, duration, ends, words), quality: "exact" };
    }

    // Точных совпадений мало — пробуем подобрать тайминги по смещению.
    const aligned = alignByOffset(lines, lrcLines, ends, words);

    if (aligned.matches >= threshold(sung.length)) {
      return {
        lines: fillTimings(lines, aligned.map, duration, ends, words),
        quality: "aligned",
      };
    }
  }

  return { lines: fillTimings(lines, new Map(), duration), quality: "estimate" };
}

/** Порог «достаточно совпадений» для выравнивания по смещению. */
function threshold(sungCount: number): number {
  return Math.max(2, Math.round(sungCount * 0.15));
}

/** Только строки — для обратной совместимости. */
export function buildTimedLyrics(
  lyrics: string,
  duration: number,
  lrc?: string | null,
  sourceDuration?: number | null
): LyricsLine[] {
  return buildTimedLyricsDetailed(lyrics, duration, lrc, sourceDuration).lines;
}

/**
 * Подавление правила «допевания» после ручного прыжка.
 *
 * Пользователь кликнул по строке — подсветка обязана встать ровно на неё,
 * а не цепляться за предыдущую строку, у которой LRC-конец нахлёстывается
 * на начало выбранной. Флаг живёт полторы секунды: за это время строка
 * пропоётся и правило вернётся к обычной работе.
 */
let holdSuppressedUntil = 0;

export function suppressKaraokeHold(): void {
  holdSuppressedUntil = Date.now() + 1500;
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

  // Допевание: метки LRC идут с нахлёстом, и предыдущая строка реально
  // звучит ещё какое-то время после старта следующей. Пока у неё не
  // горел настоящий конец (из LRC) — держим её активной, заливка
  // продолжает догорать, и переход происходит по окончании пения.
  // Потолок удержания — 2 секунды сверх метки следующей строки: он
  // страхует от кривых таймингов, когда «конец» размазан на всю паузу.
  if (active > 0 && Date.now() >= holdSuppressedUntil) {
    const prev = lines[active - 1];
    const nextStart = lines[active].start ?? 0;

    if (prev.start !== null && prev.end != null && time < Math.min(prev.end, nextStart + 2)) {
      return active - 1;
    }
  }

  return active;
}

/** Когда заканчивается строка: явный конец из LRC, начало следующей или «+4 секунды». */
export function lineEnd(lines: LyricsLine[], index: number): number | null {
  if (index < 0 || index >= lines.length) return null;

  const line = lines[index];
  if (line.start === null) return null;

  // Явный конец из LRC (в том числе метка-пауза) точнее ближайшей оценки.
  if (line.end != null && line.end > line.start) return line.end;

  for (let i = index + 1; i < lines.length; i++) {
    const start = lines[i].start;
    if (start !== null && start > line.start) return start;
  }

  // У последней строки явного конца нет — считаем её ровно четыре секунды.
  return line.start + 4;
}

/**
 * Доля пройденного времени внутри строки (0..1).
 * Нужна для посимвольной заливки текста: она идёт ровно по звуку.
 */
export function lineProgress(lines: LyricsLine[], index: number, time: number): number {
  if (index < 0 || index >= lines.length) return 0;

  const line = lines[index];
  if (line.start === null) return 0;

  const end = lineEnd(lines, index);
  const span = end !== null ? end - line.start : 4;
  if (span <= 0) return 1;

  return Math.min(1, Math.max(0, (time - line.start) / span));
}

/** Слово строки вместе с его долей времени — для заливки по словам. */
export interface KaraokeWord {
  text: string;
  /** Пробел или перенос: рисовать без заливки. */
  space: boolean;
  /** Начало слова внутри строки, 0..1. */
  from: number;
  /** Конец слова внутри строки, 0..1. */
  to: number;
  /** Слоги слова (только для режима «по слогам»). */
  syllables?: { text: string; from: number; to: number }[];
}

/**
 * Гласные — центр слога. Русские и латинские буквы дают слог на каждую
 * гласную; согласные без гласной уходят к предыдущему слогу.
 */
const VOWELS = /[аеёиоуыэюяaeiou]/i;

/**
 * Делит слово на слоги для караоке.
 *
 * Слог — гласная или группа гласных вместе с окружающими согласными. Для
 * одного слога возвращается само слово: делить нечего.
 */
export function splitKaraokeSyllables(word: string): string[] {
  const core = word.match(/[\p{L}\p{N}’']+/u)?.[0];
  if (!core) return [word];

  const chars = Array.from(core);
  const vowels = chars.map((ch) => VOWELS.test(ch));

  // Английские диграфы — одна согласная, а не две: «Breathe» делится как
  // «Brea-the», а не «Breat-he». Иначе латиница режется по русским правилам.
  const DIGRAPHS = new Set(["th", "ch", "sh", "ph", "wh", "ck", "gh", "ng", "qu"]);
  const isCons = (i: number) =>
    /[\p{L}\p{N}]/u.test(chars[i]) && !vowels[i] && chars[i] !== "'" && chars[i] !== "’";

  /** Сколько согласных по «весу» в группе: диграф считается за одну. */
  const groupWeight = (from: number, to: number): number => {
    let weight = 0;
    for (let i = from; i < to; i++) {
      const pair = (chars[i] + (chars[i + 1] ?? "")).toLowerCase();
      if (i + 1 < to && DIGRAPHS.has(pair)) {
        weight += 1;
        i++;
      } else {
        weight += 1;
      }
    }
    return weight;
  };

  const bounds: number[] = [];

  for (let i = 1; i < chars.length; i++) {
    // Граница слога — стык гласной и согласных за ней. Согласные делятся
    // по правилу пропевания: одиночная целиком уходит к следующей гласной
    // («ма-ши-на», «вре-мя»), из группы последняя тоже уходит вперёд,
    // остальные остаются в предыдущем слоге («де-во-чка», «стре-ла»).
    if (!vowels[i - 1] || vowels[i]) continue;

    let end = i;
    while (end < chars.length && isCons(end)) end++;
    // Согласные в конце слова не открывают новый слог — остаются с предыдущим.
    if (end >= chars.length) continue;

    // Немая «e» в конце («Breathe», «one», «shine») не создаёт слог —
    // вторая половина слова сливается с первой. Кириллицы это не касается:
    // там «е» всегда звучит.
    const silentE =
      end === chars.length - 1 &&
      end > 1 &&
      (chars[end] === "e" || chars[end] === "E") &&
      !/[а-яё]/i.test(chars[i - 1]);
    if (silentE) continue;

    const cut = groupWeight(i, end) >= 2 ? end - 1 : i;
    if (cut > 0 && (bounds.length === 0 || cut > bounds[bounds.length - 1])) {
      bounds.push(cut);
    }
  }

  if (bounds.length === 0) return [word];

  const prefix = core.slice(0, word.indexOf(core));
  const suffix = word.slice(word.indexOf(core) + core.length);
  const out: string[] = [];
  let start = 0;
  for (const end of [...bounds, chars.length]) {
    if (end <= start) continue;
    out.push((start === 0 ? prefix : "") + chars.slice(start, end).join(""));
    start = end;
  }
  if (suffix) out[out.length - 1] += suffix;
  return out;
}


/**
 * Делит строку на слова и считает, какую долю времени занимает каждое.
 *
 * Нужно для заливки по словам: длинная фраза переносится на несколько
 * визуальных строк, а один общий градиент на блоке красил бы все эти
 * строки одновременно. Отдельные слова заливаются в порядке чтения, то
 * есть сверху вниз, строка за строкой.
 */
export function splitKaraokeWords(text: string): KaraokeWord[] {
  const parts = text.split(/(\s+)/);
  const total = parts.reduce((sum, part) => sum + part.trim().length, 0);

  if (total === 0) {
    return parts
      .filter((part) => part.length > 0)
      .map((part) => ({ text: part, space: true, from: 0, to: 0 }));
  }

  const result: KaraokeWord[] = [];
  let acc = 0;

  for (const part of parts) {
    if (part.length === 0) continue;

    if (part.trim().length === 0) {
      result.push({ text: part, space: true, from: 0, to: 0 });
      continue;
    }

    const from = acc / total;
    acc += part.length;
    result.push({ text: part, space: false, from, to: acc / total });
  }

  return result;
}

/**
 * Подставляет в разбивку строки настоящие границы слов.
 *
 * `timedWords` — точные тайминги слов совпавшей строки источника
 * (`wordSyncedLyrics`). Слова сопоставляются по тексту, доля каждого —
 * его доля от общего времени строки. Слова без тайминга деляят остаток
 * поровну, чтобы заливка не «спотыкалась».
 */
export function withExactWordTimes(
  words: KaraokeWord[],
  timedWords: LrcWord[]
): KaraokeWord[] {
  if (timedWords.length === 0) return words;

  const known = new Map<string, LrcWord[]>();
  for (const timed of timedWords) {
    const key = timed.text.trim().toLowerCase();
    if (!key) continue;
    const list = known.get(key) ?? [];
    list.push(timed);
    known.set(key, list);
  }

  // Всего два прохода: сначала разбираем очередь известных слов, затем
  // назначаем время тем, у кого таймингов нет.
  const pool = new Map(known.entries());
  const first = timedWords[0];
  const last = timedWords[timedWords.length - 1];
  const span = Math.max(0.001, (last.end || last.start) - first.start);
  const withTime: { word: KaraokeWord; start: number; end: number }[] = [];

  for (const word of words) {
    if (word.space) continue;
    const key = word.text.trim().toLowerCase();
    const queue = pool.get(key);
    if (!queue || queue.length === 0) continue;
    pool.set(key, (queue as LrcWord[]).slice(1));
    const timed = queue[0];
    withTime.push({ word, start: timed.start, end: timed.end || timed.start + 0.2 });
  }

  if (withTime.length === 0) return words;

  return words.map((word) => {
    const hit = withTime.find((item) => item.word === word);
    if (!hit) return word;
    const from = Math.max(0, (hit.start - first.start) / span);
    const to = Math.max(from, Math.min(1, (hit.end - first.start) / span));
    return { ...word, from, to };
  });
}

/**
 * Добавляет каждому слову его слоги с долями времени внутри слова.
 *
 * Время слога внутри слова делится по длине слога: приближение, но
 * точнее, чем «всё слово сразу». Для режима «по буквам» не вызывается —
 * там заливка идёт внутри слова плавно.
 */
export function splitKaraokeIntoSyllables(words: KaraokeWord[]): KaraokeWord[] {
  return words.map((word) => {
    if (word.space) return word;

    const parts = splitKaraokeSyllables(word.text);
    if (parts.length <= 1) return word;

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const span = word.to - word.from;
    let acc = 0;

    const syllables = parts.map((part) => {
      const from = word.from + (span * acc) / total;
      acc += part.length;
      return { text: part, from, to: word.from + (span * acc) / total };
    });

    return { ...word, syllables };
  });
}

// ---------------------------------------------------------------------------
// Lyricsfile — новый открытый формат LRCLIB (YAML) с концами строк и
// опциональными пословными таймингами. Поле lyricsfile уже отдаётся в API
// (/api/get, /api/search); пока блоки words: почти всегда пустые, поэтому
// парсер заложен на будущее — включится, когда данные появятся.
// ---------------------------------------------------------------------------

/** Строка Lyricsfile: текст, границы и (опционально) пословные тайминги. */
export interface LyricsFileLine {
  text: string;
  /** Начало строки, секунды. */
  start: number;
  /** Конец строки, секунды. */
  end: number | null;
  /** Слова с настоящим временем, если выложены. */
  words: { text: string; start: number; end: number }[];
}

const MS_RE = /^\s*(\d+)\s*$/;

/**
 * Разбирает lyricsfile (YAML) без тяжёлой зависимости: нужны только строки
 * вида «- text: …», «start_ms: 12000» и вложенный «words:».
 * Пустые строки («text: ''») — это метки паузы; они сохраняются с пустым
 * текстом, чтобы знали, где строки догасают.
 */
export function parseLyricsfile(source: string): LyricsFileLine[] {
  const lines: LyricsFileLine[] = [];
  if (!source) return lines;

  const rows = source.split("\n");
  let current: LyricsFileLine | null = null;
  let inWords = false;
  let word: { text: string; start: number } | null = null;

  const flushWord = () => {
    if (word && current && word.start > 0) {
      // Слово без end_ms: закрываем началом следующего события или строкой.
      current.words.push({ text: word.text, start: word.start, end: 0 });
    }
    word = null;
  };

  const flushLine = () => {
    flushWord();
    if (current) {
      const pending = current.words.filter((w) => !w.end);
      for (const w of pending) w.end = current.end ?? w.start + 1;
      lines.push(current);
    }
    current = null;
    inWords = false;
  };

  for (const raw of rows) {
    // Слова внутри words: тоже начинаются с «- text:», отделяем по флагу.
    if (inWords) {
      const item = raw.match(/^\s*- text:\s*(.*)$/);
      if (item) {
        flushWord();
        word = { text: decodeYamlScalar(item[1]), start: 0 };
        continue;
      }
    }

    // Новый элемент списка строк.
    const lineMatch = raw.match(/^\s*- (?:text: )?(.*)$/);
    if (lineMatch && !inWords) {
      flushLine();
      current = {
        text: decodeYamlScalar(lineMatch[1]),
        start: 0,
        end: null,
        words: [],
      };
      continue;
    }

    if (!current) continue;

    const keyMatch = raw.match(/^\s*([a-z_]+)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, rawValue] = keyMatch;

    if (key === "text" && inWords) {
      // Слова внутри words:
      flushWord();
      word = { text: decodeYamlScalar(rawValue), start: 0 };
      continue;
    }

    if (key === "start_ms") {
      const ms = MS_RE.exec(rawValue)?.[1];
      if (ms) {
        if (inWords && word) word.start = Number(ms) / 1000;
        else {
          current.start = Number(ms) / 1000;
          inWords = false;
        }
      }
      continue;
    }

    if (key === "end_ms") {
      const ms = MS_RE.exec(rawValue)?.[1];
      if (ms) {
        if (inWords && word) {
          // Слова в words: идут в порядке text → start_ms → end_ms;
          // слово готово к переносу в current.
          current.words.push({
            text: word.text,
            start: word.start,
            end: Number(ms) / 1000,
          });
          word = null;
        } else {
          current.end = Number(ms) / 1000;
        }
      }
      continue;
    }

    if (key === "words") {
      // Значение может быть пустым («words: []») или содержать список.
      if (rawValue.trim() === "[]") inWords = false;
      else inWords = true;
      continue;
    }

    // Прочие ключи (metadata, plain) игнорируем.
  }
  flushLine();

  return lines;
}

/** Убирает кавычки YAML-скаляра. */
function decodeYamlScalar(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

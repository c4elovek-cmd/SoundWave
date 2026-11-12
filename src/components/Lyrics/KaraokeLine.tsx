import { memo, useMemo } from "react";
import {
  LrcWord,
  splitKaraokeIntoSyllables,
  splitKaraokeWords,
  withExactWordTimes,
} from "../../lib/lyrics";

interface KaraokeLineProps {
  text: string;
  /** Секции вроде [Припев] не заливаются. */
  section?: boolean;
  /** По слогам слово рисуется как набор слогов со своими отрезками времени. */
  syllableMode?: boolean;
  /**
   * Точные пословные тайминги строки (секунды) — из нормализованной
   * модели бэкенда. Когда есть, доли заливки считаются из настоящих
   * границ слов, а не из оценки по длине.
   */
  timedWords?: LrcWord[];
}

/**
 * Строка караоке с заливкой по словам.
 *
 * Общий градиент на блоке (`background-clip: text`) красит всю фразу
 * сразу: если она переносится на две-три визуальные строки, они
 * загораются одновременно, хотя поются по очереди. Здесь каждое слово
 * получает свою долю времени, а порядок обхода совпадает с порядком
 * чтения — поэтому заливка идёт сверху вниз, строка за строкой.
 *
 * Сама доля выставляется не через React-состояние (это перерисовывало бы
 * компонент 60 раз в секунду), а напрямую в DOM из цикла анимации —
 * функцией {@link paintKaraokeWords}.
 */
function KaraokeLineBase({
  text,
  section,
  syllableMode,
  timedWords,
}: KaraokeLineProps) {
  const words = useMemo(() => {
    const split = splitKaraokeWords(text);
    if (timedWords && timedWords.length > 0) {
      return withExactWordTimes(split, timedWords);
    }
    return syllableMode ? splitKaraokeIntoSyllables(split) : split;
  }, [text, syllableMode, timedWords]);

  if (section) {
    return <>{text}</>;
  }

  return (
    <>
      {words.map((word, index) => {
        if (word.space) return word.text;

        return (
          <span
            key={index}
            className="karaoke-word"
            data-from={word.from}
            data-to={word.to}
          >
            {word.syllables
              ? word.syllables.map((syllable, syllableIndex) => (
                  <span
                    // Слог красится внутри своего отрезка, поэтому ему
                    // нужны собственные метки времени.
                    key={syllableIndex}
                    className="karaoke-syllable"
                    data-from={syllable.from}
                    data-to={syllable.to}
                  >
                    {syllable.text}
                  </span>
                ))
              : word.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * Красит слова активной строки по текущему прогрессу.
 *
 * `progress` — доля пройденного времени строки (0..1). Каждое слово
 * заливается внутри своего отрезка времени, поэтому заливка идёт
 * последовательно, а не всей фразой сразу.
 *
 * Активная строка и её слова кэшируются: искать их в DOM каждый кадр
 * (60 раз в секунду) незачем. Кэш сбрасывается, когда React заменяет
 * элемент строки или снимает с него класс активности.
 */
interface PaintCache {
  active: HTMLElement;
  nodes: HTMLElement[];
}

const paintCache = new WeakMap<HTMLElement, PaintCache>();

/**
 * Красит слова активной строки по текущему прогрессу.
 *
 * `progress` — доля пройденного времени строки (0..1). Каждое слово
 * заливается внутри своего отрезка времени, поэтому заливка идёт
 * последовательно, а не всей фразой сразу.
 *
 * Активная строка и её слова кэшируются: искать их в DOM каждый кадр
 * (60 раз в секунду) незачем. Кэш сбрасывается, когда React заменяет
 * элементы строки или снимает с неё класс активности.
 */
export function paintKaraokeWords(
  root: HTMLElement | null,
  progress: number,
  mode: "letters" | "syllables" | "words" = "letters"
): void {
  if (!root) return;

  let cache = paintCache.get(root);

  const alive =
    cache !== undefined &&
    cache.active.isConnected &&
    cache.active.classList.contains("karaoke-active") &&
    cache.nodes.every((node) => node.isConnected);

  if (!alive) {
    const active = root.querySelector<HTMLElement>(".karaoke-active");
    if (!active) return;

    cache = {
      active,
      nodes: Array.from(active.querySelectorAll<HTMLElement>(".karaoke-word")),
    };
    paintCache.set(root, cache);
  }

  if (!cache) return;

  for (const word of cache.nodes) {
    const from = Number(word.dataset.from ?? 0);
    const to = Number(word.dataset.to ?? 1);
    const span = Math.max(0.0001, to - from);

    // По словам: слово загорается целиком, когда до него дошла очередь,
    // и остаётся подсвеченным до конца строки.
    // По слогам: слово идёт целиком, а внутри него заливаются слоги —
    // ближе к тому, как слово поётся, но без оценки по каждой букве.
    // По буквам: заливка идёт внутри слова плавно — точность приблизительная,
    // потому что время букв оценивается по длине слова.
    if (mode === "syllables") {
      word.style.setProperty("--word-fill", "0%");
      const local = Math.min(1, Math.max(0, (progress - from) / span));
      word.classList.toggle("karaoke-word-on", local > 0);

      for (const syllable of word.querySelectorAll<HTMLElement>(".karaoke-syllable")) {
        const sFrom = Number(syllable.dataset.from ?? 0);
        const sTo = Number(syllable.dataset.to ?? 1);
        const sSpan = Math.max(0.0001, sTo - sFrom);
        const sLocal = Math.min(1, Math.max(0, (progress - sFrom) / sSpan));
        syllable.style.setProperty("--syllable-fill", `${(sLocal * 100).toFixed(1)}%`);
      }
      continue;
    }

    const local =
      mode === "words"
        ? progress >= from
          ? 1
          : 0
        : Math.min(1, Math.max(0, (progress - from) / span));

    word.style.setProperty("--word-fill", `${(local * 100).toFixed(1)}%`);
  }
}

export const KaraokeLine = memo(KaraokeLineBase);
export default KaraokeLine;

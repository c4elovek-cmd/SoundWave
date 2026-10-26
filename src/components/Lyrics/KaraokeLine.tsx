import { memo, useMemo } from "react";
import { splitKaraokeWords } from "../../lib/lyrics";

interface KaraokeLineProps {
  text: string;
  /** Секции вроде [Припев] не заливаются. */
  section?: boolean;
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
function KaraokeLineBase({ text, section }: KaraokeLineProps) {
  const words = useMemo(() => splitKaraokeWords(text), [text]);

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
            {word.text}
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
export function paintKaraokeWords(root: HTMLElement | null, progress: number): void {
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
    const local = Math.min(1, Math.max(0, (progress - from) / span));
    word.style.setProperty("--word-fill", `${(local * 100).toFixed(1)}%`);
  }
}

export const KaraokeLine = memo(KaraokeLineBase);
export default KaraokeLine;

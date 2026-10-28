import { useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/playerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { bindVisualizerAudio, readVisualizerSpectrum } from "../../lib/visualizer";
import "./VisualizerCanvas.css";

/**
 * Фоновая отрисовка звука в панели плеера.
 *
 * Слушает живой спектр через Web Audio и рисует один из стилей:
 * столбики, «зеркало» (столбики от центра) или волну. Переживает
 * смену трека: при каждом новом элементе <audio> привязывает
 * его к анализатору заново.
 */
export default function VisualizerCanvas() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const audio = usePlayerStore((s) => s.audio);
  const enabled = useSettingsStore((s) => s.visualizerEnabled);
  const style = useSettingsStore((s) => s.visualizerStyle);
  const height = useSettingsStore((s) => s.visualizerHeight);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Отрисовка не перезапускается при паузе/воспроизведении — читаем флаг здесь.
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  // Привязка текущего аудио к анализатору: и при смене трека,
  // и при включении визуализатора во время воспроизведения.
  useEffect(() => {
    if (!enabled) return;

    bindVisualizerAudio(audio);

    // У hls.js поток появляется как blob: не сразу — пробуем ещё раз
    // на каждом событии готовности элемента.
    const retry = () => bindVisualizerAudio(audio);
    audio?.addEventListener("loadedmetadata", retry);
    audio?.addEventListener("canplay", retry);
    audio?.addEventListener("playing", retry);

    return () => {
      audio?.removeEventListener("loadedmetadata", retry);
      audio?.removeEventListener("canplay", retry);
      audio?.removeEventListener("playing", retry);
    };
  }, [audio, enabled, isPlaying, currentTrack?.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let phase = 0;
    // Сглаженные значения столбиков: без этого картинка дёргается.
    let bars: number[] = [];
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const { width, height: h } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      bars = [];
    };

    resize();
    // Размер меняется при сворачивании сайдбара и ресайзе окна.
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = () => {
      raf = requestAnimationFrame(draw);

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Canvas не понимает var(): читаем вычисленный цвет темы.
      const cs = getComputedStyle(canvas);
      const color =
        cs.getPropertyValue("--visualizer-color").trim() ||
        cs.getPropertyValue("--accent").trim() ||
        "#6c8cff";

      const spectrum = readVisualizerSpectrum();

      if (!spectrum) {
        // Данных нет: на паузе — спокойная заглушка, во время игры —
        // тонкая линия, чтобы не выдавать выдуманный спектр за настоящий.
        if (playingRef.current) {
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = color;
          ctx.fillRect(0, h / 2 - 1, w, 2);
          ctx.globalAlpha = 1;
        } else {
          phase += 0.5;
          ctx.globalAlpha = 0.22;
          const idle = Array.from(
            { length: 48 },
            (_, i) => 0.06 + Math.abs(Math.sin(phase / 45 + i / 7)) * 0.14
          );
          drawBars(ctx, w, h, idle, color, style);
          ctx.globalAlpha = 1;
        }
        return;
      }

      phase += 1;

      // Верх спектра почти всегда тишина — берём нижние ~75%.
      const usable = Math.floor(spectrum.length * 0.75);
      const count = Math.min(64, Math.max(24, Math.floor(w / (12 * dpr))));

      const target: number[] = [];
      for (let i = 0; i < count; i++) {
        // Логарифмическое распределение: басы не съедают всю ширину.
        const from = Math.floor(Math.pow(i / count, 1.6) * usable);
        const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / count, 1.6) * usable));
        let peak = 0;
        for (let j = from; j < to && j < usable; j++) peak = Math.max(peak, spectrum[j]);
        target.push((peak / 255) ** 1.15);
      }

      if (bars.length !== count) bars = target.slice();
      for (let i = 0; i < count; i++) {
        // Быстрый подъём, медленный спад — живо, но без дрожания.
        bars[i] += (target[i] - bars[i]) * (target[i] > bars[i] ? 0.5 : 0.16);
      }

      drawBars(ctx, w, h, bars, color, style);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [enabled, style]);

  if (!enabled || !currentTrack) return null;

  return (
    <canvas
      ref={canvasRef}
      className="visualizer-canvas"
      style={{ height }}
      aria-hidden="true"
    />
  );
}

/** Отрисовка спектра выбранным стилем. */
function drawBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bars: number[],
  color: string,
  style: "bars" | "mirror" | "wave"
) {
  const gap = Math.max(2, w * 0.002);
  const barW = Math.max(1, (w - gap * (bars.length + 1)) / bars.length);
  const pad = h * 0.1;
  const maxH = h - pad * 2;

  // К низу цвет затухает — столбики не спорят с подписями трека.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color);
  grad.addColorStop(1, withAlpha(ctx, color, 0.15));

  const fill: string | CanvasGradient = style === "wave" ? color : grad;
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;

  if (style === "wave") {
    // Плавная линия по верхушкам — спокойный режим.
    ctx.beginPath();
    for (let i = 0; i < bars.length; i++) {
      const x = gap + i * (barW + gap) + barW / 2;
      const y = h / 2 - (bars[i] - 0.5) * maxH * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = Math.max(2, h * 0.05);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    return;
  }

  for (let i = 0; i < bars.length; i++) {
    const barH = Math.max(h * 0.03, bars[i] * maxH);
    const x = gap + i * (barW + gap);
    const y = style === "mirror" ? h / 2 - barH / 2 : h - barH - pad * 0.5;

    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 3 * (w / 1000) + 1.5));
    ctx.fill();
  }
}

/** Переводит CSS-цвет в rgba с заданной прозрачностью. */
function withAlpha(ctx: CanvasRenderingContext2D, color: string, alpha: number): string {
  // #rgb / #rrggbb — самый частый случай у тем.
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let body = hex[1];
    if (body.length === 3) body = body.split("").map((c) => c + c).join("");
    const r = parseInt(body.slice(0, 2), 16);
    const g = parseInt(body.slice(2, 4), 16);
    const b = parseInt(body.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgb = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;

  // Прочее (например, oklch) — берём как есть: ctx поймёт сам.
  void ctx;
  return color;
}

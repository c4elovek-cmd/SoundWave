import { useSettingsStore } from "../stores/settingsStore";

/**
 * Аудио-визуализатор: направляет звук плеера через Web Audio API
 * и отдаёт спектр частот для отрисовки.
 *
 * Элемент <audio> маршрутизируется через AnalyserNode: МОЖНО создать
 * MediaElementAudioSourceNode для одного элемента только один раз,
 * поэтому прошедшие элементы запоминаются в WeakSet.
 */

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
/** Элемент, звук которого сейчас идёт через контекст. */
let connected: HTMLAudioElement | null = null;
/** Элементы, для которых источник уже создан — повтор нельзя. */
const everBound = new WeakSet<HTMLAudioElement>();
let freqData: Uint8Array | null = null;

/**
 * Подключает (или отключает) текущий аудио-элемент плеера.
 * Игнорируется, если визуализатор выключен.
 *
 * Через Web Audio пропускаем только «свои» источники: тот, что играет
 * через MediaSource (`blob:` — так работает hls.js), или помеченный
 * как CORS-совместимый. Кросс-доменный поток без CORS при таком
 * маршруте звучал бы тишиной — его пропускаем, визуализатор покажет
 * спокойную заглушку вместо спектра.
 */
export function bindVisualizerAudio(audio: HTMLAudioElement | null): void {
  connected = null;

  if (!audio || !useSettingsStore.getState().visualizerEnabled) return;
  if (!isSafeToRoute(audio)) return;

  try {
    audioCtx ??= new AudioContext();
    // Звук уже играет: контекст мог оказаться в suspended из-за политики
    // автоплея — возобновляем, иначе после подключения пропадёт звук.
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => undefined);

    analyser ??= (() => {
      const node = audioCtx!.createAnalyser();
      node.fftSize = 256;
      node.smoothingTimeConstant = 0.82;
      node.connect(audioCtx!.destination);
      return node;
    })();

    if (!everBound.has(audio)) {
      const source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      everBound.add(audio);
    }

    connected = audio;
  } catch (e) {
    console.warn("Аудио-визуализатор недоступен:", e);
  }
}

/** Источник безопасно пропускать через Web Audio без риска тишины. */
function isSafeToRoute(audio: HTMLAudioElement): boolean {
  const src = audio.currentSrc || audio.src || "";
  return src.startsWith("blob:") || audio.crossOrigin === "anonymous";
}

/**
 * Текущий спектр частот (0–255), либо null — слушать нечего
 * (выключен визуализатор, нет трека или контекст не поднялся).
 */
export function readVisualizerSpectrum(): Uint8Array | null {
  if (!analyser || !connected || !useSettingsStore.getState().visualizerEnabled) {
    return null;
  }

  if (freqData?.length !== analyser.frequencyBinCount) {
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  analyser.getByteFrequencyData(freqData);
  return freqData;
}

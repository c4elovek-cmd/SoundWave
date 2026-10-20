import { create } from "zustand";

export type Density = "comfortable" | "compact";
export type RepeatSetting = "off" | "all" | "one";

export interface CustomFontInfo {
  id: string;
  name: string;
  family: string;
  file: string;
  mime: string;
  dataUrl: string;
}

export interface SettingsValues {
  // Внешний вид
  animations: boolean;
  density: Density;
  sidebarCollapsed: boolean;

  // Текст и караоке
  lyricsFont: string;
  lyricsFontSize: number;
  karaokeFontSize: number;
  karaokeEnabled: boolean;
  exactSync: boolean;

  // Плеер
  volume: number;
  shuffleOnStart: boolean;
  repeatOnStart: RepeatSetting;

  // Discord
  discordEnabled: boolean;
  discordClientId: string;
  discordLargeImage: string;

  // Локальный API для агентов
  agentApiEnabled: boolean;
  agentApiPort: number;
}

const DEFAULTS: SettingsValues = {
  animations: true,
  density: "comfortable",
  sidebarCollapsed: false,

  lyricsFont: "sans",
  lyricsFontSize: 14,
  karaokeFontSize: 56,
  karaokeEnabled: false,
  exactSync: true,

  volume: 0.8,
  shuffleOnStart: false,
  repeatOnStart: "off",

  discordEnabled: false,
  discordClientId: "",
  discordLargeImage: "",

  agentApiEnabled: true,
  agentApiPort: 4783,
};

const STORAGE_KEY = "sw-settings";

// Старые настройки текста лежали в отдельных ключах — переносим их.
const LEGACY_FONT_KEY = "sw-lyrics-font";
const LEGACY_SIZE_KEY = "sw-lyrics-font-size";
const LEGACY_KARAOKE_KEY = "sw-lyrics-karaoke";

function loadSettings(): SettingsValues {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SettingsValues>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      // Повреждённый JSON — начинаем с настроек по умолчанию.
    }
  }

  const legacy: Partial<SettingsValues> = {};

  const font = localStorage.getItem(LEGACY_FONT_KEY);
  if (font) legacy.lyricsFont = font;

  const size = Number(localStorage.getItem(LEGACY_SIZE_KEY));
  if (Number.isFinite(size) && size >= 12 && size <= 22) legacy.lyricsFontSize = size;

  const karaoke = localStorage.getItem(LEGACY_KARAOKE_KEY);
  if (karaoke !== null) legacy.karaokeEnabled = karaoke === "1";

  return { ...DEFAULTS, ...legacy };
}

interface SettingsState extends SettingsValues {
  /** Список своих шрифтов — подгружается из main-процесса, не сохраняется здесь. */
  customFonts: CustomFontInfo[];
  set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  setCustomFonts: (fonts: CustomFontInfo[]) => void;
  reset: () => void;
}

const PERSISTED_KEYS = Object.keys(DEFAULTS) as (keyof SettingsValues)[];

function persist(values: SettingsValues): void {
  const snapshot: Record<string, unknown> = {};

  PERSISTED_KEYS.forEach((key) => {
    snapshot[key] = values[key];
  });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Не страшно: настройки просто не переживут перезапуск.
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),
  customFonts: [],

  set: (key, value) => {
    set({ [key]: value } as unknown as Partial<SettingsState>);
    const state = get();
    persist({
      animations: state.animations,
      density: state.density,
      sidebarCollapsed: state.sidebarCollapsed,
      lyricsFont: state.lyricsFont,
      lyricsFontSize: state.lyricsFontSize,
      karaokeFontSize: state.karaokeFontSize,
      karaokeEnabled: state.karaokeEnabled,
      exactSync: state.exactSync,
      volume: state.volume,
      shuffleOnStart: state.shuffleOnStart,
      repeatOnStart: state.repeatOnStart,
      discordEnabled: state.discordEnabled,
      discordClientId: state.discordClientId,
      discordLargeImage: state.discordLargeImage,
      agentApiEnabled: state.agentApiEnabled,
      agentApiPort: state.agentApiPort,
    });
  },

  setCustomFonts: (customFonts) => set({ customFonts }),

  reset: () => {
    set({ ...DEFAULTS });
    persist(DEFAULTS);
  },
}));

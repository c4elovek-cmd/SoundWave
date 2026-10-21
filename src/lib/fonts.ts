// Шрифты текста песни: встроенные и свои.
//
// Свои шрифты лежат файлами в папке данных приложения, main отдаёт их как
// data-URL, а renderer регистрирует через FontFace и добавляет в document.fonts.

import { CustomFontInfo } from "../stores/settingsStore";

export interface BuiltinFont {
  id: string;
  label: string;
  stack: string;
}

export const BUILTIN_FONTS: BuiltinFont[] = [
  { id: "sans", label: "Inter", stack: '"Inter", "Segoe UI", Arial, sans-serif' },
  { id: "serif", label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  { id: "mono", label: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  { id: "rounded", label: "Trebuchet", stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
];

export const CUSTOM_FONT_PREFIX = "custom:";

/** Семейство своих шрифтов: несколько начертаний одного шрифта. */
export interface CustomFontFamily {
  /** CSS-семейство, напр. SWFontTurretRoad */
  family: string;
  /** Название для интерфейса, напр. Turret Road */
  display: string;
  /** Доступные начертания */
  weights: number[];
}

/** Группирует загруженные файлы по семействам. */
export function fontFamilies(fonts: CustomFontInfo[]): CustomFontFamily[] {
  const map = new Map<string, CustomFontFamily>();

  for (const font of fonts) {
    const item = map.get(font.family) ?? {
      family: font.family,
      display: font.display || font.name,
      weights: [],
    };
    if (!item.weights.includes(font.weight)) item.weights.push(font.weight);
    map.set(font.family, item);
  }

  return [...map.values()].sort((a, b) => a.display.localeCompare(b.display));
}

/** CSS-стек для выбранного шрифта. */
export function fontStack(fontId: string, customFonts: CustomFontInfo[] = []): string {
  if (fontId.startsWith(CUSTOM_FONT_PREFIX)) {
    const family = fontId.slice(CUSTOM_FONT_PREFIX.length);
    return `"${family}", "Segoe UI", Arial, sans-serif`;
  }

  return BUILTIN_FONTS.find((font) => font.id === fontId)?.stack ?? BUILTIN_FONTS[0].stack;
}

/** Человеческое название шрифта для интерфейса. */
export function fontLabel(fontId: string, customFonts: CustomFontInfo[] = []): string {
  if (fontId.startsWith(CUSTOM_FONT_PREFIX)) {
    const family = fontId.slice(CUSTOM_FONT_PREFIX.length);
    const found = fontFamilies(customFonts).find((item) => item.family === family);
    return found?.display ?? family;
  }

  return BUILTIN_FONTS.find((font) => font.id === fontId)?.label ?? "Inter";
}

/** Регистрирует один шрифт в document.fonts. */
export async function registerFont(font: CustomFontInfo): Promise<boolean> {
  if (typeof FontFace === "undefined" || !document.fonts) return false;

  try {
    const face = new FontFace(font.family, `url(${font.dataUrl})`, {
      weight: String(font.weight ?? 400),
    });
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (error) {
    console.error("Не удалось загрузить шрифт", font.name, error);
    return false;
  }
}

/** Загружает и регистрирует все свои шрифты. */
export async function syncCustomFonts(): Promise<CustomFontInfo[]> {
  const list = (await window.electronAPI?.listCustomFonts()) ?? [];

  for (const font of list) {
    await registerFont(font);
  }

  return list;
}

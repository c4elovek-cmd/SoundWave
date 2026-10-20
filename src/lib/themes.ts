// Кастомные темы: сохранение, цветовая математика и применение к документу.

export type ThemeBase = "dark" | "light";

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** Акцент в формате #rrggbb. */
  accent: string;
}

const STORAGE_KEY = "sw-custom-themes";

const ACCENT_VARS = [
  "--accent",
  "--accent-hover",
  "--accent-pressed",
  "--accent-subtle",
  "--accent-text",
];

export const BUILTIN_THEMES: { id: string; label: string; accent: string; base: ThemeBase }[] = [
  { id: "dark", label: "Тёмная (SoundCloud Orange)", accent: "#ff5500", base: "dark" },
  { id: "light", label: "Светлая", accent: "#ffffff", base: "light" },
  { id: "purple", label: "Фиолетовая", accent: "#a855f7", base: "dark" },
  { id: "green", label: "Зелёная", accent: "#1db954", base: "dark" },
];

export const ACCENT_PRESETS = [
  "#ff5500",
  "#ff2d55",
  "#ec4899",
  "#a855f7",
  "#6366f1",
  "#3b82f6",
  "#06b6d4",
  "#1db954",
  "#eab308",
  "#f97316",
];

export function normalizeHex(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hex) ?? "#ff5500";
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

/** Осветляет (amount > 0) или затемняет (amount < 0) цвет. */
export function shadeColor(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const ratio = Math.min(1, Math.abs(amount) / 100);

  const channel = (value: number) =>
    Math.round(value + (target - value) * ratio)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function rgbaColor(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Белый или почти чёрный текст — чтобы читался на выбранном акценте. */
export function readableTextColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#111111" : "#ffffff";
}

export function themeDataId(theme: CustomTheme): string {
  return `custom:${theme.id}`;
}

export function applyTheme(themeId: string, customThemes: CustomTheme[]): void {
  const root = document.documentElement;
  const custom = themeId.startsWith("custom:")
    ? customThemes.find((theme) => themeDataId(theme) === themeId)
    : undefined;

  if (!custom) {
    root.setAttribute("data-theme", themeId);
    ACCENT_VARS.forEach((property) => root.style.removeProperty(property));
    return;
  }

  root.setAttribute("data-theme", custom.base);
  root.style.setProperty("--accent", custom.accent);
  root.style.setProperty("--accent-hover", shadeColor(custom.accent, 18));
  root.style.setProperty("--accent-pressed", shadeColor(custom.accent, -16));
  root.style.setProperty(
    "--accent-subtle",
    rgbaColor(custom.accent, custom.base === "dark" ? 0.16 : 0.12)
  );
  root.style.setProperty("--accent-text", readableTextColor(custom.accent));
}

/** Основа темы: тёмная или светлая. Нужна, чтобы фон окна совпадал с фоном. */
export function themeBase(
  themeId: string,
  customThemes: CustomTheme[]
): "dark" | "light" {
  const custom = themeId.startsWith("custom:")
    ? customThemes.find((theme) => themeDataId(theme) === themeId)
    : undefined;

  if (custom) return custom.base;
  return themeId === "light" ? "light" : "dark";
}

function isCustomTheme(value: unknown): value is CustomTheme {
  if (!value || typeof value !== "object") return false;
  const theme = value as Partial<CustomTheme>;
  return (
    typeof theme.id === "string" &&
    typeof theme.name === "string" &&
    (theme.base === "dark" || theme.base === "light") &&
    typeof theme.accent === "string" &&
    normalizeHex(theme.accent) !== null
  );
}

export function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isCustomTheme)
      .map((theme) => ({ ...theme, accent: normalizeHex(theme.accent) ?? "#ff5500" }));
  } catch {
    return [];
  }
}

export function saveCustomThemes(themes: CustomTheme[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
  } catch {
    // Если localStorage переполнен, тема останется только до перезапуска.
  }
}

export function newThemeId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Время саундпада: границы фрагментов вводятся как «1:23.4» или «83.4».
 */

/** «1:23.4» или «83.4» → секунды; null, если текст не разобран. */
export function parseSoundpadTime(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 2) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0];
}

/** Секунды → «1:23.4» (десятые только если есть). */
export function formatSoundpadTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = Math.round((clamped - minutes * 60) * 10) / 10;
  const whole = Math.floor(rest);
  const tenth = Math.round((rest - whole) * 10);
  const base = `${minutes}:${String(whole).padStart(2, "0")}`;
  return tenth > 0 ? `${base}.${tenth}` : base;
}
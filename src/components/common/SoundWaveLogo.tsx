import type { SVGProps } from "react";

/** Фирменный знак SoundWave: семь белых полос на оранжевом фоне. */
export default function SoundWaveLogo({
  size = 32,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="SoundWave"
      {...props}
    >
      <rect width="32" height="32" rx="8" fill="var(--accent, #ff5500)" />
      <g fill="#fff">
        <rect x="5" y="12" width="2.5" height="8" rx="1.25" />
        <rect x="8.5" y="9" width="2.5" height="14" rx="1.25" />
        <rect x="12" y="6" width="2.5" height="20" rx="1.25" />
        <rect x="15.5" y="3.5" width="2.5" height="25" rx="1.25" />
        <rect x="19" y="6" width="2.5" height="20" rx="1.25" />
        <rect x="22.5" y="9" width="2.5" height="14" rx="1.25" />
        <rect x="26" y="12" width="2.5" height="8" rx="1.25" />
      </g>
    </svg>
  );
}

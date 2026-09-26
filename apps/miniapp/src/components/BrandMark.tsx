/** The GSP logo mark — same shape as on the trade cards (rounded emerald tile, rising line). */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="gsp-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A6F7CF" />
          <stop offset="100%" stopColor="#22D97A" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#gsp-mark)" />
      <polyline
        points="11,33 20,24 27,29 37,15"
        fill="none"
        stroke="#07090F"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="37" cy="15" r="3.5" fill="#07090F" />
    </svg>
  );
}

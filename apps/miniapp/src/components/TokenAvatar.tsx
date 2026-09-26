import { useState } from 'react';

export interface TokenAvatarProps {
  imageUrl?: string | null;
  symbol?: string | null;
  mint: string;
  size?: number;
}

const GRADIENTS = [
  'from-[#22D97A] to-[#0E7C4A]',
  'from-[#F5433C] to-[#F5B942]',
  'from-[#A6F7CF] to-[#22D97A]',
  'from-[#F5B942] to-[#E07B16]',
];

/** Deterministic from the mint, not random — the same token always gets the
 * same fallback color across renders/screens. */
function gradientFor(mint: string): string {
  let hash = 0;
  for (let i = 0; i < mint.length; i++) hash = (hash * 31 + mint.charCodeAt(i)) >>> 0;
  // Non-null: hash % GRADIENTS.length is always a valid index into GRADIENTS.
  return GRADIENTS[hash % GRADIENTS.length]!;
}

/** Real DexScreener logo when Token.imageUrl has one; otherwise a letter
 * avatar from the real symbol/mint — never a placeholder stock image. */
export function TokenAvatar({ imageUrl, symbol, mint, size = 40 }: TokenAvatarProps) {
  const [failed, setFailed] = useState(false);
  const initial = (symbol ?? mint).charAt(0).toUpperCase();

  if (imageUrl && !failed) {
    return (
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${gradientFor(mint)} font-bold text-white`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

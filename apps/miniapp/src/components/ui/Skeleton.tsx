export interface SkeletonProps {
  className?: string;
  /** Renders `count` stacked skeleton lines instead of one block — for list/table placeholders. */
  count?: number;
}

/**
 * Every data-dependent surface must render this (never a blank/empty area)
 * while loading, and must not layout-shift when real data replaces it — size
 * the skeleton to match the real content's dimensions via className.
 */
export function Skeleton({ className = 'h-4 w-full', count = 1 }: SkeletonProps) {
  if (count === 1) {
    return <div className={`animate-pulse rounded-md bg-white/[0.06] ${className}`} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`animate-pulse rounded-md bg-white/[0.06] ${className}`} />
      ))}
    </div>
  );
}

/** Preset matching Card's dimensions — the common case of "a card-shaped area is loading." */
export function CardSkeleton() {
  return (
    <div className="glass rounded-card shadow-elevated flex flex-col gap-3 p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}

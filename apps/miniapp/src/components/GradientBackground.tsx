/**
 * Fixed, decorative backdrop behind every screen — the same visual language
 * as the GSP trade cards: a faint dot grid fading out from the top and a slow
 * emerald glow. Decorative only; `prefers-reduced-motion` freezes it (index.css).
 */
export function GradientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background"
    >
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1.2px, transparent 1.2px)',
          backgroundSize: '26px 26px',
          maskImage: 'radial-gradient(ellipse 90% 60% at 50% 0%, #000 30%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 90% 60% at 50% 0%, #000 30%, transparent 100%)',
        }}
      />
      <div className="animate-aurora absolute -top-[30vh] left-1/2 h-[70vh] w-[110vw] -translate-x-1/2 rounded-full bg-accent-from/20 blur-[120px]" />
      <div className="animate-aurora-slow absolute -bottom-1/3 -right-1/4 h-[50vh] w-[60vh] rounded-full bg-accent-from/[0.06] blur-[120px]" />
    </div>
  );
}

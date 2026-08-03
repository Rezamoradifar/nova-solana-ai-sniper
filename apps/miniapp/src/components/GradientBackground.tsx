/**
 * Fixed, decorative ambient glow behind every screen — three large blurred
 * blobs drifting slowly (see the `aurora` keyframes in tailwind.config.ts).
 * `aria-hidden` + `pointer-events-none` since this carries no information;
 * `prefers-reduced-motion` freezes it (index.css). Mount once at the app
 * root, not per-screen, so navigating between tabs doesn't restart/jump it.
 */
export function GradientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background"
    >
      <div className="animate-aurora absolute -left-1/4 -top-1/4 h-[70vh] w-[70vh] rounded-full bg-accent-from/20 blur-[120px]" />
      <div className="animate-aurora-delayed absolute -right-1/3 top-1/4 h-[60vh] w-[60vh] rounded-full bg-accent-to/20 blur-[120px]" />
      <div className="animate-aurora-slow absolute -bottom-1/4 left-1/4 h-[55vh] w-[55vh] rounded-full bg-success/10 blur-[120px]" />
    </div>
  );
}

import type { Transition } from 'framer-motion';

/** Design brief's default transition — spring(stiffness: 300, damping: 30).
 * Every animated component in this app should use this unless it has a
 * specific reason not to, so motion feels like one consistent system. */
export const springTransition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
};

/** Standard fade+rise for cards/screens entering — pairs with springTransition. */
export const fadeInUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: springTransition,
};

/** Subtle press feedback for anything tappable. */
export const tapScale = {
  whileTap: { scale: 0.96 },
  transition: springTransition,
};

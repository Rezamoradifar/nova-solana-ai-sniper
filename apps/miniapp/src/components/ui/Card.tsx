import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef } from 'react';
import { fadeInUp } from '../../lib/motion.js';

export interface CardProps extends HTMLMotionProps<'div'> {
  /** Skips the entrance animation — use for cards inside an already-animated list
   * (e.g. staggered by the parent) so they don't double-animate. */
  static?: boolean;
}

/** The app's one glass-surface card primitive — every screen composes this
 * rather than hand-rolling background/blur/border/radius. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className = '', static: isStatic, children, ...props },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      className={`glass rounded-card shadow-elevated ${className}`}
      {...(isStatic ? {} : fadeInUp)}
      {...props}
    >
      {children}
    </motion.div>
  );
});

import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef } from 'react';
import { tapScale } from '../../lib/motion.js';
import { haptics } from '../../lib/telegram.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'onClick' | 'children'> {
  variant?: ButtonVariant;
  /** Shows a spinner and disables the button — for an in-flight mutation
   * (e.g. sell/withdraw), never for a route/data load (use Skeleton there). */
  loading?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent-gradient text-[#07090F]',
  secondary: 'glass text-text-primary',
  danger: 'bg-danger text-white',
  ghost: 'bg-transparent text-text-secondary hover:text-text-primary',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading = false, disabled, className = '', children, onClick, ...props },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={`rounded-button px-5 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      onClick={() => {
        if (disabled || loading) return;
        haptics.tap();
        onClick?.();
      }}
      {...tapScale}
      {...props}
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          {children}
        </span>
      ) : (
        children
      )}
    </motion.button>
  );
});

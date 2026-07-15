import * as RadixDialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'framer-motion';
import { springTransition } from '../../lib/motion.js';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** Bottom-sheet-style modal (the natural pattern inside a Telegram WebView) —
 * built on Radix Dialog for real focus-trap/ESC/aria behavior, styled as the
 * app's glass surface. */
export function Modal({ open, onOpenChange, title, description, children }: ModalProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild forceMount>
              <motion.div
                className="glass fixed inset-x-0 bottom-0 z-50 rounded-t-card p-6 shadow-elevated"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={springTransition}
              >
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />
                <RadixDialog.Title className="text-lg font-semibold text-text-primary">
                  {title}
                </RadixDialog.Title>
                {description && (
                  <RadixDialog.Description className="mt-1 text-sm text-text-secondary">
                    {description}
                  </RadixDialog.Description>
                )}
                <div className="mt-4">{children}</div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

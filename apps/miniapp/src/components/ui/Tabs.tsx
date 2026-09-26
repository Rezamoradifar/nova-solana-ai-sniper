import * as RadixTabs from '@radix-ui/react-tabs';
import { motion } from 'framer-motion';
import { springTransition } from '../../lib/motion.js';
import { haptics } from '../../lib/telegram.js';

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}

/** Accessible tabs (Radix primitive) with an animated active-tab indicator. */
export function Tabs({ items, value, onChange, children }: TabsProps) {
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={(next) => {
        haptics.tap();
        onChange(next);
      }}
    >
      <RadixTabs.List className="glass relative flex gap-1 rounded-button p-1">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className="relative z-10 flex-1 rounded-button px-3 py-2 text-sm font-medium text-text-secondary outline-none transition-colors data-[state=active]:font-semibold data-[state=active]:text-[#07090F]"
          >
            {value === item.value && (
              <motion.div
                layoutId="tabs-active-indicator"
                className="bg-accent-gradient absolute inset-0 -z-10 rounded-button"
                transition={springTransition}
              />
            )}
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export const TabPanel = RadixTabs.Content;

import type { Config } from 'tailwindcss';

/**
 * Colors are CSS custom properties (see src/index.css's :root/[data-theme="light"]
 * blocks), not literal hex here — that's what lets syncTelegramTheme (lib/telegram.ts)
 * flip the whole palette at runtime when Telegram's own theme changes, without a
 * Tailwind rebuild. The hex values below are only the dark-theme (default) source of
 * truth, documented here once; index.css is what actually wires them into `--nova-*`.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--nova-background) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--nova-surface) / <alpha-value>)',
          border: 'rgb(var(--nova-surface-border) / <alpha-value>)',
        },
        accent: {
          from: '#22D97A',
          to: '#A6F7CF',
        },
        success: '#22D97A',
        danger: '#F5433C',
        warning: '#F5B942',
        text: {
          primary: 'rgb(var(--nova-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--nova-text-secondary) / <alpha-value>)',
        },
      },
      borderRadius: {
        card: '24px',
        button: '14px',
        input: '12px',
      },
      boxShadow: {
        elevated: '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
      backdropBlur: {
        glass: '20px',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: [
          'Vazirmatn',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'system-ui',
          'sans-serif',
        ],
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #A6F7CF 0%, #22D97A 100%)',
      },
      keyframes: {
        // Slow drift for the fixed background glow blobs (GradientBackground) —
        // deliberately subtle (small translate/scale) so it reads as ambient
        // depth, never distracts from data on top of it.
        aurora: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(6%, 8%) scale(1.08)' },
        },
      },
      animation: {
        aurora: 'aurora 18s ease-in-out infinite',
        'aurora-delayed': 'aurora 22s ease-in-out infinite 3s',
        'aurora-slow': 'aurora 26s ease-in-out infinite 1.5s',
      },
    },
  },
  plugins: [],
} satisfies Config;

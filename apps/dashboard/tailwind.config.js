/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--lux-body)', 'sans-serif'],
        display: ['var(--lux-display)', 'sans-serif'],
        mono: ['MLMono', 'monospace'],
      },
      colors: {
        moneyland: {
          ink: '#0A0B0F',
          panel: '#11141F',
          cyan: '#00E5FF',
          purple: '#8B5CF6',
          profit: '#22C55E',
          loss: '#EF4444',
        },
        surface: {
          DEFAULT: '#090909',
          raised: '#141310',
          hover: '#1b1915',
          border: '#302b21',
        },
        accent: {
          DEFAULT: '#c4a66e',
          hover: '#e1c690',
        },
        profit: '#22c55e',
        loss: '#ef4444',
      },
    },
  },
  plugins: [],
};

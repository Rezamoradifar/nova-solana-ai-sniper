/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'Space Grotesk', 'ui-sans-serif', 'system-ui'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
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
          DEFAULT: '#0b0e14',
          raised: '#111623',
          hover: '#161c2c',
          border: '#232a3d',
        },
        accent: {
          DEFAULT: '#7c5cff',
          hover: '#9179ff',
        },
        profit: '#22c55e',
        loss: '#ef4444',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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

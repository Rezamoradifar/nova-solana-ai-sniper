/** Moneyland token bridge for Tailwind 3. Does not replace existing GSP colors.
 * Add to presets: [moneylandPreset] in a consuming Tailwind configuration.
 * React components are styled with scoped .neon classes to preserve legacy UI.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        moneyland: {
          bg: '#0A0B0F', panel: '#121620', raised: '#171C29',
          cyan: '#00E5FF', purple: '#8B5CF6', profit: '#22C55E', loss: '#EF4444',
          text: '#F5F7FC', muted: '#A1ABC0', border: 'rgba(195,209,255,0.12)',
        },
      },
      fontFamily: {
        'moneyland-ui': ['Inter', 'Vazirmatn', 'sans-serif'],
        'moneyland-display': ['Space Grotesk', 'Inter', 'sans-serif'],
        'moneyland-fa': ['Vazirmatn', 'Inter', 'sans-serif'],
        'moneyland-mono': ['JetBrains Mono', 'monospace'],
      },
      borderRadius: { 'ml-control': '9px', 'ml-card': '16px', 'ml-feature': '24px' },
      boxShadow: { 'ml-glow': '0 0 30px rgba(0,229,255,.15)', 'ml-panel': 'inset 0 1px rgba(255,255,255,.04)' },
      transitionDuration: { ml: '180ms' },
    },
  },
};

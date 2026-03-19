/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0d0d10',
          1: '#121215',
          2: '#18181c',
          3: '#1e1e23',
          4: '#26262c',
          5: '#2e2e36',
        },
        text: {
          primary: '#d8d8dc',
          secondary: '#6b6b78',
          tertiary: '#4a4a56',
          muted: '#3a3a44',
        },
        accent: {
          DEFAULT: '#4f8ff7',
          hover: '#3d7de8',
          subtle: 'rgba(79, 143, 247, 0.10)',
          glow: 'rgba(79, 143, 247, 0.06)',
        },
        border: {
          DEFAULT: '#1f1f26',
          subtle: 'rgba(255, 255, 255, 0.04)',
          hover: '#2a2a32',
        },
        status: {
          error: '#f87171',
          success: '#4ade80',
          warning: '#fbbf24',
        },
        user: {
          bubble: 'rgba(12, 38, 68, 0.55)',
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
        'thinking-dot': 'thinking-dot 1.4s ease-in-out infinite',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'thinking-dot': {
          '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: '0.4' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

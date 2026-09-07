/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Light palette: Warm clinical precision
        ink: '#13151A',
        paper: '#FAF8F4',
        muted: '#6E7175',
        dust: '#C7C4BC',
        line: '#E6E2DA',
        surface: '#FFFFFF',
        tint: '#F4F1EC',

        // Dark palette: Neuro Console
        darkBg: '#090B0E',
        darkCard: '#11151C',
        darkCardHover: '#161B24',
        darkBorder: '#1F2633',
        darkBorderSubtle: '#181E29',
        darkMuted: '#818B99',
        darkText: '#E6EDF5',

        // Clinical Accent
        accent: '#0D8282',
        accentHover: '#0B6E6E',
        accentSoft: '#0D82821A',
        accentGlow: 'rgba(13, 130, 130, 0.25)',

        // Clinical Risk Tiers
        tierHigh: '#E04836',
        tierHighSoft: '#E048361C',
        tierMedium: '#D9822B',
        tierMediumSoft: '#D9822B1C',
        tierLow: '#1EB980',
        tierLowSoft: '#1EB9801C',
      },
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(19,21,26,0.03), 0 10px 24px -22px rgba(19,21,26,0.12)',
        lift: '0 1px 3px rgba(19,21,26,0.05), 0 20px 44px -26px rgba(19,21,26,0.22)',
        float: '0 2px 8px -2px rgba(19,21,26,0.05), 0 12px 30px -10px rgba(19,21,26,0.1)',
        'dark-float': '0 4px 20px -4px rgba(0,0,0,0.65), 0 0 1px rgba(255,255,255,0.08)',
        'glow-teal': '0 0 24px -4px rgba(13, 130, 130, 0.35)',
        'glow-high': '0 0 24px -4px rgba(224, 72, 54, 0.35)',
        'glow-medium': '0 0 24px -4px rgba(217, 130, 43, 0.35)',
        'glow-low': '0 0 24px -4px rgba(30, 185, 128, 0.35)',
        insetline: 'inset 0 1px 0 rgba(255,255,255,0.55)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'live-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-glow': {
          '0%, 100%': { filter: 'drop-shadow(0 0 6px rgba(13, 130, 130, 0.3))' },
          '50%': { filter: 'drop-shadow(0 0 16px rgba(13, 130, 130, 0.65))' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.25s ease both',
        'slide-up': 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-right': 'slide-in-right 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
        'live-pulse': 'live-pulse 2s ease-in-out infinite',
        float: 'float 4s ease-in-out infinite',
        'scale-in': 'scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) both',
        'shimmer': 'shimmer 2.5s infinite linear',
        'pulse-glow': 'pulse-glow 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

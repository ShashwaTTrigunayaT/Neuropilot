/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Light palette: Warm clinical precision
        //
        // EVERY neutral is a variable. That is what lets the phone theme be a
        // whole design system rather than a handful of accent tweaks: one block
        // of values in index.css re-colours paper, cards, borders and text
        // across every component, none of which names a colour itself.
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        paper: 'rgb(var(--paper-rgb) / <alpha-value>)',
        muted: 'rgb(var(--muted-rgb) / <alpha-value>)',
        dust: 'rgb(var(--dust-rgb) / <alpha-value>)',
        line: 'rgb(var(--line-rgb) / <alpha-value>)',
        surface: 'rgb(var(--surface-rgb) / <alpha-value>)',
        tint: 'rgb(var(--tint-rgb) / <alpha-value>)',

        // Dark palette: Neuro Console
        darkBg: 'rgb(var(--dark-bg-rgb) / <alpha-value>)',
        darkCard: 'rgb(var(--dark-card-rgb) / <alpha-value>)',
        darkCardHover: 'rgb(var(--dark-card-hover-rgb) / <alpha-value>)',
        darkBorder: 'rgb(var(--dark-border-rgb) / <alpha-value>)',
        darkBorderSubtle: 'rgb(var(--dark-border-subtle-rgb) / <alpha-value>)',
        darkMuted: 'rgb(var(--dark-muted-rgb) / <alpha-value>)',
        darkText: 'rgb(var(--dark-text-rgb) / <alpha-value>)',

        // Clinical Accent
        // The accent is a CSS variable so it can differ per theme: teal on the
        // desktop light/dark palettes, amber on the black phone theme.
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        accentHover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        accentSoft: 'rgb(var(--accent-rgb) / 0.1)',
        accentGlow: 'rgb(var(--accent-rgb) / 0.25)',

        // Clinical Risk Tiers
        tierHigh: '#E04836',
        tierHighSoft: '#E048361C',
        tierMedium: '#D9822B',
        tierMediumSoft: '#D9822B1C',
        tierLow: '#1EB980',
        tierLowSoft: '#1EB9801C',
      },
      // Both faces are variables, so a type theme re-fonts the whole app.
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
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

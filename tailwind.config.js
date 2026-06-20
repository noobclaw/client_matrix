/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Crypto / Web3 dark palette
        claude: {
          // Light mode (kept clean for those who prefer it)
          bg: '#F8F9FB',
          surface: '#FFFFFF',
          surfaceHover: '#F0F1F4',
          surfaceMuted: '#F3F4F6',
          surfaceInset: '#EBEDF0',
          border: '#E0E2E7',
          borderLight: '#EBEDF0',
          text: '#1A1D23',
          textSecondary: '#6B7280',
          // Dark mode — deep space / crypto palette
          darkBg: '#09090E',           // deepest background — almost void black
          darkSurface: '#0F0F1A',      // cards / panels — dark with blue-purple hint
          darkSurfaceHover: '#161625', // hover state
          darkSurfaceMuted: '#0C0C14', // subtle area
          darkSurfaceInset: '#07070F', // inset areas (input inner)
          darkBorder: '#1C1C2E',       // borders — dark with purple hint
          darkBorderLight: '#141422',  // subtle dividers
          darkText: '#E8E8FF',         // primary text — slightly blue-white
          darkTextSecondary: '#7B7B9E',// secondary — muted blue-gray
          // Accent — neon green (crypto primary)
          accent: '#00FF88',
          accentHover: '#00E67A',
          accentLight: '#00FF88',
          accentMuted: 'rgba(0,255,136,0.10)',
        },
        primary: {
          DEFAULT: '#00FF88',
          dark: '#00E67A'
        },
        secondary: {
          DEFAULT: '#6B7280',
          dark: '#1C1C2E'
        },
        // Extra neon colors for direct use
        neon: {
          green: '#00FF88',
          cyan: '#00D4FF',
          purple: '#7B5CF6',
          pink: '#F72585',
        }
      },
      boxShadow: {
        subtle: '0 1px 2px rgba(0,0,0,0.05)',
        card: '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)',
        elevated: '0 4px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.2)',
        modal: '0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.3)',
        popover: '0 4px 24px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.2)',
        'glow-green': '0 0 20px rgba(0,255,136,0.25), 0 0 40px rgba(0,255,136,0.1)',
        'glow-cyan': '0 0 20px rgba(0,212,255,0.2), 0 0 40px rgba(0,212,255,0.08)',
        'glow-accent': '0 0 20px rgba(0,255,136,0.2)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'neon-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.25s ease-out',
        'fade-in-down': 'fade-in-down 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        shimmer: 'shimmer 1.5s infinite',
        'neon-pulse': 'neon-pulse 2s ease-in-out infinite',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      },
      typography: {
        DEFAULT: {
          css: {
            color: '#1A1D23',
            a: {
              color: '#00cc6e',
              '&:hover': { color: '#00FF88' },
            },
            code: {
              color: '#1A1D23',
              backgroundColor: 'rgba(224, 226, 231, 0.5)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              backgroundColor: '#F0F1F4',
              color: '#1A1D23',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: { borderLeftColor: '#00FF88', color: '#6B7280' },
            h1: { color: '#1A1D23' }, h2: { color: '#1A1D23' },
            h3: { color: '#1A1D23' }, h4: { color: '#1A1D23' },
            strong: { color: '#1A1D23' },
          },
        },
        dark: {
          css: {
            color: '#E8E8FF',
            a: {
              color: '#00FF88',
              '&:hover': { color: '#00D4FF' },
            },
            code: {
              color: '#00FF88',
              backgroundColor: 'rgba(0,255,136,0.08)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            pre: {
              backgroundColor: '#0F0F1A',
              color: '#E8E8FF',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
              border: '1px solid #1C1C2E',
            },
            blockquote: { borderLeftColor: '#00FF88', color: '#7B7B9E' },
            h1: { color: '#E8E8FF' }, h2: { color: '#E8E8FF' },
            h3: { color: '#E8E8FF' }, h4: { color: '#E8E8FF' },
            strong: { color: '#00FF88' },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}

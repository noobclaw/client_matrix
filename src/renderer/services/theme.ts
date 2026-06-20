
type ThemeType = 'light' | 'dark' | 'system';

// Crypto dark palette
const COLORS = {
  light: {
    bg: '#F8F9FB',
    text: '#1A1D23',
  },
  dark: {
    bg: '#09090E',
    text: '#E8E8FF',
  },
};

class ThemeService {
  private mediaQuery: MediaQueryList | null = null;
  private currentTheme: ThemeType = 'system';
  private appliedTheme: 'light' | 'dark' | null = null;
  private initialized = false;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
  }

  // Initialize theme — force dark
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      // Always use dark mode, do not read user config
      this.setTheme('dark');

      // Listen for system theme changes
      if (this.mediaQuery) {
        this.mediaQueryListener = (e) => {
          if (this.currentTheme === 'system') {
            this.applyTheme(e.matches ? 'dark' : 'light');
          }
        };
        this.mediaQuery.addEventListener('change', this.mediaQueryListener);
      }
    } catch (error) {
      console.error('Failed to initialize theme:', error);
      // Default to system theme
      this.setTheme('system');
    }
  }

  // Set theme — always force dark, ignore passed parameter
  setTheme(_theme: ThemeType): void {
    if (this.appliedTheme === 'dark') return;
    this.currentTheme = 'dark';
    this.applyTheme('dark');
  }

  // Get current theme
  getTheme(): ThemeType {
    return this.currentTheme;
  }

  // Get current effective theme (the actually applied light/dark theme)
  getEffectiveTheme(): 'light' | 'dark' {
    if (this.currentTheme === 'system') {
      return this.mediaQuery?.matches ? 'dark' : 'light';
    }
    return this.currentTheme;
  }

  // Apply theme to DOM
  private applyTheme(theme: 'light' | 'dark'): void {
    // Avoid redundantly applying the same theme
    if (this.appliedTheme === theme) {
      return;
    }

    console.log(`Applying theme: ${theme}`);
    this.appliedTheme = theme;
    const root = document.documentElement;
    const colors = COLORS[theme];

    if (theme === 'dark') {
      // Apply dark theme to HTML element (for Tailwind)
      root.classList.add('dark');
      root.classList.remove('light');

      // Make sure theme is consistent across entire DOM
      document.body.classList.add('dark');
      document.body.classList.remove('light');

      // Set background and text colors
      root.style.backgroundColor = colors.bg;
      document.body.style.backgroundColor = colors.bg;
      document.body.style.color = colors.text;
    } else {
      // Apply light theme to HTML element (for Tailwind)
      root.classList.remove('dark');
      root.classList.add('light');

      // Make sure theme is consistent across entire DOM
      document.body.classList.remove('dark');
      document.body.classList.add('light');

      // Set background and text colors
      root.style.backgroundColor = colors.bg;
      document.body.style.backgroundColor = colors.bg;
      document.body.style.color = colors.text;
    }

    // Update CSS variables for color transition animations
    root.style.setProperty('--theme-transition', 'background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease');
    document.body.style.transition = 'var(--theme-transition)';

    // Ensure #root element also gets the theme
    const rootElement = document.getElementById('root');
    if (rootElement) {
      if (theme === 'dark') {
        rootElement.classList.add('dark');
        rootElement.classList.remove('light');
        rootElement.style.backgroundColor = colors.bg;
      } else {
        rootElement.classList.remove('dark');
        rootElement.classList.add('light');
        rootElement.style.backgroundColor = colors.bg;
      }
    }
  }
}

export const themeService = new ThemeService();

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  isDark: boolean;
  setTheme: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'pp-theme';

const ThemeContext = createContext<ThemeContextType>({
  themeMode: 'system',
  isDark: false,
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'system'
  );
  const [isDark, setIsDark] = useState(false);

  const applyTheme = useCallback((mode: ThemeMode) => {
    const html = document.documentElement;
    let dark = false;

    if (mode === 'dark') {
      dark = true;
    } else if (mode === 'light') {
      dark = false;
    } else {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    if (dark) {
      html.classList.add('dark');
      html.setAttribute('data-theme', 'dark');
    } else {
      html.classList.remove('dark');
      html.setAttribute('data-theme', 'light');
    }
    setIsDark(dark);
  }, []);

  const setTheme = useCallback(
    (mode: ThemeMode) => {
      setThemeMode(mode);
      localStorage.setItem(STORAGE_KEY, mode);
      applyTheme(mode);
    },
    [applyTheme]
  );

  // Apply theme on mount and listen for system preference changes
  useEffect(() => {
    applyTheme(themeMode);

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (themeMode === 'system') {
        applyTheme('system');
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [themeMode, applyTheme]);

  const value = useMemo(() => ({ themeMode, isDark, setTheme }), [themeMode, isDark, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

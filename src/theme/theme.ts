export type ThemeName = 'windows' | 'macos' | 'gnome' | 'kde';

export const THEMES: readonly ThemeName[] = ['windows', 'macos', 'gnome', 'kde'];

const STORAGE_KEY = 'kuberneticos.theme';

let currentTheme: ThemeName = readStoredTheme() ?? THEMES[0];
const themeListeners = new Set<() => void>();

function readStoredTheme(): ThemeName | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && (THEMES as readonly string[]).includes(stored)
      ? (stored as ThemeName)
      : null;
  } catch {
    return null;
  }
}

function notifyThemeListeners(): void {
  for (const listener of [...themeListeners]) {
    listener();
  }
}

export function loadTheme(): ThemeName {
  return readStoredTheme() ?? THEMES[0];
}

export function saveTheme(name: ThemeName): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage unavailable (e.g. blocked cookies); the in-memory theme still applies.
  }
}

export function applyTheme(name: ThemeName): void {
  currentTheme = name;
  const root = document.documentElement;
  root.dataset.theme = name;
  for (const theme of THEMES) {
    root.classList.remove(`theme-${theme}`);
  }
  root.classList.add(`theme-${name}`);
  notifyThemeListeners();
}

export function nextTheme(current: ThemeName): ThemeName {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}

export function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

export function getCurrentTheme(): ThemeName {
  return currentTheme;
}

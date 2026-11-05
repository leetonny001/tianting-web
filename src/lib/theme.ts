import { getPref, setPref } from './uiPrefs';

// 主题（PRD-ui F-UI-22）。首帧前由同源脚本 public/theme-init.js 设置 <html data-theme>（CSP 不放宽），
// 这里负责之后的切换。两边的判断规则保持一致。
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'ui.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function getThemePref(): ThemePref {
  const v = getPref(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

const systemDark = () => (typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY).matches : false);

export function applyTheme(): void {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export function setThemePref(pref: ThemePref): void {
  setPref(KEY, pref);
  applyTheme();
}

/** 跟随系统时实时切换，不需要刷新（规则 3）；别的标签页改了外观也同步。 */
export function watchTheme(): void {
  applyTheme();
  if (typeof window.matchMedia === 'function') window.matchMedia(DARK_QUERY).addEventListener('change', applyTheme);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) applyTheme();
  });
}

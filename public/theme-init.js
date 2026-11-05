// 首帧前应用主题（PRD-ui F-UI-22 规则 4）：同步加载的同源脚本，CSP 保持 script-src 'self'。规则与 src/lib/theme.ts 一致。
(function () {
  var pref = null;
  try {
    pref = localStorage.getItem('ui.theme');
  } catch {
    // 隐私模式等情况下读不到：按跟随系统
  }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();

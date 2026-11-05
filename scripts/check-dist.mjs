// 构建产物检查（FE-010、FE-246）：带 CSP；不含任何管理接口、管理密钥相关的字符串；没有 source map。
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const problems = [];
const html = readFileSync(new URL('index.html', dist), 'utf8');
if (!/http-equiv="Content-Security-Policy"[^>]*script-src 'self'/.test(html))
  problems.push('index.html has no CSP meta');
// 首帧前的主题脚本（F-UI-22 规则 4）：head 里同步加载的同源文件，页面里没有内联脚本。
const head = html.slice(0, html.indexOf('</head>'));
if (!/<script src="\/theme-init\.js"><\/script>/.test(head)) problems.push('head has no sync /theme-init.js');
if (!existsSync(new URL('theme-init.js', dist))) problems.push('theme-init.js not shipped');
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) problems.push('inline script in index.html');
for (const f of readdirSync(new URL('assets/', dist))) {
  if (f.endsWith('.map')) problems.push(`source map shipped: ${f}`);
  if (!f.endsWith('.js')) continue;
  const js = readFileSync(new URL(`assets/${f}`, dist), 'utf8');
  for (const bad of ['X-Admin-Key', '/admin/', 'IM_ADMIN', 'X-IM-Signature'])
    if (js.includes(bad)) problems.push(`${f} contains "${bad}"`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('dist: CSP present, no admin strings, no source maps');

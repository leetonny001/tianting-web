// 构建产物检查（FE-010、FE-246）：带 CSP；不含任何管理接口、管理密钥相关的字符串；没有 source map。
import { readdirSync, readFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const problems = [];
const html = readFileSync(new URL('index.html', dist), 'utf8');
if (!/http-equiv="Content-Security-Policy"[^>]*script-src 'self'/.test(html))
  problems.push('index.html has no CSP meta');
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

// 首屏 JS 体积（AC-UI-90-8）：dist/index.html 直接引用的 JS（含 modulepreload）gzip 后合计 ≤ 200KB。
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', dist), 'utf8');
const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
let total = 0;
for (const f of files) total += gzipSync(readFileSync(new URL(f, dist))).length;
const kb = total / 1024;
console.log(`first-screen js: ${files.length} file(s), ${kb.toFixed(1)} KB gzip (limit 200 KB)`);
if (kb > 200) process.exit(1);

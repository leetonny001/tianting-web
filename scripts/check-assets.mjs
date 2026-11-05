// 构建产物资源检查（AC-UI-11-3）：没有大于 1KB 的位图，svg 文件都在 PRD-ui 6.6 节的图标清单里（表情用系统字体，不打包图片）。
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BITMAP = 1024;
const SVG_ALLOWED = new Set([
  'message-square-text',
  'book-user',
  'circle-user-round',
  'circle-plus',
  'user-plus',
  'users',
  'chevron-left',
  'ellipsis',
  'circle-alert',
  'loader-circle',
  'smile',
  'user-round-plus',
  'messages-square',
]);

export function checkAssets(dir) {
  const problems = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(png|jpe?g|webp|gif)$/i.test(name) && st.size > MAX_BITMAP) problems.push(`bitmap > 1KB: ${p}`);
      else if (/\.svg$/i.test(name) && !SVG_ALLOWED.has(basename(name, '.svg').toLowerCase()))
        problems.push(`svg not in icon list: ${p}`);
    }
  };
  walk(dir);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = checkAssets(process.argv[2] ?? new URL('../dist/', import.meta.url).pathname);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('assets: no large bitmaps, svg only from the icon list');
}

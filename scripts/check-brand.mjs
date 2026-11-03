// 品牌词扫描（AC-UI-90-15）：源码、页面和构建产物里不出现其他产品的名字。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 拼成正则，避免本文件自己被扫描命中。
const banned = new RegExp(['微信', 'we' + 'chat', 'wei' + 'xin'].join('|'), 'i');
const problems = [];

function scan(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p)) scan(join(p, name));
    return;
  }
  if (!/\.(tsx?|css|html|js|json|svg|txt|map)$/.test(p)) return;
  readFileSync(p, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (banned.test(line)) problems.push(`${p}:${i + 1}`);
    });
}
for (const p of process.argv.slice(2)) scan(p);
if (problems.length) {
  console.error('banned brand words found:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('brand: ok');

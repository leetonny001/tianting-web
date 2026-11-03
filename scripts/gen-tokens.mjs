// 从 src/theme/tokens.json 生成 src/theme/tokens.css（--tt-* 变量）。--check 时只比较，不一致就失败（CI）。
// M3 只输出浅色（PRD-ui F-UI-22 规则 2）：深色值已定义并参与对比度检查，M4 再按 data-theme / prefers-color-scheme 启用。
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('src/theme/tokens.json', root), 'utf8'));
const name = (group, key) => `--tt-${group}-${key.replaceAll('.', '-')}`;

const lines = ['/* 由 scripts/gen-tokens.mjs 从 tokens.json 生成，不要手改。 */', ':root {'];
for (const [k, v] of Object.entries(tokens.color)) lines.push(`  ${name('color', k)}: ${v.light};`);
tokens.avatar.forEach((c, i) => lines.push(`  --tt-avatar-${i}: ${c};`));
for (const group of ['font', 'space', 'radius', 'size']) {
  for (const [k, v] of Object.entries(tokens[group])) lines.push(`  ${name(group, k)}: ${v};`);
}
lines.push('}', '');
const css = lines.join('\n');
const out = new URL('src/theme/tokens.css', root);

if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== css) {
    console.error('src/theme/tokens.css is out of date: run npm run gen:tokens');
    process.exit(1);
  }
} else {
  writeFileSync(out, css);
}

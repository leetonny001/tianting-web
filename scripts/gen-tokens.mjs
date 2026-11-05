// 从 src/theme/tokens.json 生成 src/theme/tokens.css（--tt-* 变量）。--check 时只比较，不一致就失败（CI）。
// 深色值放在 :root[data-theme='dark'] 下（PRD-ui F-UI-22）：data-theme 由 public/theme-init.js 在首帧前设置。
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('src/theme/tokens.json', root), 'utf8'));
const name = (group, key) => `--tt-${group}-${key.replaceAll('.', '-')}`;

const lines = ['/* 由 scripts/gen-tokens.mjs 从 tokens.json 生成，不要手改。 */', ':root {', '  color-scheme: light;'];
for (const [k, v] of Object.entries(tokens.color)) lines.push(`  ${name('color', k)}: ${v.light};`);
tokens.avatar.forEach((c, i) => lines.push(`  --tt-avatar-${i}: ${c};`));
for (const group of ['font', 'space', 'radius', 'size']) {
  for (const [k, v] of Object.entries(tokens[group])) lines.push(`  ${name(group, k)}: ${v};`);
}
lines.push('}', '', ":root[data-theme='dark'] {", '  color-scheme: dark;');
for (const [k, v] of Object.entries(tokens.color)) lines.push(`  ${name('color', k)}: ${v.dark};`);
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

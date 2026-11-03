// 颜色字面量检查（AC-UI-22-3）：src/ 中除 token 文件外不能出现十六进制 / rgb() / hsl() 颜色；
// SVG 的 fill / stroke 只能是 currentColor 或 none。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const allowed = new Set(['theme/tokens.json', 'theme/tokens.css']);
const color = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const svgPaint = /\b(?:fill|stroke)\s*[=:]\s*["'{]?\s*(?!currentColor|none)[#a-zA-Z(]/;
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    const rel = relative(root, p);
    if (allowed.has(rel) || !/\.(tsx?|css)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (color.test(line)) problems.push(`${rel}:${i + 1}: color literal: ${line.trim()}`);
        if (/<svg|<path|<circle/.test(line) && svgPaint.test(line))
          problems.push(`${rel}:${i + 1}: svg paint must be currentColor or none`);
      });
  }
}
walk(root);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('colors: no literals outside tokens');

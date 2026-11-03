// 对比度与色相 CI（AC-UI-90-3、AC-UI-90-5）。
import { readFileSync } from 'node:fs';
import { checkTokens } from './contrast.mjs';

const tokens = JSON.parse(readFileSync(new URL('../src/theme/tokens.json', import.meta.url), 'utf8'));
const { problems, rows } = checkTokens(tokens);
if (process.argv.includes('-v')) console.log(rows.join('\n'));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`contrast: ${rows.length} pairs ok`);

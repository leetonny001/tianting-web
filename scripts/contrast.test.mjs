// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTokens } from './contrast.mjs';

const tokens = JSON.parse(readFileSync('src/theme/tokens.json', 'utf8'));
const clone = () => JSON.parse(JSON.stringify(tokens));

describe('对比度 / 色相 CI（AC-UI-90-3、AC-UI-90-5）', () => {
  it('当前 tokens 全部通过，并与 PRD-ui 6.2 节两位小数一致', () => {
    const { problems, rows } = checkTokens(tokens);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(26 * 2 + 8);
  });
  it('故意改坏一个值必须失败', () => {
    const t = clone();
    t.color['text.tertiary'].light = '#9AA0AA';
    expect(checkTokens(t).problems.join('\n')).toMatch(/L12 text.tertiary \/ surface/);
  });
  it('删掉一个 token 必须失败', () => {
    const t = clone();
    delete t.color['warning.bg'];
    expect(checkTokens(t).problems.join('\n')).toMatch(/token warning.bg is missing/);
  });
  it('品牌色改成绿色必须失败', () => {
    const t = clone();
    t.color.brand.light = '#07A65A';
    expect(checkTokens(t).problems.join('\n')).toMatch(/green range/);
  });
});

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
    expect(rows).toHaveLength(30 * 2 + 8); // 27～30 是 C5 的置顶背景（FE-683）
  });
  it('故意改坏一个值必须失败', () => {
    const t = clone();
    t.color['text.tertiary'].light = '#9AA0AA';
    expect(checkTokens(t).problems.join('\n')).toMatch(/L12 text.tertiary \/ surface/);
  });
  it('置顶背景（C5）太深、和文字对比不够必须失败；删掉也失败', () => {
    const t = clone();
    t.color['surface.pinned'].dark = '#5A6070';
    expect(checkTokens(t).problems.join('\n')).toMatch(/D29 text.tertiary \/ surface.pinned/);
    delete t.color['surface.pinned'];
    expect(checkTokens(t).problems.join('\n')).toMatch(/token surface.pinned is missing/);
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

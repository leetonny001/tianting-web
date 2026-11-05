// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAssets } from './check-assets.mjs';

const dist = () => {
  const d = mkdtempSync(join(tmpdir(), 'tt-assets-'));
  mkdirSync(join(d, 'assets'));
  return d;
};

describe('构建产物资源（AC-UI-11-3）', () => {
  it('小位图、清单里的 svg 通过', () => {
    const d = dist();
    writeFileSync(join(d, 'assets', 'tiny.png'), Buffer.alloc(1024));
    writeFileSync(join(d, 'smile.svg'), '<svg/>');
    expect(checkAssets(d)).toEqual([]);
  });
  it('大于 1KB 的位图（png / jpg / webp / gif）失败', () => {
    const d = dist();
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif'])
      writeFileSync(join(d, 'assets', `big.${ext}`), Buffer.alloc(1025));
    expect(checkAssets(d)).toHaveLength(5);
  });
  it('不在 6.6 节清单里的 svg 失败', () => {
    const d = dist();
    writeFileSync(join(d, 'compass.svg'), '<svg/>');
    expect(checkAssets(d).join()).toMatch(/compass\.svg/);
  });
});

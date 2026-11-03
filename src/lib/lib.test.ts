import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { avatarColorIndex, avatarInitial } from '@tianting/sdk';
import { KNOWN_CODES, messageFor } from './errors';
import { safeRedirect } from './routes';
import { formatTime, needsDivider } from './time';

describe('登录回跳地址校验（AC-UI-01-7、F-UI-01 规则 3）', () => {
  it('站内且匹配路由表的保留，其余回到 /chats', () => {
    expect(safeRedirect('/chat/c2c%3Aalice%3Abob')).toBe('/chat/c2c%3Aalice%3Abob');
    expect(safeRedirect('/me/settings')).toBe('/me/settings');
    for (const bad of [
      '//evil.com',
      'https://evil.com',
      '/\\evil.com',
      '/%5Cevil.com',
      '/not-a-route',
      '',
      null,
      '/login',
      '/chat/',
    ]) {
      expect(safeRedirect(bad), String(bad)).toBe('/chats');
    }
  });
});

describe('错误文案（F-UI-19、AC-SYS-01-4、AC-UI-19-3）', () => {
  it('errors.json 里每个 ws 通道的错误码都有文案', () => {
    const spec = JSON.parse(readFileSync('node_modules/@tianting/sdk/protocol/errors.json', 'utf8')) as {
      errors: { code: number; scope: string[] }[];
    };
    const ws = spec.errors.filter((e) => e.scope.includes('ws')).map((e) => e.code);
    expect(ws.length).toBeGreaterThan(10);
    for (const code of ws) expect(KNOWN_CODES, `code ${code}`).toContain(code);
  });
  it('按"命令 + 码"优先；不认识的码按区段兜底；从不展示服务端 msg', () => {
    expect(messageFor(4290, 'send')).toBe('发送太频繁，请稍后再试');
    expect(messageFor(4290, 'userSearch')).toBe('操作太频繁，请稍后再试');
    expect(messageFor(4292, 'send')).toBe('今天发起新聊天的次数已用完，请稍后再试');
    expect(messageFor(4292)).toBe('今天的次数已用完，明天再试');
    expect(messageFor(4042)).toBe('用户不存在');
    expect(messageFor(4001)).toBe('当前版本过低，请刷新页面');
    expect(messageFor(4008)).toBe('请求出错');
    expect(messageFor(4999)).toBe('请求出错');
    expect(messageFor(5999)).toBe('服务异常，请稍后重试');
  });
});

describe('时间显示（F-MSG-06 规则 4）', () => {
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  it('今天 / 昨天 / 今年 / 更早', () => {
    expect(formatTime(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatTime(new Date(2026, 10, 2, 23, 59).getTime(), now)).toBe('昨天 23:59');
    expect(formatTime(new Date(2026, 0, 2, 8, 0).getTime(), now)).toBe('01-02 08:00');
    expect(formatTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025-12-31 08:00');
  });
  it('间隔超过 5 分钟才显示分隔', () => {
    expect(needsDivider(undefined, 1)).toBe(true);
    expect(needsDivider(0, 5 * 60_000)).toBe(false);
    expect(needsDivider(0, 5 * 60_000 + 1)).toBe(true);
  });
});

describe('占位头像：界面用 SDK 的实现，跑共享用例 avatar.json（AC-UI-21-1、AC-UI-21-2）', () => {
  const spec = JSON.parse(readFileSync('node_modules/@tianting/sdk/protocol/vectors/avatar.json', 'utf8')) as {
    colors: { id: string; index: number }[];
    initials: { name: string; initial: string }[];
  };
  it('颜色下标和首字与用例一致', () => {
    for (const c of spec.colors) expect(avatarColorIndex(c.id), c.id).toBe(c.index);
    for (const c of spec.initials) expect(avatarInitial(c.name), c.name).toBe(c.initial);
    expect(avatarInitial('bob')).toBe('B');
    expect(avatarInitial('张三')).toBe('张');
    expect(avatarInitial('😀abc')).toBe('😀');
  });
});

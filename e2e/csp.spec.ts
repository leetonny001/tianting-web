import { expect, test } from '@playwright/test';
import { uid } from './helpers';

// 生产构建（vite preview，带 CSP meta）：登录、聊天全流程没有 CSP 违规（FE-246、AC-UI-90-12 的 Web 部分）。
test.use({ baseURL: 'http://127.0.0.1:15174' });

test('生产构建：带 CSP，登录和收发消息没有 CSP 违规', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto('/login');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  const a = uid('csp');
  await page.getByTestId('login-username').fill(a);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).toHaveURL(/\/chats$/);
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-menu').getByText('发起单聊').click();
  await page.getByTestId('start-chat-input').fill(a);
  await page.getByTestId('start-chat-input').press('Enter');
  await page.getByTestId('composer-input').fill('csp ok');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
  expect(violations).toEqual([]);
});

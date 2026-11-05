import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'playwright-report', 'test-results', 'src/theme/tokens.css'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 消息内容只按纯文本渲染（PRD F-MSG-06 规则 1、FE-014）。
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: '禁止 dangerouslySetInnerHTML：消息一律按纯文本渲染',
        },
        { selector: "MemberExpression[property.name='innerHTML']", message: '禁止 innerHTML' },
      ],
      // localStorage 只允许存 ui.* 偏好（PRD-ui NF-UI-12、FE-246），统一走 src/lib/uiPrefs.ts。
      'no-restricted-globals': ['error', { name: 'localStorage', message: '用 src/lib/uiPrefs.ts（只允许 ui.* 键）' }],
    },
  },
  {
    files: ['src/lib/uiPrefs.ts', 'e2e/**/*.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // 首帧前的同源脚本（F-UI-22 规则 4）：不经过打包，只读 ui.theme。
    files: ['public/theme-init.js'],
    languageOptions: { globals: { localStorage: 'readonly', window: 'readonly', document: 'readonly' } },
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' } },
  },
);

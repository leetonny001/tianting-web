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
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);

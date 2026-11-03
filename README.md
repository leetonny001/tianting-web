# tianting-web

天听 H5 客户端（React + Vite），基于 [@tianting/sdk](https://github.com/leetonny001/tianting-sdk-ts)。信息架构参考常见 IM（消息 / 通讯录 / 我），视觉使用天听自有品牌（靛蓝 `#4C5FD5`）。需求：tianting-server 的 `docs/prd/PRD-ui-v1.0.md`、`PRD-core-v1.3.md`，任务单 `docs/tasks/frontend.md`、`frontend-ui.md`。

## 现状（M3 第一批）

- 已有：演示登录（可填昵称）、路由守卫与回跳校验、底部导航与总未读角标 / 标题、会话列表（骨架屏、空状态、摘要、未读、截断提示）、"+"菜单与发起单聊（含给自己发消息）、聊天页（单聊 / 群聊、"群名（N）"、时间分隔、历史翻页、自动滚动与"↓ N 条新消息"、发送状态与失败重发、长按 / 右键菜单、超长提示、输入法组字）、被移出 / 解散 / 打开不在列表里的会话、连接状态条、被踢弹窗、轻提示与错误文案、聊天信息页、"我"与设置、演示面板（`?demo=1`）。
- 质量：37 个组件测试；11 个端到端测试（真实 im-server），含 axe 可访问性扫描、500 个会话的渲染性能（CPU 4 倍降速中位数约 370ms，上限 500ms）、生产构建 CSP 无违规。
- 待做：通讯录、好友、新的朋友、黑名单、隐私（依赖服务端社交功能 PRD-social）；群里发送者的昵称 / 头像（`users` 命令，依赖社交可见范围）；宽屏三栏、深色、表情、草稿（M4）。

## 开发

需要 Node 22.12+；SDK 和服务端源码放在同级目录（`../tianting-sdk-ts`、`../tianting-server` 或旧名 `../im-mvp`）。

```bash
(cd ../tianting-sdk-ts && npm install && npm run build)
npm install
npm run dev            # http://localhost:5173，/demo/login 和 /ws 转发到 TIANTING_SERVER（默认 http://127.0.0.1:8080）
npm test               # 单元 / 组件测试（Vitest + Testing Library，SDK 用 FakeTransport）
npm run e2e            # 端到端：自动启动测试模式的 im-server 和 Vite，用本机 Chrome 跑（需要 Go）
npm run lint && npm run typecheck && npm run format:check
npm run check          # token 生成文件、对比度 / 色相、颜色字面量、品牌词
npm run build && node scripts/check-bundle.mjs && node scripts/check-dist.mjs   # 首屏 JS ≤ 200KB；CSP、无管理密钥字符串、无 source map
```

本地启动服务端（另一个终端）：`cd ../im-mvp/server && IM_TEST_MODE=1 IM_DEMO_LOGIN=1 IM_ALLOWED_ORIGINS=http://localhost:5173 go run ./cmd/im-server`。

## 约定

- **颜色**只来自 `src/theme/tokens.json`（生成 `--tt-*` CSS 变量），组件里不写任何颜色字面量（`npm run check` 检查）。图标全部来自 Lucide（ISC，见 `LICENSES/`），`stroke-width` 1.75、`currentColor`。
- **消息只按纯文本渲染**：ESLint 禁止 `dangerouslySetInnerHTML` / `innerHTML`。
- **localStorage** 只能存 `ui.*` 偏好，统一走 `src/lib/uiPrefs.ts`（ESLint 禁止直接调用）；生产构建带 CSP，部署示例见 `deploy/nginx.conf`。
- **token** 只放 `sessionStorage`，不进 URL、不进日志；构建产物里没有任何管理密钥（H5 只调用 `/demo/login` 和 `/ws`）。
- **`data-testid`** 用小写短横线命名（如 `composer-input`、`conv-item`），原生端的 `testTag` / `accessibilityIdentifier` 用同样的名字。

## CI

CI 依赖两个私有仓库（SDK、服务端），需要仓库所有者运行一次 `scripts/setup-ci-deploy-keys.sh` 配置两把只读部署密钥；没配置时 CI 跳过。

## 天听的项目

| 仓库 | 内容 |
|---|---|
| [tianting-server](https://github.com/leetonny001/tianting-server) | Go 服务端、协议、需求 / 架构 / 测试文档 |
| [tianting-sdk-ts](https://github.com/leetonny001/tianting-sdk-ts) | SDK（TypeScript）：H5、PC |
| [tianting-sdk-kotlin](https://github.com/leetonny001/tianting-sdk-kotlin) | SDK（Kotlin）：Android |
| [tianting-sdk-swift](https://github.com/leetonny001/tianting-sdk-swift) | SDK（Swift）：iOS |
| [tianting-web](https://github.com/leetonny001/tianting-web) | H5 客户端 |
| [tianting-desktop](https://github.com/leetonny001/tianting-desktop) | PC 客户端 |
| [tianting-android](https://github.com/leetonny001/tianting-android) | Android 客户端 |
| [tianting-ios](https://github.com/leetonny001/tianting-ios) | iOS 客户端 |
| [tianting-admin](https://github.com/leetonny001/tianting-admin) | 管理后台 H5 |
| [tianting-ops](https://github.com/leetonny001/tianting-ops) | 运维后台 H5 |

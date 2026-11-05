# tianting-web

天听 H5 客户端（React + Vite），基于 [@tianting/sdk](https://github.com/leetonny001/tianting-sdk-ts)。信息架构参考常见 IM（消息 / 通讯录 / 我），视觉使用天听自有品牌（靛蓝 `#4C5FD5`）。需求：tianting-server 的 `docs/prd/PRD-ui-v1.0.md`、`PRD-core-v1.3.md`，任务单 `docs/tasks/frontend.md`、`frontend-ui.md`。

## 现状（M4 Web）

- 已有：M3 全部页面和社交页面；群管理（发起群聊、群设置、公告、成员、邀请、提示消息）；封禁、消息删除、禁言提示；宽屏三栏（`src/lib/layout.ts`，跨过宽屏条件时不改路由、不重连、输入框实例不变）、右侧侧板、键盘操作与焦点陷阱（`src/lib/focus.ts`）；深色模式与外观设置（首帧前由同源 `public/theme-init.js` 设置 `data-theme`，CSP 不放宽）；系统 emoji 面板；草稿（只在内存，`src/im/drafts.ts`）；右键菜单与删除失败消息。
- 质量：组件测试（Vitest + FakeTransport）；端到端测试（真实 im-server，默认手机视口，`e2e/wide.spec.ts` 用宽屏上下文），含 axe 浅色 / 深色扫描、500 个会话渲染性能、生产构建 CSP 响应头。
- 系统通知：横幅、`/me/notices` 列表、"我"页未查看数（`src/im/notices.ts`，PRD-ui F-UI-44、PRD-live F-PUSH-12）。列表只在内存，刷新后靠回放恢复；`localStorage` 只有 `ui.noticeSeen.{userId}` 这一个数字，退出登录时删除。
- 待做：全群禁言提示（P1）、PC 客户端（tianting-desktop）。

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
npm run build && node scripts/check-bundle.mjs && node scripts/check-dist.mjs && node scripts/check-assets.mjs   # 首屏 JS ≤ 200KB；CSP、theme-init、无管理密钥字符串、无 source map；无大位图、svg 在图标清单内
```

本地启动服务端（另一个终端）：`cd ../im-mvp/server && IM_TEST_MODE=1 IM_DEMO_LOGIN=1 IM_ALLOWED_ORIGINS=http://localhost:5173 go run ./cmd/im-server`。系统推送默认关闭，要试系统通知加 `IM_PUSH_ENABLED=1`（关闭时 SDK 静默忽略 4001，界面没有通知）。

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

# tianting-web

天听 H5 客户端（React），UI 参考微信。**天听**是自研 IM 平台，替换腾讯 IM（聊天、群聊、聊天室、站内推送）。

天听的 H5 客户端：登录、会话列表、聊天页（单聊 / 群聊）、通讯录、好友、我；同一套代码也是 PC 端（tianting-desktop）的界面。

| | |
|---|---|
| 状态 | 尚未开始，排在工作队列 Q13（M3，分享会最低演示） |
| 技术 | React + Vite，接入 `@tianting/sdk`（tianting-sdk-ts），Playwright 端到端测试 |
| 服务端、协议、需求文档 | [tianting-server](https://github.com/leetonny001/tianting-server) |
| 工作队列 / 日报 | tianting-server 的 `docs/process/QUEUE.md`、`docs/reports/daily/` |

需求：tianting-server 的 `docs/prd/PRD-core-v1.2.md`、`PRD-ui`、`PRD-social`。

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

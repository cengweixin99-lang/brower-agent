# Browse Agent

按 Figma 布局实现的任务控制台，已接通真实网页采集、暂停/继续、停止和刷新恢复。前端 → API → Temporal → activity → browser-worker → Chromium；任务、事件和来源存入 PostgreSQL，截图存入 `.data/artifacts`。

## 开发环境

使用 **Node 24（24.12 及以上的 24.x）和 pnpm 11.25.0**，启动 Docker Desktop。直接依赖固定版本，生命周期脚本默认禁用。

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm env:init
pnpm browser:install
pnpm infra:up
pnpm dev
```

访问 [任务控制台](http://127.0.0.1:5173)。数据库密码由 `env:init` 随机生成；服务间凭据自动生成到 `.data/gateway-token`（仅本机开发），均不会提交 Git。浏览器安装为显式命令，使用 `.data/browsers` 中的完整 Chromium。

| 服务          | 地址                  |
| ------------- | --------------------- |
| Web           | http://127.0.0.1:5173 |
| API           | http://127.0.0.1:3100 |
| 浏览器网关    | http://127.0.0.1:3101 |
| Temporal UI   | http://127.0.0.1:8233 |
| Temporal gRPC | 127.0.0.1:7233        |
| PostgreSQL    | 127.0.0.1:55433       |

## 使用

1. 输入任务描述和 **1–5 个明确的 HTTP(S) 页面网址**，点击 Run Task。例如：`Capture the text and headings from https://example.com`。
2. 查看真实活动日志、已采集页面截图和正文。每个页面成功采集后保存进度。
3. 新建任务支持 Pause：当前页面保存后进入 Paused，保留会话占用；Resume 从下一张未完成页面继续。暂停期间耗时冻结，刷新或重启服务也不会自动继续。
4. 点击 Stop，确认后进入 Stopping；浏览器实际关闭、释放执行槽后显示 Stopped。已完成的页面和报告可下载，停止后的任务不会继续或重新运行。
5. 刷新或重新打开 `#task/<id>` 恢复服务器状态。历史列表按创建时间倒序显示，每页 8 条。重复提交同一请求 ID 不会创建重复任务。

本轮是**只读网页采集闭环**，不会调用付费模型。报告是网页原文摘录，不是 AI 分析或推荐。页面 JavaScript、登录态和写操作禁用；需要登录或 JavaScript 的站点可能采集失败或内容不完整。追问、附件、模型总结、定时任务、多会话和 Notion 发布在界面中明确标记为未开放。

任务不是存在浏览器内存里的演示数据。停止本地服务会中断执行；重新启动服务后，Temporal 和数据库记录用于恢复。截图依赖本地 `.data/artifacts`，需与数据库一起备份。

## 验证

```sh
pnpm check
pnpm test:tasks
pnpm --filter @pba/web exec vite build
# 以下检查需要 pnpm dev 正在运行
pnpm smoke:web
pnpm smoke:workflow
```

`test:tasks` 要求数据库和 Temporal 已启动，会自行启动隔离的 API、浏览器网关、worker、Vite 和本地快/慢网页。使用独立数据库 schema、任务队列和端口（33100、33101、5174），不调用模型、不访问付费服务。覆盖真实采集、幂等提交、暂停/继续及会话占用、停止确认/取消、后期停止、部分结果保留、刷新/历史一致性、API/worker/gateway 重启和失败状态。测试日志、截图都在被忽略的 `.data` 内。

Ctrl+C 停止开发进程。`pnpm infra:down` 停止基础设施并保留数据卷。应用仅用于本机开发；尚未实现多用户认证和生产部署。

实现细节见 [任务执行说明](docs/task-execution.md)、[架构](docs/architecture.md)。Figma 原始参数保存在 `docs/figma/`；本轮插件额度受限，沿用已保存的参数、字体和图标，没有重新声称核实全部设计画板。

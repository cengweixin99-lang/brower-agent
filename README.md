# Pi Browser Agent

基于 pi 的跨站浏览器 Agent 开发骨架。当前已配置 pnpm workspace、React/Vite 控制台、Fastify 健康接口、Temporal 环境验证流程、PostgreSQL 和 Playwright。

## 环境

- Node 24.22.1（支持 Node 24.12 及以上的 24.x）
- pnpm 11.25.0
- Docker Desktop，使用 Linux containers

直接依赖固定版本，安装脚本默认禁用。此项目独立于 E:\workspace\pi。

## 首次准备

```powershell
cd E:\pi-browser-agent
pnpm install --ignore-scripts --frozen-lockfile
pnpm env:init
pnpm browser:install
pnpm infra:up
```

首次初始化已生成 .env，数据库使用随机本地密码。不要提交 .env。浏览器安装是显式命令，不依赖 npm 生命周期脚本。浏览器缓存位于项目的 .data/browsers，下载和浏览器临时文件位于 .data/tmp，均保存在 E 盘。使用完整 Chromium 的 headless 模式，不额外下载 Headless Shell。

## 启动

```powershell
pnpm infra:up
pnpm dev
```

| 服务               | 地址                          |
| ------------------ | ----------------------------- |
| Web                | http://127.0.0.1:5173         |
| API 健康检查       | http://127.0.0.1:3100/healthz |
| 浏览器服务健康检查 | http://127.0.0.1:3101/healthz |
| Temporal UI        | http://127.0.0.1:8233         |
| Temporal gRPC      | 127.0.0.1:7233                |
| PostgreSQL         | 127.0.0.1:55433               |

所有服务仅用于本机开发。健康接口只表示进程在线，不代表浏览器任务功能已完成。

## 验证

```powershell
pnpm check
pnpm smoke:pi
pnpm smoke:browser
pnpm smoke:infra
# 以下检查需要 pnpm dev 正在运行
pnpm smoke:workflow
pnpm smoke:http
pnpm smoke:web
```

这些检查不调用付费模型。浏览器检查使用本地内存页面，流程检查只执行环境诊断 activity。

## 目录

- apps/web：开发控制台。
- apps/api：用户 API 入口，目前提供健康检查。
- apps/worker：Temporal workflow 和 activity。
- apps/browser-worker：浏览器服务入口，目前提供健康检查。
- packages/agent：pi 运行时与工具适配扩展位置。
- packages/browser：Playwright 与浏览器验证脚本。
- packages/contracts、policy、credentials、persistence、telemetry：协议、策略、凭据、存储、观测。
- evals、tests：能力评测和跨服务测试目录。
- infra/local：本地数据库与 Temporal。

## 当前边界

这是开发环境初始化，不是可投产的浏览器 Agent。业务任务循环、受控浏览器 RPC、动作账本、审批、账号隔离、人工接管、生产部署均待实现。没有配置模型密钥，也不会自动向模型发送请求。

Ctrl+C 停止开发进程。运行 pnpm infra:down 停止本地基础设施并保留数据卷。

初始化验证记录见 [docs/environment-validation.md](docs/environment-validation.md)。

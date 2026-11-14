# 任务执行闭环 · 2026-11-13

本轮将 Figma 控制台的内存演示替换为真实只读执行。设计沿用已捕获的 220px 侧栏、64px 顶栏、Geist 字体、原始 SVG 图标及双列工作区；动态内容以真实任务为准。尚未接通的控件禁用并说明，不再显示模拟模型、假历史记录或假报告。

## 已实现

| 入口      | 行为                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| 新建任务  | 描述中提取 1–5 个 HTTP(S) URL；持久化后提交 Temporal；相同 ID/描述幂等，冲突描述拒绝 |
| 工作区    | 真实事件、时间、进度、页面截图、正文；来源每页独立保存                               |
| 停止      | 二次确认；取消保持运行；请求成功先 Stopping，浏览器关闭后 Stopped；部分结果保留      |
| 刷新/重开 | URL 中携带任务 ID，读取数据库；不重新提交任务；旧轮询响应不能覆盖较新版本            |
| 历史      | 实际记录、倒序、搜索/日期/所有状态筛选、8 条分页、详情与真实报告下载                 |
| 会话      | 网关健康与实际执行槽占用；结束/停止释放占用，服务连接状态独立显示                    |
| 异常      | 未连通时保留最后状态并重连；HTTP/采集失败入库；进程重启恢复任务/停止意图             |

## 接口

- `POST /tasks`：`{ id: UUID, prompt: string }`；202 为已接受，不代表执行完成。
- `GET /tasks`：任务摘要，创建时间倒序。
- `GET /tasks/:id`：完整状态、单调版本、事件、来源。
- `POST /tasks/:id/pause`：持久化暂停意图；当前页在执行则 Pausing，提交页面后 Paused。
- `POST /tasks/:id/resume`：仅从 Paused 继续；重复请求、终态上的请求不重跑任务。
- `POST /tasks/:id/stop`：幂等停止意图；终态保持原样。
- `GET /tasks/:id/report`：真实来源 TXT；运行/停止任务也可下载已保存部分。
- `GET /tasks/:id/sources/:source/screenshot`：对应实际采集 PNG。
- `GET /runtime`：网关、任务队列和占用任务；不把健康检查当作任务完成。

前端通过 Vite `/api` 代理访问。浏览器 `/read` 只允许带网关凭据的服务端调用；页面不得直接调用 Playwright 或网关。

兼容本机代理的 Fake-IP DNS：仅当域名全部解析为 198.18/15 时，向 Cloudflare HTTPS DNS 查询该域名的真实公网 IPv4，再校验并固定连接地址；不会放开该特殊地址段。普通私网地址仍被拒绝。

## 持久化与恢复

`tasks` 保存版本化任务及事件、来源；`browser_leases` 保存执行槽；`browser_actions` 记录每个页面动作。任务数据保存在 Postgres Docker 数据卷，Temporal 历史也有独立数据卷；截图在 `.data/artifacts`。只刷新浏览器不会改变执行。API 崩溃后补派尚未发起的任务；worker 重启由 Temporal 继续；browser-worker 重启清理已中断的只读动作并遵守停止意图。

停止与完成竞争时，以数据库行锁下先提交的状态为准：完成已提交则保持 Completed；停止先提交则不得提交新的页面或覆盖为 Completed。停止本身不会删已保存结果。

## 暂停与继续

新建任务使用独立的 `executePausableTask` 工作流类型，旧任务继续沿用原工作流，避免破坏 Temporal 已保存的执行历史。升级前启动的任务仍可停止，但不能使用暂停。

暂停采用页面检查点：当前页完成后保存正文/截图，关闭页面上下文并保留 Personal 会话的占用；下一页不会开始。未开始的任务可以立即暂停，不抢占其他任务的会话。恢复时先读取已保存来源，跳过完成页面。最后一页已成功采集则直接完成；采集失败仍显示真实失败；停止优先于暂停。

Paused 状态、累计暂停时间和会话保留均入库。网关重启会恢复保留占用；中断的 Pausing 转为 Paused，等待用户继续。Stop 可从 Pausing/Paused 发起，释放会话。后台等待使用 Temporal 定时器，定期 continue-as-new 限制历史增长，不占着一个长时间运行的 activity。

## 配置

- `.env.example` 的数据库/Temporal/本地端口配置沿用现有约定。
- `BROWSER_GATEWAY_TOKEN`：可选，替代自动生成的 `.data/gateway-token`。
- `BROWSER_GATEWAY_URL`：activity 使用的网关地址，默认本机 BROWSER_PORT。
- `BROWSER_ALLOWED_ORIGINS`：仅供可信本地测试的精确 origin 列表，默认空。不应为不可信输入自动开启。
- `WEB_ORIGINS`：额外允许的本地 Web origin，默认只允许本机 5173/API 端口。

## 本轮范围

实际执行器是指定网页的只读采集，未接 AI 自主搜索/推理。原型中的价格比较、建议、发布审批等内容不再用固定示例冒充结果。JavaScript 和登录未开放；下一阶段应在这个持久化/停止边界上接入 pi 模型规划、更多浏览工具及审批，之后再接外部发布。

自动化验收入口为 `pnpm test:tasks`。UI 截图输出至 `.data/screenshots/task-loop/`，日志至 `.data/test-logs/`。这些文件不会进入 Git。

# P03 运行存储与持续浏览器会话

2026-11-13。已实现通用运行持久化与内部网关会话管理；前端和 Temporal 通用循环尚未接入，旧采集任务仍按原路径执行。

**持久化与迁移**

`@pba/persistence/runtime` 导出 `RuntimeStore`。`initialize()` 使用现有数据库池和事务连接，自动运行有版本、SHA-256 checksum 和数据库锁的增量迁移。旧表不删除、不重命名；迁移 checksum 不一致或数据库版本超前时拒绝启动，禁止默默修改已应用的迁移。

迁移 1 创建 agent_tasks、agent_runs、agent_sessions、agent_commands、agent_events、agent_outbox，以及 agent_schema_migrations。状态、版本、代次、时间和引用使用独立列；任务定义保存在本地数据库 JSONB 中，不写入日志或 Git。工作区组合外键防止关联到其他工作区的任务/会话。步骤、观察、动作账本和加密产物引用由 P04–P07 增量增加，当前 checkpointStepId 为 null。

创建任务/运行幂等；同 ID 参数不同则拒绝。任务和事件/outbox 同一事务提交，outbox 消费与 Temporal 调度留到 P07。停止命令保存 command ID、预期版本及原始回执；重复命令返回原回执，同 ID 参数冲突拒绝。调用方应结合返回的 current 快照及版本显示状态。

**会话生命周期**

会话持久状态为 opening → active → closed；异常所有权丢失后可能进入 quarantined。租约包含工作区、运行、session ID、gateway owner ID 和执行代次；默认有效期 10 秒，网关每 250 毫秒检查本机持有会话并续租。过期租约不再续租，也不会自动交给另一个执行者。

同一 run 重复打开会复用已有 BrowserContext、Page 和 tab ID，不再次访问起始页面。运行只有一个会话和一个标签页；跨运行不复用登录身份。停止先持久化意图并递增执行代次，再中断请求、关闭真实上下文，最后提交 stopped。数据库或会话所有权不可用时关闭本地上下文；没有持久化释放确认则保留占用记录。

新会话和旧采集共用单个 Personal 执行槽。新旧准入在同一个 schema 级事务锁下检查；新会话表的部分唯一索引保证未关闭会话只有一个。旧任务暂停保留的槽位同样阻止新会话启动。

**内部接口**

全部接口复用网关 bearer 认证，仅供受信服务调用，不能暴露给 Web 或作为多租户公网 API。新运行目前由 RuntimeStore 创建，尚无公共创建入口。

| 接口                            | 请求                                                            | 行为                                                                                   |
| ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /runtime/sessions/open`   | protocolVersion、workspaceId、runId、executionEpoch             | 从数据库取任务起始 URL，保留会话槽、打开持续上下文并转为 running；重复调用复用现有页面 |
| `POST /runtime/sessions/status` | 同上                                                            | 验证归属与代次后返回 session、tabId、URL、title；不是 P04 的完整页面观察               |
| `POST /runtime/sessions/stop`   | protocolVersion、workspaceId、runId、commandId、expectedVersion | 保存停止命令，关闭本机拥有的会话，返回 accepted 回执和 current 快照                    |

不接收外部传入的 owner ID、任意上下文参数或浏览器脚本。当前静态加载仍禁用页面 JavaScript、Cookie 转发、下载和非 GET 请求，并限制到任务允许的 origin；重定向重新检查。私网还需网关显式测试白名单。P05 开放通用交互前必须实现对应网络与动作策略，不直接删除这些限制。

**故障与恢复的实际语义**

- 服务或客户端重新读取运行：从 PostgreSQL 返回既有状态，不新建任务、不重复导航。
- 网关正常关闭：关闭持续上下文后保存 failed/session_closed；若已有 stop 意图则保存 stopped。本阶段不宣称重启后可恢复浏览器内存。
- 网关丢失独占数据库连接：关闭 Chromium 后退出，避免失去所有权仍操作。
- 新网关启动：先取得 schema 独占锁，再把其他 owner 遗留的 opening/active 会话标记为 quarantined，记录 session_lost 事件。该槽仍不可用；已有停止请求继续保持 stopping。
- 隔离确认：必须由可信控制方确认旧浏览器已关闭或隔离后，调用内部 `RuntimeStore.closed()` 释放记录。没有对外提供“强制释放”接口。测试通过终止旧 owner 连接、等待其关闭浏览器并退出后完成此确认；生产隔离控制器与操作流程留在后续阶段。

因此，租约过期或旧网关进程消失本身不会被误当作浏览器已经停止。未完成隔离确认时，安全地阻止新运行是预期行为。

**验证**

运行 `pnpm test:sessions`，需要现有 PostgreSQL 与本地 Chromium，不需要模型或 Temporal。使用随机端口和独立数据库 schema；浏览器操作全部经过真实 browser-worker 网关，测试代码不直接驱动 Playwright。

15 项检查（含子测试）覆盖：并发迁移和 checksum、幂等与冲突回滚、状态重读、停止回执、工作区引用、新旧互斥、并发占槽、租约过期与隔离、认证及参数拒绝、真实页面复用、加载中停止、禁止重定向、正常重启和 owner 连接故障。旧采集全链路另运行 `pnpm test:tasks`。

以上为 P03 验收基线。P04 已增加[页面观察、元素引用校验和截图存储](runtime-observations.md)，并扩展会话测试。完成记录和现有全量检查限制见 [开发计划](development-plan.md)。模型调用、动作账本、暂停/恢复的通用编排和前端接入仍在后续任务范围。

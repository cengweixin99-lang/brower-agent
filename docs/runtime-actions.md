# P05 动作网关与执行账本

2026-11-13。持续会话已支持真实 Chromium 的 navigate、click、fill、select、scroll、pressKey、wait、extract。一次动作完成后采集并保存新的页面观察，再返回回执。测试通过内部 HTTP 网关操作浏览器；agent 包没有引入 Playwright。

## 调用协议

`POST /runtime/sessions/action` 使用现有网关 bearer 认证，仅供受信服务调用。请求采用 contracts 的 ActionRequest：

- protocolVersion、workspaceId、runId、stepId、actionId。
- sessionId、tabId、executionEpoch，必须对应当前运行的持续会话。
- deadlineAt：毫秒时间戳，新动作的截止时间须在当前时间之后且不超过 30 秒。
- action：带类型的动作参数；元素动作必须使用最新观察中的 observationId/documentId/frameId/elementId，不接受任意选择器或脚本。

响应为 ActionReceipt：result 使用原有 ActionResult 协议；extractedText 为 extract 的有限长度结果，其他动作或失败时为 null。成功结果包含动作后的 observationId；调用方可从 RuntimeStore.latestObservation 取回对应最新快照。提取结果最多 10,000 字符，普通输入框、textarea 和 select 返回值，checkbox/radio 返回 checked 状态，其他目标返回可见文本。

最小调用顺序为创建 run → open → observe → action → 使用新观察构造下一动作。成功动作会更新观察版本，旧元素引用不能用于下一动作。公开 API 和前端接入仍在 P07–P09，当前没有增加用户界面的演示按钮。

## 执行范围

页面 JavaScript、Cookie 转发、下载和非 GET 网络请求继续禁用。网络沿用允许 origin、重定向复查、私网限制与 DNS 地址固定；这批提供原生 HTML 交互，不代表已经支持任意动态网站。

| 动作     | 当前行为与边界                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------- |
| navigate | 允许 origin 内的 HTTP(S) 页面，等待 load；网络规则仍逐请求生效                                     |
| click    | 同窗口普通链接、checkbox/radio、显式 button 类型控件、summary；禁用提交/重置及其他未列出的激活入口 |
| fill     | 普通文本类 input、number 和 textarea；拒绝只读、密码、文件和其他不支持的目标                       |
| select   | 原生 select 按 value 选择                                                                          |
| pressKey | 有界的 Tab/Escape/ArrowUp/ArrowDown；Enter 仅允许合规链接或 summary，不允许输入框隐式提交          |
| scroll   | 页面上下滚动，单次最多 4,000 px                                                                    |
| wait     | 可取消等待，单次最多 10 秒，受动作截止时间约束                                                     |
| extract  | 提取当前有效目标的文本或普通字段值，不重新匹配旧选择器                                             |

Playwright 执行前重新验证实时节点引用、页面变更和目标策略，采用正常可操作性检查，不使用 force click。链接 target（包括 base target）、下载链接和跨 origin 链接会被拦截。这个策略依赖页面脚本保持关闭；将来支持动态网站时必须一起扩展网络写入、事件副作用、审批和隔离规则，不能只切换 javaScriptEnabled。

## 去重与不确定结果

迁移 3 新增 agent_actions，主键为 workspace/run/action ID，记录 step、session、owner、执行代次、动作类型、截止时间、请求指纹和最终回执。迁移 1、2 的 SQL 不变。账本保存规范化请求的 SHA-256 指纹，不保存原始填写参数；显式 extract 的结果保存在本地数据库，仍需按数据敏感级别管理，不能视为通用脱敏。

同一 action ID 的并发请求共享进程内执行结果，后续重试从数据库返回原回执，网关重启或运行停止后也不会重新执行。重试必须发送原始完整请求，包括 stepId、deadlineAt；改参数沿用旧 ID 返回 409。

准入事务先锁 run，再核对 running、执行代次、session、owner 与有效租约，最后插入唯一执行记录。没有得到持久化准入确认就不调用浏览器。会话内观察与动作串行；数据库还禁止一个 run 同时存在多个未完成动作。

已保存准入但没有回执时，重试返回 unknown，不接管、不重新点击。执行过可能产生效果的动作后，如果导航中断、观察保存失败或结果无法确认，同样返回 unknown 并关闭会话；运行中有未完成或 unknown 动作时也拒绝新的动作 ID。终结回执不可被迟到响应覆盖。这里提供的是重复请求不再次派发的保证，不声称外部网站操作具有分布式 exactly-once 语义。

## 停止与截止时间

动作准入和 requestStop 共享 run 行锁：停止先提交则拒绝新准入；动作先获准则归为在途动作，由停止流程中断。派发浏览器前再检查本机撤销信号和截止时间。停止意图落库后递增执行代次，关闭浏览器 context、取消等待和网络请求；真实上下文关闭后才确认 stopped。

未派发动作及无外部效果的等待/提取可记录 cancelled/none；已经派发且效果不能确认的动作记录 unknown，不误报为“已回滚”。动作截止时间覆盖执行与后续观察，超时关闭会话，阻止 Playwright 自动等待结束后继续操作。动作回执保存失败也关闭会话并保留账本准入，不允许盲目重试。

浏览器已发生的导航或输入不会因为停止而自动撤销。暂停/继续、unknown 的人工验证与恢复，以及动作事件向 Temporal/前端的传递仍由后续阶段完成。

## 验证

使用 Node 24、pnpm 11.25.0，没有新依赖或付费模型调用。`pnpm test:sessions` 包含数据库与真实浏览器验证：

- 连续填写、读回值、选择、跨 iframe 填写、按键、滚动、等待、链接点击与导航。
- 6 个并发重复点击只切换一次 checkbox；重复回执一致、参数冲突拒绝、停止及网关重启后只重放历史结果。
- 过期观察、错误归属/会话/标签/代次/截止时间拒绝；GET 表单按钮、input submit、输入框 Enter 和非法 origin 被拦截，站点没有提交请求。
- 等待中停止、导航中停止、网络连接关闭、停止后拒绝新动作、超时隔离。
- 数据库并发准入、模拟回执丢失、unknown 阻断后续动作、停止后准入拒绝和迟到结果不可覆盖。

最终数量与检查基线见[开发计划](development-plan.md)。日志保存在 Git 忽略的 `.data/p05-*.log`。完整模型驱动 Agent 的验收仍待 P06–P10。

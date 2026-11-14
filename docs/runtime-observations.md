# P04 页面观察与历史证据

2026-11-13。在 P03 持续会话上实现页面观察。浏览器操作仍仅由 browser-worker 网关执行，agent 包不直接使用 Playwright；当前静态只读网络策略保持不变，未开放页面 JavaScript、通用交互动作或模型调用。

## 内部接口

以下接口使用现有网关 bearer 认证，仅供受信服务调用；workspace/run 归属检查不能替代后续公网用户鉴权。

| 接口                                     | 请求                                                | 返回                                           |
| ---------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `POST /runtime/sessions/observe`         | protocolVersion、workspaceId、runId、executionEpoch | 保存成功的 ObservationSnapshot                 |
| `POST /runtime/sessions/validate-target` | 同上，加 target                                     | 当前引用有效时返回 valid；失效或已撤销返回 409 |
| `POST /runtime/artifacts/read`           | protocolVersion、workspaceId、runId、artifactId     | 经归属与完整性校验的 PNG；不可用返回 404       |

观察返回既有 Observation 协议，外加会话内递增的 sequence、frame 树和 truncated 标记。Observation 包含运行/会话/标签页身份、执行代次、观察 ID、根文档 ID、采集时间、URL、标题、文本、截图产物 ID，以及 frame/element 引用。每个 frame 记录父级和自身文档 ID。请求不接受任意浏览器脚本、文件路径或外部 owner ID。

## 采集范围与上限

- 最多 20 个可见 frame、合计 1,000 个元素引用、30,000 个文本字符；每个 frame 最多检查 20,000 个 DOM 节点。超出时标记 truncated，不假装内容完整。
- 遍历普通 DOM 和可访问的 open shadow root，识别常见链接、按钮、输入框、选择框及部分 ARIA 角色。标签来自 label、ARIA、可见控件文本等；当前是受限的角色/名称提取，不是完整的浏览器可访问性树算法。
- 文本排除隐藏、inert、aria-hidden 内容及 textarea/select 内的值；元素引用排除禁用控件和密码框，不读取 input.value。关闭的 shadow root 不在支持范围内。
- 截图为当前 1280×800 视口 PNG，密码框遮黑，单张最多 5 MB。截图仍可能包含其他可见个人信息，以及视觉可见但 aria-hidden 的内容；这不是通用隐私脱敏器。

## 版本与元素引用

每次重新观察先废弃上一份实时引用。元素句柄仅保存在网关内存中，不序列化到数据库，不按保存的选择器重新匹配。target 绑定 observationId、根 documentId、frameId 和 elementId。

主页面或子 frame 导航、frame 附加/移除会改变页面代次；已观察 DOM 的节点、属性和文本变化由 MutationObserver 记录。采集文本与截图后复查代次和变更，发现变化则返回 observation_changed，调用方需要重新观察。校验时再次检查观察版本、实际节点存在、连接状态、禁用状态与可见性；CSS 将目标隐藏时，即使没有 DOM 变更，也拒绝该目标。

这个校验接口只说明检查时的引用状态，不预授权未来动作。P05 必须在动作准入和执行时重新核对代次、停止意图及目标，并处理检查后的页面变化、遮挡和可操作性。当前测试没有覆盖动态 JavaScript 应用，也不声称任意视觉变化都能被 MutationObserver 检测。

## 持久化与停止

迁移 2 增加 agent_observations、agent_artifacts 和会话 latest_observation_id，保留迁移 1 的原始 checksum。截图先以临时文件写入，再通过不可覆盖的原子链接发布到配置目录；默认 `.data/runtime-artifacts`，可由可信环境变量 RUNTIME_ARTIFACT_ROOT 修改。目录/文件创建权限分别为 0700/0600，不进入 Git。

随后在数据库事务内验证 run 正在运行、owner、执行代次、会话状态和有效租约；拒绝旧 sequence，一并写入观察、截图 metadata、最新观察指针及事件/outbox。停止先取得事务锁则后续观察提交被拒绝；观察先提交则保留为停止前的历史证据。事件只携带运行摘要，不复制页面文本或截图。

读取截图必须先找到对应 workspace/run 的已提交 metadata，并核对字节数与 SHA-256。文件损坏、文件缺失或归属不符均不返回图片。提交失败且已确认数据库没有记录时清理文件；数据库不可用或 COMMIT 回执不明确时保留文件，避免删除实际已经提交的证据。崩溃后的孤儿文件回收、存储保留期、加密对象存储及断电持久性保障留到生产阶段。

RuntimeStore.latestObservation 可在重新连接数据库后读回历史快照，停止后仍可读取历史截图；历史快照不能恢复浏览器句柄或让旧任务继续执行。公共 API、Temporal 通用编排和前端展示分别在后续阶段接入。

## 验证

使用 Node 24 和 pnpm 11.25.0，无新增依赖、无付费模型调用。

- `pnpm test:foundation`：46/46，新增快照 frame 树、引用一致性、参数边界与截图 metadata 校验。
- `pnpm test:sessions`：21/21，包含真实 Chromium 和独立数据库 schema；覆盖文本/iframe/截图、历史重读、归属隔离、文件篡改拒绝、主/子文档导航、CSS 隐藏目标、采集上限、过期 sequence 与停止后的写入拒绝，以及 P03 原有故障测试。
- `pnpm test:tasks`：8/8，旧采集与停止/恢复链路回归通过。TypeScript 与本批文件定向 Biome 检查通过。
- `pnpm check` 仍有此前两处 Markdown 格式错误及 51 条 CSS 警告；详情见[开发计划](development-plan.md)，不报告为全量通过。

本地日志在 `.data/p04-*.log`；测试截图 `.data/screenshots/p04-observation.png` 已检查，密码区域遮黑、iframe 内容可见。以上是观察基础设施验收，完整 Agent 能力仍待 P05–P10。

后续增量：[P05 动作网关](runtime-actions.md)已接入实时引用复查，并在动作完成后保存新的观察；以上测试数量保留为 P04 验收基线。

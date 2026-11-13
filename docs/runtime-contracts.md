# 通用运行协议与迁移基线

P01/P02 实现记录，2026-11-13。对应 [开发计划](development-plan.md) 的开发基线阶段。本文保留协议和迁移设计；后续已完成的运行存储与内部会话端点见 [P03 实现记录](runtime-sessions.md)。公共 API、前端和通用 Agent 循环尚未接入。

**协议入口和版本**

旧采集 DTO 继续从 `@pba/contracts` 导出。通用协议通过 `@pba/contracts/runtime` 导出，使用 `protocolVersion: 1`。新的运行模型使用 `executionVersion: 3`；旧任务的无版本/版本 2 及其 workflow 原样保留。

版本号分别表达传输协议和执行实现，不能混用。不支持的协议版本在边界直接拒绝，字段不隐式转换，额外字段和超出上限的内容被拒绝。ID 为最多 128 字符的受限标识，不允许路径字符；服务端生成业务 ID，模型不得提供 run、session、action 或执行代次。时间字段为整数 Unix 毫秒，时钟只在 I/O 边界读取。

| 导出                              | 用途与限制                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `parseAgentTask`                  | 用户目标、起始 URL、允许 origin、验收要求和预算；允许 origin 不等于网络授权，仍需策略和出口校验 |
| `parseAgentRun`                   | 运行身份、状态、等待原因、版本、执行代次及检查点引用；不是完整数据库行                          |
| `parseAgentStep`                  | 步骤身份、顺序、观察与决策/动作引用及阶段                                                       |
| `parseBrowserAction`              | navigate、click、fill、select、scroll、pressKey、wait、extract 八类有界动作                     |
| `parseActionRequest`              | 网关请求的服务端身份封装；解析通过不代表授权通过                                                |
| `parseObservation`                | 页面与 frame/元素引用、有限文本、截图 ID；检查重复元素                                          |
| `parseDecision`                   | 模型只返回 act、ask_user、finish；完成提议必须带证据引用，证据真实性由 verifier 检查            |
| `parseActionResult`               | 区分成功、失败、取消和未知；失败不得伪装未知副作用为未发生                                      |
| `matchesObservation`              | 检查工作区、运行、会话、标签页、代次、文档与元素归属；不能代替执行前 DOM 再校验                 |
| `transitionRun`、`canAdmitAction` | 无 I/O 的状态规则和准入前置条件；持久化侧必须在事务内调用                                       |
| `recoveryFor`                     | 返回复用结果、重新观察、核实或结束；safe_repeat 策略由服务端判定，不能由模型或工具名决定        |

初始默认预算为 40 步、60 次模型调用、100,000 tokens、10 分钟。当前仅定义和校验预算；实际扣减/预留在后续运行时实现。观察正文最多 30,000 字符、交互元素最多 1,000 个、单次 wait 最多 10 秒。fill 只携带普通任务文本，凭据引用与保密输入在内测阶段单独实现，当前不得向这个字段填入真实凭据。

首次导航前还没有网页观察，网关应以任务允许的初始 URL 创建页面；当前 Observation 只接受 HTTP(S) 文档。工具 JSON schema 和 pi 适配在 P06 实现，必须与这些边界解析器对齐。P01 不额外安装校验库，不改动依赖版本。

**状态转换表**

所有事件先校验 expectedVersion 与当前 version 相同，再校验可信调用方。成功转换递增 version；API 命令去重在持久化事务处理，不能靠重复调用 reducer 模拟幂等。

| 事件     | 允许来源状态                              | 新状态    | 可信调用方       | 必须满足的条件                                                       |
| -------- | ----------------------------------------- | --------- | ---------------- | -------------------------------------------------------------------- |
| start    | queued                                    | running   | worker           | 已获取正确会话与预算                                                 |
| pause    | queued、running                           | pausing   | API              | 接受命令后立即阻止新动作准入                                         |
| paused   | pausing                                   | paused    | worker / gateway | 无在途执行；执行代次递增                                             |
| resume   | paused                                    | queued    | API              | 重新走会话分配和观察，不直接复用旧动作                               |
| wait     | running                                   | waiting   | worker           | 无在途执行；记录原因；执行代次递增                                   |
| continue | waiting                                   | queued    | worker           | 持久化待处理请求已经解决，原因匹配；不能由未经核验的用户输入直接触发 |
| stop     | queued、running、waiting、pausing、paused | stopping  | API              | 执行代次递增，网关撤销旧代次权限                                     |
| stopped  | stopping                                  | stopped   | worker / gateway | 执行结束或执行环境隔离已被确认                                       |
| complete | running、pausing                          | completed | worker           | 执行已停止，目标证据已核实                                           |
| fail     | queued、running、waiting、pausing、paused | failed    | worker           | 无在途执行；保留失败原因与部分结果                                   |

终态不可转换；已经接受 stop 的运行不能被迟到 complete/fail 覆盖。waiting 不提供 pause/resume 捷径，防止绕过审批。界面应展示对应输入/审批/接管操作，并保留 Stop。暂停中的最终动作确实完成目标时可以完成，但在途动作或未核实证据不能结束任务。

`actor`、`quiescent`、`evidenceVerified`、`resolvedReason` 都是内部可信事实。API 不允许客户端直接提交这些字段；P03/P07 从租约、动作和审批记录构造事件。当前纯函数不提供鉴权、数据库锁、去重、租约或实际取消能力。

**动作记录与重试**

持久化动作采用 proposed → authorized → executing → succeeded/failed/cancelled/unknown。未知结果只能经独立核实事件变为已核实结果，保留原始执行记录；不能重新派发同一外部副作用来“确认”。提议和授权是后续数据库记录阶段，目前解析器覆盖执行请求和结果。

- 已保存成功结果直接复用；activity 重试沿用 action ID。
- 未知结果或已确认存在副作用时先核实，即使动作被配置为可重复也不直接重做。
- 无副作用的可重复动作失败后重新观察；重新规划生成新的业务 action，运输重试仍使用原 action ID。
- 策略拒绝、撤销或取消结束当前执行路径，不由通用重试器继续。
- gateway 准入必须同时检查身份归属、running 状态、执行代次、会话独占、截止时间、策略和观察。当前 helper 只负责其中明确命名的条件。

**P03 增量数据库迁移方案**

现有 `tasks`、`browser_leases`、`browser_actions` 不做原地语义替换。P03 使用有版本和 checksum 的 SQL 迁移记录，已实现运行、会话、命令、事件和 outbox 表；下表是完整目标结构，步骤、动作、观察及产物按后续任务增量增加。P01/P02 批次未执行迁移，P03 的实际字段与约束以迁移代码为准。

| 表                                   | 主要字段                                                                                                                     | 约束与索引                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| agent_tasks                          | workspace_id、task_id、goal/约束的受控引用、created_at                                                                       | 工作区与任务组合主键；创建幂等键；工作区时间分页索引              |
| agent_runs                           | workspace_id、run_id、task_id、状态、version、execution_epoch、execution_version、session_id、checkpoint_step_id、预算与时间 | 工作区组合外键；终态不可重开；等待原因与状态一致；待执行队列索引  |
| agent_steps                          | workspace_id、run_id、step_id、sequence、观察/决策/动作引用、phase                                                           | 同一 run 的 sequence 唯一；检查点只引用同一运行                   |
| agent_actions                        | workspace_id、run_id、action_id、step_id、请求摘要/受控引用、代次、状态、结果/观察引用                                       | action_id 稳定唯一；同 ID 不同 payload 拒绝；按运行和执行状态索引 |
| agent_sessions                       | workspace_id、session_id、profile 引用、owner_run_id、代次、执行节点、租约和隔离状态                                         | 同一身份单一有效 owner；过期不能直接替代隔离确认                  |
| agent_observations / agent_artifacts | workspace_id、run_id、ID、受控对象引用、类型、时间、完整性信息                                                               | 跨工作区引用拒绝；孤立对象可回收；不存公开文件路径                |
| agent_commands                       | workspace_id、run_id、command_id、请求摘要、处理结果、序号                                                                   | 同命令同参数返回既有结果；同 ID 参数冲突拒绝                      |
| agent_events / agent_outbox          | workspace_id、run_id、序号、类型、脱敏数据、投递状态                                                                         | 每 run 序号唯一；业务写入与事件/outbox 同事务；投递至少一次并去重 |

审批与用户输入表在相关交互阶段增加，P03 预留请求引用但不实现空壳审批服务。JSONB 用于受限扩展参数，查询和一致性约束放在独立列。新运行 ID 推荐 UUID；协议接受可读测试 ID 不影响生产生成策略。

事务顺序：锁运行 → 命令去重/版本校验 → 读取会话与动作事实 → 调用纯状态规则 → 写运行/事件/outbox → 提交。动作准入使用同一运行锁及一致的会话锁顺序，与 stop 串行；浏览器 I/O 在提交后执行，不持有长数据库事务。发生外部执行与本地提交间故障时记录 unknown 并核实。

检查点、步骤、动作和观察采用先插入记录再设置引用的事务，保证组合外键指向同一 workspace/run。已有任务不必批量迁入新表；历史通过 API 适配读取，新任务显式选择 executionVersion 3。暂停/恢复和停止仍按各自版本路由，旧 workflow 保持可重放。

回退先关闭新任务入口并排空或停止新运行，再切回旧创建路径。不能通过 DROP 新表“回滚”已发生的执行；迁移先做向后兼容的增加，清理另行发布。

**P02 受控网站与评测约定**

`tests/fixtures/sites/demo.ts` 提供本机随机端口测试服务和独立 attempt。站点包含服务点目录/详情、商品筛选/详情、联系表单。所有数据为虚构测试内容，证据通过进程内 getter 获取，没有暴露给浏览器的答案或证据接口。

`evals/tasks/demo.ts` 定义三类各 10 个任务；`evals/graders/demo.ts` 根据来源访问、答案/引用、筛选参数、最终详情及表单草稿/提交计数判分。每次 attempt 独立，读取证据返回副本。预期答案仅供评测器，后续 runner 只给 Agent 目标和入口 URL。

当前 `pnpm test:foundation` 用 HTTP 测试站点与判分器，并覆盖正反结果、来源错误、缺失筛选、错字段、误提交、请求隔离和草稿乱序。表单浏览器脚本通过语法校验，但尚未用通用浏览器执行器自动填写；P05/P10 接入真实交互时需要额外核对 DOM 与站点记录。44 项通过表示基础代码和评测设施通过，不是 Agent 完成了 30 个任务。

**本批次验证记录**

开始实现前，旧 `pnpm test:tasks` 的 6 项单元测试和 2 项数据库/全链路测试通过。`pnpm check` 已存在两处错误：`docs/figma/prototype-review.md` 与 `docs/prd.md` 的格式，以及 51 条既有 CSS 警告。日志位于忽略目录 `.data/p01-baseline-check.log` 和 `.data/p01-baseline-tests.log`，未为消除基线错误修改无关文件。

本批次最终检查结果与 P01/P02 状态记录在开发计划中。整个批次不调用模型提供商，不存储真实凭据，不提交 Git。

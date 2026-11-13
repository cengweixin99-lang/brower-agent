# Browse Agent 原型操作评审

日期：2026 年 11 月 12 日  
对象：[Figma 原型](https://www.figma.com/proto/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-235&starting-point-node-id=8%3A235)  
首次评审方式：在 Chrome 中实际点击原型，观察画面、热点及目标画板；首次评审没有修改设计。后续实际写入及验证记录见本文后半部分。

## 结论

主流程已经能演示创建、执行、暂停、恢复、停止、审批和完成。当前最需要补的是跨画板的数据一致性、历史和辅助控件的交互，以及失败与处理中状态。建议先补齐这些，再按原型实施正式前端。

本次检查的是可点击流程，不代表重新取得全部 51 个画板的精确参数。“未响应”仅指在本次测试的画板上点击后没有可见变化，不等于该功能在整个文件中绝对不存在。新增画板建议是产品补充，不是假称已看到的设计。

## 已实际走通的路径

| 路径                                                       | 实际结果                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 空任务 → 模板或 Run Task → 已填任务 → Run Task             | 进入 Thinking；空任务的 Run Task 只是填入演示任务                    |
| 搜索阶段 Pause → History → Browser Sessions → View browser | 仍返回搜索阶段的 Paused 状态，没有意外恢复                           |
| 搜索阶段 Resume                                            | 回到搜索执行，之后自动进入后续执行画板                               |
| Linear 提取阶段 Pause → Asana 标签 → Resume                | 标签切换后仍保持暂停，恢复后显示 Asana 执行页                        |
| Research sandbox 的 Resume session → 离开会话页 → 返回     | Connected 状态在该次导航中保留；Stop session 可切回 Stopped          |
| 审批 Reject                                                | 任务显示 Completed，报告保留在当前工作台，没有对外提交               |
| 本地完成 → Save to Notion                                  | 重新进入审批页                                                       |
| 审批 Approve → History                                     | 进入模拟发布完成页；历史首行显示 Completed，耗时 01:06，与完成页一致 |
| 早期执行 Stop → Run again                                  | 进入停止页，Run again 直接从 Thinking 重新开始                       |

## 应优先修正的状态一致性

### R01 暂停状态仍显示工具正在执行

在 [Linear 暂停页 8:2325](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-2325)，顶部为 Paused，底部写着 Agent paused，但 `browser.extract` 卡片右下仍是 Executing。Asana 暂停页也出现同样表述。

建议区分 Pausing 与 Paused：若当前动作尚未结束，显示“正在暂停，等待当前动作结束”；确认暂停后，工具卡片应显示对应的已暂停或已完成状态。不能让用户同时理解为“已停止执行”和“正在执行”。这是开发前应解决的问题。

### R02 早期停止展示了尚未发生的浏览器进度

重新启动后在早期阶段点击 Stop，会进入 [停止页 8:3792](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-3792)，右侧直接显示 Linear 定价页和三个网站页签，左侧原有执行记录被通用停止说明替代。

建议停止页保留停止当时的浏览器画面、事件记录和已有产物，并显示停止阶段、时间及后续操作。可用状态变量复用同一页面，也可补充早期停止、提取中停止和审批前停止三个代表状态；不要让所有 Stop 共用固定的提取结果画面。

### R03 同一任务的时间与页签在跨页时不一致

复现路径：搜索阶段暂停 → History → Browser Sessions → View browser。

- [搜索暂停页 8:1825](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-1825) 为 `00:05`，只有 Google 搜索页。
- [对应历史页 8:7763](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-7763) 同一研究任务为 `00:42`。
- [对应会话页 8:7989](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-7989) 却已显示 Linear、Asana、Notion 三个定价页签。
- 发布完成后点 New Task，首页最近任务又显示研究任务为 Running。若该入口意在重置整个演示，应明确说明；正式产品的新建任务不应重置上一任务。

建议为任务阶段、耗时、当前页签和完成结果建立同一份演示状态，各页面引用一致数据。优先核对暂停、审批和结束状态跨页时的表现。

## 应补齐的操作设计

### R04 历史页需要可操作的查询和详情状态

在 `8:7763` 上点击 Completed、下一页、View full execution 没有可见响应；在 [已发布历史页 8:9359](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-9359) 点击失败任务 Submit partner application，也没有切换详情。热点提示只覆盖少数导航及当前研究任务。

建议至少补充：状态筛选后的列表、第二页、选中另一任务后的详情、完整执行记录、失败任务详情、筛选无结果。搜索、日期和下载规则也应写明，但本次没有把所有这些控件逐项点击完，不能将它们统一计为已复现缺陷。

暂停历史画板中 Running 计数为 0，而 Paused 行仍在 All 下；目前没有暂停或待审批的专门筛选入口。应明确分类，建议保留精确状态并提供补充筛选，而非让前端自行决定是否归入 Running。

### R05 新任务尚缺选择器与不同模板示例

从空任务页点击 Extract website data，进入的仍是比较 Linear、Asana、Notion 的同一条研究提示。已填任务页点击模型和会话选择器没有展开状态；空任务的 Run Task 则填入示例文本。

这些可以服务于单条演示，但不足以指导真实创建流程。建议补充各模板自己的示例、空输入禁用或错误提示、模型下拉、会话下拉、无可用会话、创建中及创建失败。模板若首版暂不支持，应明确标记，不要让它看起来已具备独立能力。

### R06 追加指令和辅助视图缺少反馈状态

在执行页点击追加指令区域没有出现输入或接收状态；在 Linear 暂停页点击 Screenshot、DOM Inspector，没有切换内容。

建议补充指令已填写、发送中、已接收、何时生效、发送失败五种状态。辅助视图需要各自的示例内容、快照时间、加载失败和空数据状态；若不在首版范围，应隐藏或标记暂不可用。

### R07 审批主线完整，但还缺提交过程和结果出口

[审批页 8:3072](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-3072) 已明确目标为 Notion 的 Personal workspace，动作为 Create a private page，并提供 Reject、Approve。目标和动作不是缺失项。

需要补充的是：完整提交内容预览、账号与目标位置的确认、批准后的提交中状态、失败或结果不确定状态，以及防止重复发布的反馈。当前数据预览主要是报告标题、摘要和三类工具概述，尚不足以逐项审阅最终比较表。

[发布完成页 8:3312](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-3312) 有成功说明和 New Task，但未看到打开已创建 Notion 页面、复制结果链接或导出的入口。建议至少补上 Open in Notion、复制链接及本地导出。

[本地完成页 8:3552](https://www.figma.com/design/gOulaRv0q2wSX5OVD0dIVo/Untitled?node-id=8-3552) 已有 Save to Notion 且能重新审批。应保留这一能力，并明确它是对已有报告发布，不是重新执行整次研究。当前画板从完成页 `01:06 / 6 of 6` 回到审批 `00:58 / Step 5 of 6`，容易被理解为研究进度回退，建议将发布进度与研究进度分开展示。

### R08 会话管理需要补运行异常和占用关系

沙盒会话的启停已能演示。Personal session 卡片只有 View browser 和占用任务说明，没有相同的停止控制；整页右上按钮是 New Task，不是 New Session。

建议明确个人会话是否允许手动停止；允许时补充停止运行中任务所用会话的处理，不允许时说明原因。另补连接中、连接失败、登录失效、无会话及被其他任务占用状态。新建、重命名、删除是否首版支持需要产品决策，不能从现有按钮推断。

## 建议新增的设计清单

| 优先级           | 建议补充                        | 完成标准                                                       |
| ---------------- | ------------------------------- | -------------------------------------------------------------- |
| 开发前           | 跨页状态与停止画面              | 同一任务的阶段、耗时、页签、工具状态一致；停止不展示未执行步骤 |
| 开发前           | 发布处理中、失败、结果待核对    | 能区分未提交、正在提交、已生效及需核对，研究报告始终可找回     |
| 开发前           | 失败任务详情与恢复              | 展示失败步骤、可理解原因、已有产物及重试或新建入口             |
| 首版前           | 新任务校验和两个选择器          | 空输入、不可用模型或会话、提交失败均有明确反馈                 |
| 首版前           | 历史筛选、分页与详情切换        | 点击有对应状态，筛选计数、选择项和详情一致                     |
| 首版前           | 报告完整预览与结果出口          | 可审阅将要发布的实际内容，成功后能打开结果或导出               |
| 首版前           | 追加指令与会话异常              | 能确认指令是否接收；会话断开时知道受影响任务和恢复方法         |
| 后续或明确不支持 | 截图、DOM、附件、定时及高级管理 | 有独立交互和异常状态，或清晰标记暂不可用                       |

## 对 PRD 的校正

本次浏览器实测补足了先前未核实的设计事实，已同步到 [PRD](../prd.md)：发布目标是 Notion 私有页面；Reject 保留工作台报告；Save to Notion 可以再次进入审批；Running 计数不包含本次暂停任务；会话页的主要新建按钮实际是 New Task。其余生产规则继续按补充建议标注。

原始精确参数快照没有被重写。本次截图证据保存在被 Git 忽略的 `.data/screenshots/figma-review/`，包括审批、本地保留、发布完成、搜索暂停、暂停历史、暂停提取及早期停止画面。

## 原型修复记录（2026-11-12，部分完成）

以下是评审后的实际写入记录；上文保留为修改前的评审事实。Figma 已保存命名版本 **Review fixes 01 · Early stop and publishing**。本轮没有修改前端代码，也没有将整份评审清单标为完成。

Figma MCP 返回 Starter 套餐调用上限，改用 Chrome 中的 Figma 编辑器完成修改。后续批量复制出现画布选择偏移，已通过 Figma 版本历史恢复完整保存点，再重新校准和验证下列保留内容。尝试过的后期停止画板及停止状态跨页浮层未保留，不属于交付内容。

### 已保留的画板与行为

| 画板 | 节点 | 实际修改 |
| --- | --- | --- |
| Stopped / Thinking | `41:4032` | 保留 00:01、Step 1、新标签页和原有计划；来源标记 Not started；提供 Run again 与 New Task |
| Stopped / Searching | `41:3798` | 保留 00:05、Step 2、Google 搜索页和搜索记录；明确未打开定价页；提供 Run again 与 New Task |
| Publishing / Submitting | `41:4266` | 单次提交中反馈；阻止重复发布；保留报告预览入口；延时进入模拟发布完成 |
| Publishing / Failed | `41:4650` | 演示发送前连接失败、未创建页面、报告已保留；Retry publishing 回到提交中 |
| Publishing / Result unknown | `41:4458` | 演示响应未确认、可能已创建页面；先 Check status，当前示例核对结果为已发布 |
| Report / Full preview | `41:4843` | 完整比较表、建议和来源；只读；Back 返回进入预览前的页面 |

- Linear、Asana、Notion 暂停页的工具状态由 Executing 改为 Paused。Thinking、Searching、Browsing 的暂停活动文案也与暂停状态对齐；尚未增加独立 Pausing 过渡状态。
- 搜索暂停历史页 `8:7763` 的首行耗时改为 00:05；会话页 `8:7989` 改为一个 Google 搜索标签，移除提前出现的 Asana、Notion 标签卡片。
- Thinking、Searching 的执行中和暂停后 Stop 分别接入对应早期停止画板。
- 审批页 `8:3072` 保持研究已完成（01:06、6/6、满进度），单独表示发布审批；账号示例为 Alex Morgan / Personal，目标为 Workspace root 的单个私有页面。
- 审批页增加完整报告预览；顶部 Keep locally 保留本地报告；Approve 进入提交中。原有 Reject 和本地报告重新发起审批的能力保留。

### 最终保存后重新验证的路径

1. 搜索暂停 → History（00:05、Paused）→ Browser Sessions（一个 Google 标签）→ View browser → Stop：进入搜索停止页，现场和时间正确。
2. 搜索停止 → Run again → Thinking → Stop：进入思考停止页，00:01、未打开任何网站；New Task 返回空任务页。
3. 审批 → 完整报告预览 → Back → Approve → Submitting → Published。
4. 发布失败 → View report → Back → Retry publishing → Submitting → Published。
5. 结果待核对 → Check status → Published。此处只是单一核对成功的原型示例，尚未补核对失败、仍不确定或确认未创建的后续分支。

最终截图在 `.data/screenshots/figma-repair/`：`stopped-search.jpg`、`stopped-thinking.jpg`、`report-preview.jpg`、`publish-failed.jpg`、`publish-unknown.jpg`。此前尝试后期停止时的截图（如 `stopped-asana.jpg`）不代表最终保留版本。

### 第一轮结束时仍未完成的内容

| 评审项 | 当前剩余工作 |
| --- | --- |
| R01 | Pausing 过渡状态及当前工具动作结束规则 |
| R02 | Browsing、Linear、Asana、Notion 的独立停止现场和记录；当前后期 Stop 仍使用原有通用停止页 |
| R03 | 新增停止/发布状态的侧边导航仍继承原画板上下文，跨页可能回到暂停或审批；其他阶段的时间、页签仍需核对；New Task 最近任务仍可能显示 Running |
| R04 | 历史筛选、分页、无结果、详情切换、失败任务详情与恢复、完整执行记录 |
| R05 | 模板差异、空输入校验、模型与会话选择器、创建中和创建失败 |
| R06 | 追加指令的输入/发送/接收/失败、Screenshot 和 DOM Inspector 的内容与异常反馈 |
| R07 | 结果核对的其他结局；发布后打开链接、复制链接和导出；发布状态跨页一致性 |
| R08 | 会话连接中、失败、失效、占用、无会话，以及停止使用中会话的处理 |

前端实施时应以这里的保留清单为本轮新增依据。原始 `manifest.json` 和精确参数 JSON 保持读取时快照，未声称已同步新增节点的完整精确参数。

## 第二轮修复进展（进行中）

用户明确选择通过「维鑫」账号继续编辑。该账号的 Figma MCP 仍返回 Starter 调用上限，本轮继续通过原生 Figma 编辑器修改，没有切换账号绕过限制。以下内容已写入；本轮尚未完成整份评审清单。

已保存命名版本：

- `Review fixes 02 · Late-stage stop branches`
- `Review fixes 03 · Stopped state across pages`
- `Review fixes 04 · Report and publishing navigation`
- `Review fixes 05 · Reconciliation and empty task`
- `Review fixes 06 · Selection feedback`

### 停止现场及跨页状态

新增可编辑停止画板：Browsing `49:5096`、Linear `49:4765`、Asana `49:4227`、Notion `49:4496`。对应执行中和暂停页的 Stop 已连接到各自停止画板；三个采集停止页之间的页签切换保留 Stopped。Browsing 保留 00:12、Step 3，明确未执行提取；采集页保留 00:42、Step 4、当前网站和部分采集数据。

Thinking、Searching、Browsing、Collection 分别有停止后的 History、Sessions、New Task 视图。历史耗时依次为 00:01、00:05、00:12、00:42。Thinking 会话无浏览活动，Searching 只显示 Google 搜索页。新任务入口的最近任务为灰色 Stopped。回访采用 Open overlay / Swap overlay / Close overlay，保留原任务和当前网站；Run again 仍接入原有演示执行主线。

已实际点击验证：

1. Asana 暂停 → Stop → New Task → History → Sessions → View browser：返回 Asana 停止页，始终保留 00:42。
2. Browsing 暂停 → Stop → History → Sessions → View browser：返回尚未提取的停止页，历史与现场均为 00:12。
3. Notion 暂停 → Stop → Asana → Linear：进入对应停止画板，未恢复执行。

### 报告完成与发布状态

新增共享回访视图：History / Report ready `49:7564`、Sessions / Report ready `49:7882`、New task / Report ready `49:8003`。研究完成时间保持 01:06，历史明确 Completed 指研究完成，发布结果在任务内单独展示。会话页展示保存的研究来源，避免将来源快照冒充当前发布页面。审批、提交中、失败、待核对、已发布、本地保留和完整预览的侧边导航已接入这些视图。

已验证：Result unknown → New Task → History → Sessions → Return to report，返回仍为 Needs review；Check status 成功后才进入 Published。

新增发布核对状态：Checking status `49:8594`、Check failed `49:8210`、Confirmed not created `49:8402`、Still pending `49:8786`。核对失败和仍待确认时阻止再次发布；确认未创建后才提供 Retry publishing。异常结果通过独立原型起点演示，主核对过程仍使用延时成功示例，尚未接入真实网络分支。Check failed → Checking → Published 已实测。

### 新任务反馈

新增 480 × 240 校验弹窗 Empty task `49:8978`，六个空任务上下文的 Run Task 改为显示错误反馈，关闭后保留底层任务状态；有遮罩、外部点击关闭和返回输入按钮，已实测。

新增 Model selection `49:8985`、Session selection `49:8990`，并在六个空任务上下文和原有已填任务页接入整个选择区域的点击。当前只展示已有可用选项 Sonnet 4.5 / Personal session，说明其他选项的可用条件；已验证打开及关闭。尚未演示切换到另一个可用模型或会话，不能将这些反馈窗口视为完整动态选择器。

### 仍需补齐与验证

- R01：独立 Pausing 状态与当前动作完成规则。
- R02/R03：其余阶段回访回归测试；进入原有已填任务画板后，最近任务仍可能继承原始 Running 示例，需要进一步处理。旧通用 Stopped 及旧历史入口也需最终清理连线。
- R04：筛选、分页、无结果、其他任务详情、完整执行和失败恢复。
- R05：不同模板、完整选项切换、无可用会话、创建中与创建失败。
- R06：追加指令的输入、发送、接收、失败，以及辅助视图的支持范围或反馈。
- R07：已补更多核对结果和跨页导航；仍缺结果打开、复制链接、导出，且需验证新异常演示起点及自动跳转期间的回访行为。
- R08：连接中、连接失败、登录失效、占用、无会话、停止使用中会话的规则。

本轮新截图位于 `.data/screenshots/figma-repair/`：`stopped-asana.jpg`（已覆盖旧的废弃尝试截图）、`stopped-browsing.jpg`、`stopped-new-task.jpg`、`stopped-history.jpg`、`publish-unknown-return.jpg`、`empty-task-validation.jpg`。未修改前端代码；原始参数快照仍未重写。

### 后续追加进展（截至保存版本 10，仍在继续）

后续保存了 `Review fixes 07 · History execution records`、`Review fixes 08 · Draft context and recovery`、`Review fixes 09 · Pausing and history navigation`、`Review fixes 10 · Outputs and follow-up instructions`。下面的进展更新上面的剩余项，不代表整份评审已经全部完成。

- **Pausing**：Linear `49:10087`、Asana `49:10419`、Notion `49:10689` 增加正在暂停状态，显示 Finishing current action；暂停按钮不可重复点击，1500 ms 后进入对应 Paused，期间仍可 Stop。三者页签互相连接到 Pausing。已实测 Notion 的 Running → Pausing → Paused → Stopped。
- **新任务上下文**：独立 Research draft 输入面板 `49:9783`（912 × 206）承接六种新任务上下文的输入和五类模板入口，Cancel 返回底层页面。已实测 Completed 任务打开草稿再取消，最近任务仍为 Completed。模板目前仍共用研究提示，尚未完成各模板差异。
- **历史筛选与记录**：20 个历史画板接入 Completed、Failed 筛选和完整执行记录。Completed list `49:9315` 包含当前已完成研究，共 21 条；Completed archive `49:9554` 排除当前未完成或停止任务，共 20 条。Failed list `49:9855` 展示 3 条失败记录。完整提取记录 `49:9029`、失败申请记录 `49:9023` 可打开和关闭。
- **失败恢复**：失败申请 → Reconnect session `49:9844` → Connecting `49:10073` → Review application `49:9836` → Application submitted `49:9849`，取消保留草稿，重试成功保留原失败尝试。另有 Connection failed `49:10080` 及重试目标；此异常画板的独立入口仍待完善。恢复的连接、审批、成功路径已经实际点击；连接使用演示延时，没有执行真实登录或外部申请提交。
- **历史分页和空结果**：Page 2 `49:10959`、Page 3 `49:11179` 接入全部 20 个历史页的下一页入口，前后翻页保留底层任务。各有独立的选中任务详情及完整记录：Job listings `49:11445`、Funding data `49:11451`。No results `49:11457` 接入 20 个搜索框，演示无匹配查询、零条计数和 Clear filters。已实测停止历史 → 第二页 → 第三页 → 第一页，任务仍为 Stopped / 00:42；清空搜索同样保留状态。筛选后的多页结果和所有行的详情切换尚未全部完成。
- **结果出口**：已发布页增加 Open in Notion、Copy link、Export report，本地报告增加 Export report。对应 Notion page preview `49:11611`、Link copied `49:11617`、Export ready `49:11622` 已实测打开和关闭。这些是 Figma 原型反馈，并没有创建真实 Notion 页面、修改系统剪贴板或生成实际导出文件。
- **追加指令**：Draft `49:11650`、Sending（节点 ID 未记录）、Received `49:11639`、Send failed `49:11658`；15 个运行、暂停及正在暂停的输入区域已接入。Scenario · Follow-up failure `49:11698` 提供独立异常演示起点。已实测暂停任务的填写 → 发送中 → 已接收 → 关闭，以及失败 → Retry → 已接收，任务继续 Paused。文案明确在下一安全步骤生效，暂停中等待 Resume，外部写入仍需审批。
- **辅助视图支持范围**：Screenshot 和 DOM Inspector 各 31 个匹配入口接入 Advanced view unavailable `49:12033`，明确本次原型首版不启用，并引导使用 Live Browser。已实测反馈窗口。

新增截图：`composer-cancel-preserves-completed.jpg`、`full-execution-record.jpg`、`recovery-approval.jpg`、`pausing-notion.jpg`、`history-page-3.jpg`、`history-no-results.jpg`、`published-result-actions.jpg`、`follow-up-received-paused.jpg`。

当前仍需收尾：独立模板示例、创建中/失败、会话无可用/被占用/手动停止规则；筛选结果的分页及其他记录选择；发布核对异常起点和自动跳转期间的回访回归；旧通用停止及旧直达历史入口的最终审计。所有新增静态数据和交互均为原型示例，未同步到原始精确参数快照，未改动前端代码。

### 第二轮后续交付（截至保存版本 14）

上述“仍需收尾”是版本 10 时的记录。后续已保存：

- `Review fixes 11 · Creation and session exceptions`
- `Review fixes 12 · Filtered history and failure records`
- `Review fixes 13 · Interaction regression fixes`
- `Review fixes 14 · Publishing return paths`

#### 新增与调整

| 范围 | 节点与实际行为 |
| --- | --- |
| 创建中、创建失败 | Creating `49:12105`、Failed `49:12111`、独立 Creation failure 场景 `49:12121`；失败保留草稿，Retry 经 Creating 进入执行，取消可退出。异常场景已扩为 1440 × 1000，避免弹窗被原 912 × 206 画幅裁切 |
| 创建依赖异常 | No available session `49:12147`、Session occupied `49:12152`、Model unavailable `49:12159`，各有独立演示起点与返回示例草稿的入口；这些不是根据真实模型或会话状态动态触发的校验 |
| 模板区分 | Comparison draft `49:12315`；Extract preview `49:12300`、Form preview `49:12305`、Summary preview `49:12310`。七个新任务页的后三类卡片标为 Preview only，并打开各自示例，不再跳到研究提示；研究与对比仍使用同一产品研究执行主线 |
| 个人会话规则 | Session stop rule `49:12100`，20 个会话说明卡片接入：Personal 暂不允许手动断开；停止任务释放占用，浏览器保持连接；暂停仍持有占用 |
| 连接失败场景 | Scenario / Connection failure `49:12166`，接入已有 Connection failed → Connecting → Review application → Application submitted；修正标题热点与按钮目标，保留原失败记录 |
| 完成筛选分页 | 20 条分支 Page 2 `49:12361`、Page 3 `49:13031`；21 条分支 Page 2 `49:12584`、Page 3 `49:12807`。两种首屏改为 1/3，分别展示 6 + 8 + 6 和 6 + 8 + 7 条；通过浮层返回保留任务上下文 |
| 失败记录 | CRM permission denied `49:13244`、Inventory timeout `49:13250`。失败列表三种原因分别有记录；20 个主历史页的 CRM 行也接入记录。权限失败不声称已修改联系人，超时明确发生在读取阶段，没有发出更新请求 |
| 查询与支持范围 | History query rules `49:13266`：当前演示只支持近 30 天，采用工作区时区，Paused / Awaiting approval 不计入 Running。主历史及后续分页接入日期反馈，九个分页/筛选面板补搜索空结果入口；Clear search 保留其他上下文 |
| 未开放能力 | Advanced features unavailable `49:13271`：附件、定时和高级会话管理暂未启用。七个新任务页的附件/定时区域，以及研究与对比草稿的附件区域已接入反馈；不能据此声称全部遗留侧栏入口均已补齐 |
| 提交中回访 | 实测发现 Figma 的 After delay 在浮层打断后不会继续自动完成。Submitting 因此补 Check status，只读核对同一次发布；Checking 补 Cancel check，返回 Result unknown，避免停在处理中无出口，或通过重发解决卡住 |

#### 新增实际验证

1. Notion Stopped → History → Completed 筛选 20 条 → 第二页 → 第三页 → 逐页返回 → Sessions → View browser：仍为 Notion、Stopped、00:42。
2. Stopped → New Task → Extract preview → 关闭：最近任务保持 Stopped；Compare products 显示独立草稿，经 Creating 进入演示执行。
3. 创建失败场景 → Retry → Creating → 执行。无可用会话场景的 Back to draft 可返回已填示例；该独立异常演示不会维护完整的动态会话可用性。
4. 连接失败 → Try again → Connecting → Review application → Approve & retry → Application submitted；原失败历史记录保留。CRM 权限失败、库存读取超时记录均已打开验证。
5. Confirmed not created → Retry → Submitting → History → 返回 → Check status；Checking → History → 返回 → Cancel check 后仍为 Needs review。再次 Check status 后进入 Published。Still pending 的 Check again 也进入只读 Checking。
6. Published → History → Completed 筛选 21 条 → 第三页 → 搜索空结果 → Clear search：回到 21 条分支第三页；日期说明可打开关闭。随后 New Task 的最近任务仍为 Completed。
7. 本地保留报告 → Export report → 反馈 → New Task：报告保持本地保留，最近任务为 Completed。新任务定时入口、会话规则说明均已实际打开验证。

修正了分页中长标题挤压日期列的问题。新的截图证据包括 `stopped-notion-after-filter-navigation.jpg`、`completed-filter-page-3.jpg`、`template-preview-preserves-stopped.jpg`、`inventory-failure-record.jpg`、`local-report-export-feedback.jpg`，仍保存在 Git 忽略的 `.data/screenshots/figma-repair/`。

#### 当前交付边界与后续实施要求

用户优先指定的后期采集停止链路和结束状态回访已补上并验证。不能把本轮描述为所有控件、全部旧画板和所有业务状态均已穷尽：历史详情仍以代表性记录为主，部分其他行、Running 筛选及旧直达历史/通用停止入口未逐一重审；列表加载失败、任意输入查询、多可用模型/会话选择不是这份静态原型已经具备的能力。

原型的创建异常、发布核对结果和追加指令失败通过独立场景或固定数据演示，不是真实网络分支。返回示例草稿不意味着已修复实际会话或模型故障。发布、系统剪贴板、实际导出、真实登录和申请提交均未执行。

三个模板为预览模式，Screenshot / DOM、附件、定时和高级会话管理有明确未启用说明。正式前端仍须按 PRD 实现实际状态、校验、统一分页与创建时间倒序，不能照搬示例列表的混合行数、部分未排序数据或延时推进逻辑。原始精确参数 JSON 与 manifest 未重写；本轮只更新 Figma、PRD 和本记录，未修改前端代码，也未提交 Git。

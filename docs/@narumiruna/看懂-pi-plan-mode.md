# 看懂 pi-plan-mode：先只读规划，批准后再改代码

> 本文面向已经会让 Pi 改文件的读者。需要接受一件事：规划期的「能调 bash」不等于「能改世界」——同一工具名，策略层可以拒绝写操作。
>
> 源码基线：`@narumitw/pi-plan-mode` **v0.56.0**（本仓库 `@narumiruna/pi-plan-mode`）。菜单文案、导出路径、thinking 档位易变；稳定认知放在「规划态工具策略 fail-closed」和「显式 complete 才算有计划」上。
>
> 官方说明：[README](../../@narumiruna/pi-plan-mode/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-plan-mode)

本文定位：小/轻量偏中，二次开发深度。与 Goal 的互斥见 [看懂 pi-goal](./看懂-pi-goal.md)，两边各自实现 Workflow Mutex v1，谁也不启动谁。

## 1. TLDR：它到底是什么

pi-plan-mode 提供类似 Codex 的 `/plan`：先在受限工具集里把代码看清楚、把关键问题问完、交一份可执行计划，**你批准之后**才恢复写工具。

```text
/plan 或 /plan <prompt>
→ 快照原工具集和 thinking，换上只读安全策略
→ 模型用 read / 受审计的 bash 等探索
→ 重要歧义走 plan_mode_question（人必须选）
→ plan_mode_complete 提交计划
→ 你选择：实施 / 再改 / 保存 / 导出 / 丢弃
→ 实施前先恢复工具，再发实施 prompt
```

所以它不是：

- 不是 Goal。Plan 在批准前禁止突变；Goal 是朝着目标自动续跑；
- 不是「检测模型说了 plan 就算完成」。结束条件是显式工具 `plan_mode_complete`；
- 不是永远只读的安全沙箱。实施阶段会把写工具还回去；
- 不是独立规划服务。状态在当前 session（可另开 linked session 实施）。

正面定义：**带 fail-closed 工具策略的规划状态机。** 判断计划好不好的是你（以及模型在 question 工具里问你的那些题）；扩展负责规划期不让写入溜出去，并在实施前把世界恢复成可写。

权威计划是 **session 里存下来的那份 Markdown**（complete 工具的 details / 状态条目）。聊天里看起来像计划的普通文本，不是权威源。

## 2. 为什么不能靠「先口头说一声再改」

模型在同一轮里又读又写时，常见失败是：没问清楚就改、用 `rm` 当探索、计划只存在一段很快被压缩掉的自然语言里。

该进入 Plan：需求有几种合理实现、会动公共 API、或你明确要先看方案。

不该进入 Plan：已经确定的单行修复——额外的模式切换是成本。

正反例能说明策略层的态度：

- 该放行：`git status`、`git diff`、读文件、`gh pr view`；
- 不该放行：带重定向/命令替换的 shell、`git checkout`、未审计的 `gh` 子命令、`edit`/`write`。

未知形态默认拒绝。安全策略写错的代价是误杀一次只读命令；写松的代价是规划期改了用户没同意的文件。所以偏向拒绝。

## 3. 先看整体架构，不急着看类名

```text
Pi 宿主
 └─ plan-mode.ts（模式控制器：进入/退出/实施/事件）
     ├─ command.ts                 /plan 子命令
     ├─ tool-policy.ts             fail-closed 的写操作审计
     ├─ question-tool.ts           向用户提问
     ├─ completion-tool.ts         显式提交计划
     ├─ state.ts                   从 session 恢复
     ├─ mode-contract.ts           给模型的「现在在 Plan 里」
     ├─ message-transform.ts       解析/保留计划文本
     ├─ fresh-implementation.ts    新 session 实施
     ├─ interactive-ui.ts          菜单（懒加载）
     └─ workflow-mutex.ts          与 Goal 合作互斥
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 命令 | `/plan ...` | start/show/finalize/implement/save/export/exit/tools | 模式转移 |
| 策略 | 工具调用 | 分类、拆 shell、拒绝写 | 允许或冻结/拒绝 |
| 提问 | 结构化问题和选项 | 停下来等你选 | 偏好，而不是猜测 |
| 完成 | Markdown 计划 | 校验长度与非空 | awaitingAction |
| 实施 | 你的确认 | 先恢复工具，再发 prompt | 普通可写会话 |
| 持久化 | PlanModeState | 写入 session 自定义条目 | 恢复后还在规划/待实施 |

图纸上的「只读模式」是策略，不是另起一个只读 Pi。进程真相：还是同一个宿主进程。**模型看见的工具 schema 往往还在**——`edit`/`write`/`bash` 不会从协议里消失——拦截发生在 `tool_call` 事件：不在冻结 allowlist、builtin 写工具、或不安全的 shell 形态，直接 `block`。这不是 OS 沙箱。

## 4. 实际怎样运行：同一进程里换规则

证据：`pi.extensions: ["./dist/index.ts"]`。`plan-mode.ts` 注册 `/plan` 以及两个 helper 工具。设置在 `pi-plan-mode.json`（旧名 `plan-mode.json` 只读兼容）。

装了什么：npm 包。不安装浏览器、不安装语言服务器。

有没有常驻进程：**没有。** `fs.watch` 用于设置文件热更新，仍在宿主进程，随扩展生命周期走。没有规划 daemon。

和宿主的关系：

```text
Pi 宿主进程
 ├─ 普通工具（规划期被换成策略允许的子集）
 ├─ 本扩展的 question / complete
 └─ 可选 Goal（mutex，不互相调用）
```

进入规划要能占用 workflow。Goal 正在跑时拿不到 mutex，enter 失败。这是两个包必须一起升级到文档所写版本的原因。

谁拉起归谁：用户 `/plan`。`plan_mode_question` / `plan_mode_complete` 在 execute 里还要检查 `state.enabled` 且本扩展持有 mutex；工具可见不等于 Plan 已开。

## 5. 一条真实输入：`/plan 给登录加测试` 到实施

```text
进入规划
→ 快照并替换工具 / thinking
→ 探索 + 可选提问
→ complete 得到计划
→ 选择器：实施或修改
→ 恢复工具 → 实施 prompt
→ （可选）保存/导出/新 session 实施
```

### 5.1 进入层：先占工作流，再动工具

进入时抢 mutex、写入 Plan 的 mode contract、持久化状态，并冻结本次允许的工具策略。helper 工具 `plan_mode_question`、`plan_mode_complete` 必须已经在 active allowlist 里，否则规划无法干净结束——`required-tools.ts` 就是在守这道门。

同步完成。失败要关严：不能出现「以为进了 Plan，其实 `tool_call` 没在拦 edit」。

### 5.2 探索层：同名工具，不同策略

`bash` 还叫 `bash`，schema 还在，但 `tool_call` 会走到 `tool-policy.ts`：拆 segment，拒绝 expansion、重定向、写子命令。PowerShell 有平行规则。builtin 里 `edit`/`write`/`update_plan` 直接算突变。后来才被激活的工具，只要不在进入时冻结的 allowlist 里，一样 block。

这是规划期最有价值的模块，也是最容易在二次开发时改坏的模块。测试目录里大量 case 是安全规格，不是样式测试。

### 5.3 提问层：不可推断的偏好必须停下来

`plan_mode_question` 用来问「选 A 还是 B」这类扩展无法替你决定的事。问题结构不合法就拒绝。这是同步的用户交互，不是后台问卷。

### 5.4 完成层：计划成为一等状态

`plan_mode_complete` 接收一份 Markdown，有上限。成功后状态变成「有 latestPlan，awaitingAction」。旧的从助手文本里抠 fence 的路径只为兼容，新路径应以工具为准。

完成 ≠ 开始改代码。此时写工具仍应被挡住，直到你选实施。

### 5.5 实施层：恢复必须发生在 prompt 之前

开始实施时先把 mode contract 发回 `normal`（`enabled=false`），再发实施 prompt。同一 session 实施走 handoff 用户消息；「fresh」走 `ctx.newSession`——**仍在宿主进程里**，而且会拷贝当前 live branch，不是空会话。`pi --no-session` 或不存在 session 文件，并不代表内存分支是空的。保存的计划在新工作流开始前会做 preflight，避免和正在跑的规划打架。发送失败必须回滚到 Plan，不能留下「以为已经可写、其实还在拦」的中间态。

退出则丢弃规划态；保存/导出是另一条不实施的出路。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| 规划中 | 策略 fail-closed 的探索 | 永久只读安装 |
| complete | 决策就绪的计划文本 | 实施本身 |
| saved plan | 以后再实施的副本 | 自动执行队列 |
| 工具策略 | 对调用参数的审计 | 操作系统沙箱 |

常见误区：

- 「Plan 开着，bash 就是安全的。」错。正：只有审计通过的形态安全；复杂 shell 应被拒。
- 「模型已经写出了计划标题，所以可以实施。」错。正：看 complete 工具或恢复出来的 latestPlan。
- 「实施失败说明策略还在挡。」可能。正：先确认 mode contract 是否已回到 normal、mutex 是否释放，再查 Goal 是否仍占着。

症状式排错：

- **规划期还能 edit**：这是事故。先查是否成功 enter、active tools、策略分类。不要先改 prompt。
- **complete 了但菜单不出现**：先看 TUI 模式和 awaitingAction 恢复。状态在 session 条目 `plan-mode-state`。
- **实施第一轮没有写工具**：恢复顺序问题，盯 `startImplementation` 一类路径，而不是 question 工具。

当前可靠性边界：shell 审计是语法级 fail-closed，不是内核强制。被放行的只读命令如果本身是危险二进制，策略挡不住。未知工具默认拒绝，是有意的。

## 7. 总结

1. 同一 Pi 进程；只读是 `tool_call` 拦截，不是把写工具从 schema 里删掉，更不是 OS 沙箱。
2. 计划的权威入口是 `plan_mode_complete`，不是自然语言。
3. 实施前必须先回到 normal contract；fresh 实施会拷贝 live branch，仍在宿主进程。
4. 与 Goal 合作互斥，互不发现。

如果只记一条主线：

```text
/plan → 只读策略 → 提问/探索 → complete → 你批准
→ 恢复工具 → 实施（本 session 或新 session）
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` / `src/plan-mode.ts` — 控制器。文件很大，先顺着 enter/exit/implement 读。
2. `src/command.ts` — 子命令面。
3. `src/state.ts` — 恢复规则：enabled、savedPlan、activeImplementation 何时互斥。
4. `src/tool-policy.ts` — 安全规格正文。
5. `src/question-tool.ts`、`src/completion-tool.ts` — 两个 helper 的边界。
6. `src/mode-contract.ts` — 模型如何知道自己在 Plan 里。
7. `src/required-tools.ts` — helper 缺失时为什么不能装样子。
8. `src/fresh-implementation.ts`、`src/implementation-retention.ts` — 新 session 与计划保留。
9. `src/workflow-mutex.ts` — 和 Goal 的合作面。
10. `test/` — 尤其是 shell 攻击面和 issue 回归。

二次开发加「规划期可用工具」时，先写拒绝测试再写放行。默认通过是这个模块的典型事故。

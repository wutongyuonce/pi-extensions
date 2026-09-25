# 看懂 rpiv-ask-user-question：模型停下来问你，而不是猜

> 面向第一次接触这个扩展、准备二次开发的读者。不需要先会 Pi 的 overlay API，但需要知道：工具调用是同步等待的，TUI overlay 和 RPC 宿主不是同一条渲染路。
>
> 本文定位：**中等扩展 + 二次开发深度**。稳定认知放在「三宿主、阻塞等待、信封是模型看见的权威、取消 ≠ 没渲染」。快捷键默认值、文案、预览排版属于易变细节。
>
> 源码基线：本仓库归档副本 `@juicesharp/rpiv-ask-user-question`，包版本 **2.9.0**；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[juicesharp/rpiv-mono `packages/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)。
>
> 工具名必须是 `ask_user_question`。哨兵行英文原文必须是 `Type something.` / `Next`。这不是文案品味：校验按英文 canonical 拒模型自写的同名选项，和当前 UI 语言无关。
>
> 同系列 [`看懂 rpiv-todo.md`](./看懂%20rpiv-todo.md) 讲的是「面板能活过 /reload」。本扩展**没有**那套回放：问卷是一次阻塞的工具调用，overlay 随调用结束而卸。

## 1. TLDR：它给模型一张你必须勾完的选择题

模型拿不准时不该猜。它调用 `ask_user_question`，你在终端（或宿主原生对话框）里勾选项，工具才返回。最多 4 题，每题 2–4 个选项，每题自动多一行「Type something.」。

TUI 主路径：

```text
模型调 ask_user_question
  → before_agent_start 已按 hasUI 决定工具在不在列表里
  → execute：校验 → 发 rpiv:ask-user:prompt
  → ctx.ui.custom 铺满底栏 overlay
  → 人勾选 / 输入 / Esc
  → 合成信封文本 + details
  → overlay 卸掉，模型读信封继续
```

RPC 退化路径（VS Code / Zed / Paseo）：

```text
ctx.mode === "rpc" 且 ui.select + ui.input 可用
  → 不 import 那套 ~560ms 的 TUI 图
  → 一题一个原生对话框，顺序问完
  → 同一套 QuestionnaireResult → 同一套信封
```

无 UI：

```text
ctx.hasUI === false
  → reconciler 把工具从 active set 拿掉
  → 模型根本看不见这个工具
```

所以它不是：

- **不是** `rpiv-todo`。todo 把快照写进会话分支，overlay 只是视图，`/reload` 能整表回来。问卷的中间态（当前 tab、草稿）**不**进会话；关掉 overlay 或工具返回，现场没了。
- **不是** 聊天里的普通提问。选项是 typed 的；模型读到的是固定信封，不是你在 Pi 编辑器里打的下一句。
- **不是** 独立对话框进程。没有 HTTP，没有 Glimpse 窗口。TUI 路径画在 Pi 自己的终端 overlay 里。
- **不是** 无头模式的必需工具。没有 UI 时工具被摘掉，避免模型调用之后卡死或被当成「用户拒绝」。

正面定义：它是挂在 Pi 上的 **结构化人机检查点**——模型负责出题，扩展负责按宿主能力渲染，人的勾选经信封回到模型。

权威数据源：

```text
这一次工具返回的 content[0].text（信封或 DECLINE_MESSAGE）
        = 模型本轮读到的权威

details: QuestionnaireResult
        = 给回放/其它扩展的结构化副本；取消时答案仍可能在 details 里

TUI overlay / 宿主 select 对话框
        = 视图；卸掉不等于「没问过」或「拒绝了」

会话 JSONL
        = 只记下这条 tool result，不负责恢复做到一半的问卷
```

## 2. 为什么不能让模型在聊天里口头问

正例：要在「修 bug / 新功能 / 重构」里选一个，还可能多选「要不要写测试」。口头问会得到「都行吧第二个」这种解析不稳的句子。工具把选项冻成 label，返回 `"Which task?"="Bug fix"`。

反例：不要用它做「请输入你的 API key」这种无选项自由输入——每题至少 2 个选项，自由输入只是哨兵行。也不要在 `pi -p` 无头跑里指望这个工具还在；reconciler 已经摘掉了，模型应当自己往下做或改问聊天。

和 todo 的架构判断正好相反：

```text
todo                 状态要活过 reload → 权威在会话分支，面板可丢
ask_user_question    状态就是这一次等待 → 权威在本次 tool result，面板必随调用死
```

所以：

```text
模型管「问什么、几个选项」（题目质量）
扩展管「在这个宿主上怎么画、怎么等、怎么封信封」（流程）
人的勾选是交接结果（权威）
overlay 只是这一次等待的显示器
```

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层          registerTool + before_agent_start reconciler
        ↓
校验层          1–4 题 / 2–4 选项 / 保留 label / 题面去重
        ↓
宿主分流        TUI overlay  |  RPC select/input  |  无 UI（工具不存在）
        ↓
会话运行时      纯 reducer + 按键路由（仅 TUI）
        ↓
信封层          buildQuestionnaireResponse → 模型可读的一段话
```

进程真相：整个扩展活在 **Pi 宿主进程**里。没有问卷 daemon。TUI 路径会 `await ctx.ui.custom(...)`，这一轮 agent 卡住，直到人提交或取消。RPC 路径同样 `await ui.select` / `ui.input`。阻塞发生在工具 `execute` 里，不是后台队列。

和「文档说有 UI」容易打架的点：

- RPC 宿主 `hasUI: true`（Pi 的 dialog 子协议能用），但 `ui.custom()` 会 resolve `undefined` 且什么都不画（issue #78）。所以分流看 `ctx.mode === "rpc"` + `hasDialogUI`，**不是**只看 hasUI。
- `custom()` 返回 `undefined` **不是**用户按了 Esc。错误码 `no_custom_ui`，正文明确写「用户从未看见题目，不要当成拒绝」。
- 用户 Esc / 交白卷：信封是同一句 `User declined to answer questions`。details 里 `cancelled: true`。全局备注如果有，仍挂在 details 上，但模型正文不读它。

## 4. 运行形态：一个工具，三种宿主

谁拉起：`pi install` 这个包，加载 `index.ts`。谁保活：无。Pi 退出即停。

```text
pi 进程
  ├─ registerAskUserQuestionTool
  ├─ registerAskUserQuestionReconciler  → 每轮 before_agent_start
  ├─ 可选：动态 import @juicesharp/rpiv-i18n/loader（没有就英文）
  └─ 第一次真正开 TUI 问卷时才 import QuestionnaireSession
        └─ 注册后 2s 会 prewarm 一次，把模块钉进 jiti 缓存
```

三种环境（`docs/hosts.md` 的表，和代码一致）：

| 环境 | 模型看见的工具 | 人看见的 |
| --- | --- | --- |
| 交互终端 | 在列表里 | 底栏铺满的 tab overlay |
| RPC / ACP | 在列表里 | 宿主自己的 select / input，一题接一题 |
| 无 UI | **没有** | 没有 |

`reconcileAskUserQuestionTool` 只认 `ctx.hasUI`。RPC **故意不摘**——PR #100 之后 RPC 有 fallback。曾经有一段提交（`872ef1c`）把 RPC 也摘了，那是 fallback 之前的旧行为，不要抄回来。

overlay 锚在 `bottom-center`、宽 100%、高最多 100%。它盖住 Pi 编辑器，不是另开窗口（对比 `pi-review-loop` 的 Glimpse）。折叠默认 `ctrl+]`：真藏起来之后 pi-tui **不会**再把键发给 hidden overlay，所以 execute 额外挂了 `ctx.ui.onTerminalInput`。没有这条 raw listener 的宿主，折叠只能缩成一行可见 hint，否则再也打不开。

终端注意：等待开始前，若 `stdout.isTTY` 就写一个 `\x07`。重定向和 RPC 管道不响。写失败忽略，问卷照开。

## 5. 纵向链路一：从工具调用到人开始勾

```text
1. 列表层     before_agent_start 按 hasUI strip/restore     同步
2. 调用层     模型发出 ask_user_question                    同步进 execute
3. 有无 UI    !hasUI → no_ui 信封，根本不画                 同步
4. 校验层     validateQuestionnaire                         同步
5. 事件层     rpiv:ask-user:prompt（JSON 安全载荷）         同步，best-effort
6. 分流层     rpc+select/input → walker
              否则 lazy load QuestionnaireSession
7. 加载层     import 失败 → session_load_failed
              命名空间没有 class → stale_module_cache
              两者都告诉模型：人没看见，当聊天重问，且要重启 Pi
8. 等待层     BEL + blocked=true + custom()/select()        异步阻塞
```

完成 ≠ 就绪：

- **工具已注册 ≠ 这一轮模型能调。** 无头跑列表里没有它。
- **prompt 事件已发出 ≠ 人已经看见。** 事件在渲染前；通知插件可以响铃，但 overlay 可能随后 load 失败。
- **`custom()` 返回了 ≠ 人答了。** `undefined` 是宿主画不出。
- **prewarm 跑过 ≠ 磁盘上的模块还是启动时那份。** Pi 的 jiti 在求值前就把模块登记进缓存，求值抛错也不驱逐。`pnpm install` 换掉 store 之后，第一次失败会把缓存钉死成「没有 QuestionnaireSession 这个 class」。进程内无解，信封要求重启。

题目合同（稳定部分）：1–4 题；每题 2–4 选项；`header` ≤16、`label` ≤60 由 TypeBox 在 execute 前拦；`preview` 只给单选。模型写 `"Other"` / `"Type something."` / `"Next"` 一律 `reserved_label`，即使这题根本不会出现 `Next` 行。

## 6. 纵向链路二：勾完到模型读到信封

TUI 内部（人话，不铺类图）：

```text
按键 → key-router → 纯 reduce
  → 改 currentTab / 勾选集合 / 自定义草稿 / notes
  → 视图从 state 投影，不自己存一份答案
  → Submit（或单题确认）→ done(result)
  → execute 里 buildQuestionnaireResponse
```

答案三种 `kind`：

- `option`：单选了一个官方选项，`answer` 是 label
- `custom`：走了哨兵行，`answer` 是你打的字
- `multi`：`selected: string[]`，`answer` 为 null；一个都没勾就提交，等于空多选

多选的 `Enter` 在普通行上**只切换勾选**，和 Space 一样；提交该题必须焦点在 `Next` 再 Enter。这是为了让 Enter 能在 home row 上连弹，而不是误提交。

信封规则（`tool/response-envelope.ts`，测试钉死）：

```text
成功：User has answered your questions: "Q"="A". … You can now continue…
拒绝 / 零片段：User declined to answer questions
```

零片段的精确定义：没有任何 per-question 片段，**且**没有非空 `globalNote`。只有全局备注、一道题都没答，仍算「已回答」信封（备注当一段）。取消则永远是拒绝句；备注只活在 details。

`n` 开当前题笔记；多题时 Submit tab 的 `n` 是全局备注。`Ctrl+G` 把自定义草稿丢给 Pi 配置的外部编辑器，失败 notify，草稿留下。

RPC walker 的故意减配：没有并排 preview（预览折进 title，截到 600 字）；没有 tab 总览；多选变成「输入 1,3」的自由文本。非数字输入当成 custom，对应 TUI 的 Type something.。select/input 返回 `undefined` 视为取消整张问卷。

## 7. 纵向链路三：折叠、事件、其它扩展怎么挂

折叠不是第二条产品链路，但它是 TUI 特有的进程细节：

```text
可见 overlay：component.handleInput 能收到 ctrl+]
setHidden(true) 之后：pi-tui 不再路由按键
  → 只能靠 onTerminalInput 这条 raw 钩子再 setHidden(false)
第一次藏起来：notify「press Ctrl+] to reopen」
```

`collapseKey: "off"` 关掉快捷键。非法 spec（比如 `ctr+]`）**不**静默匹配裸 `]`——那会吃掉所有 `]`。校验失败回退默认 `ctrl+]`。

给其它扩展的两个频道（`events.ts` 稳定性政策：频道名永不改，payload 只追加）：

```text
rpiv:ask-user:prompt     题目列表（选项只有 label/description/hasPreview，不含 preview 正文）
rpiv:ask-user:blocked    { active: true|false }  等待开始/结束（答、取消、出错都走 finally false）
```

监听者可以用来响铃、暂停别的 overlay、打日志。不要假设 prompt 之后一定有一次成功信封。

i18n：`@juicesharp/rpiv-i18n` 是 optional peer。`index.ts` 对 `/loader` 做 try/catch 动态 import，避免把 i18n-ui 拉进加载图。没装 SDK 时 `t(key, fallback)` 返回英文。chrome 字符串运行时翻译；保留 label 检查永远对英文 canonical。

## 8. 边界、概念区分、常见误区

**取消 vs 没渲染。** 同一句「declined」只用于人明确取消或交了零片段。`no_ui` / `no_custom_ui` / `session_load_failed` / `stale_module_cache` 的正文都写着 **do NOT treat this as a decline**。二次开发不要把所有 `cancelled: true` 都喂给「用户说不」。

**工具结果 vs 会话状态。** 结果会进 JSONL，所以从历史里能看见当时答了什么。正在填的草稿、折叠与否、焦点在哪一行，都不进分支。这和 todo 的「details 即整表快照」不同。

**TUI overlay vs RPC 对话框 vs review-loop 窗口。** 三者都是「让人看东西」，进程完全不同：本扩展 TUI 是 Pi 终端 overlay；RPC 是宿主原生 dialog；`pi-review-loop` 是 Glimpse 操作系统窗口。不要复用彼此的「再按一次命令置前」心智——本工具连命令都没有，模型不调就没有 UI。

**哨兵行 vs 模型选项。** 对话框自己 append。模型再写一个叫 `Type something.` 的选项会被拒。`"Other"` 也保留，因为模型被训练成爱写 Other。

常见误区：

1. 「无头模式调了会弹出。」工具不在列表里；万一漏网，execute 还有 `no_ui` 后门。
2. 「RPC 上 custom() 失败就是用户取消。」是宿主画不出。
3. 「和 todo 一样 /reload 问卷还在。」不会。
4. 「改了 locales/zh.json 但保留词也改成中文就能让模型写中文哨兵。」校验不看翻译。
5. 「`Ctrl+]` 没反应就是 bug。」拉丁美洲布局 `]` 在 shift 层，改 `collapseKey`。

## 9. 失败形态（现象 → 该查哪一层）

| 现象 | 先查 |
| --- | --- |
| 模型从不调用这个工具 | `hasUI`？reconciler 是否 strip；guidance 是否把 description 改废 |
| 调用后说 UI not available | 无头 / print 模式，预期 |
| 调用后说 cannot render custom UI | RPC 但没有 select/input；或 custom() undefined 且没走进 walker |
| 说 session_load_failed / stale_module_cache | 安装被热替换；**重启 Pi**，不要重试工具 |
| 折叠后快捷键失灵 | 宿主有没有 `onTerminalInput`；`collapseKey` 是否 off / 非法回退 |
| 多选一按 Enter 就跳下一题 | 焦点是不是在普通行——应只 toggle；要提交去 `Next` |
| 预览没并排出现 | 是不是 `multiSelect`（不支持）；或走了 RPC（折进 title） |
| i18n 不生效 | 没装 `@juicesharp/rpiv-i18n`；或只改了 JSON 没走 SDK 的 locale 注册 |

## 10. 总结：五条稳定事实 + 一条主线

1. 权威是**这一次** tool result 的信封文本；overlay 是一次性显示器；没有 todo 那种会话回放。
2. 三种宿主：TUI overlay、RPC select/input 顺序问、无 UI 则工具不存在。
3. `cancelled: true` 分两种故事：人拒绝，和人根本没看见。后者禁止当成 decline。
4. 哨兵行由扩展 append，保留英文 label；工具名 `ask_user_question` 不要改。
5. 扩展寄生在 Pi 进程；等待发生在 `execute` 的 await 上；jiti 缓存钉死只能重启。

主线：

```text
模型出题
  → 扩展按宿主能力画（overlay / 原生 dialog / 不画）
  → 人勾选（或取消，或根本没看见）
  → 信封回到模型
  → overlay 卸掉，现场不留
```

## 11. 深入通道：源码阅读顺序

1. `index.ts` + `reconcile.ts`  
   看了能懂：软依赖 i18n、每轮 strip/restore、RPC 为什么不摘。
2. `ask-user-question.ts` 的 `execute`（大约从 `registerAskUserQuestionTool` 起到文件尾）  
   看了能懂：hasUI → 校验 → 事件 → rpc 分流 → lazy load → custom() → undefined 后门。热路径全在这。
3. `rpc-fallback.ts`  
   看了能懂：和 TUI 共用信封、减了哪些能力、多选怎样把非数字当 custom。
4. `tool/validate-questionnaire.ts` + `tool/types.ts` 的保留 label  
   看了能懂：模型合同；为什么 `"Other"` 也禁。
5. `tool/response-envelope.ts`  
   看了能懂：模型最终读到的那句话如何从 result 长出来；全局备注何时算「已回答」。
6. `state/state-reducer.ts` + `state/key-router.ts`  
   看了能懂：TUI 状态是纯函数；按键绑定跟 Pi keybindings 走。
7. `state/questionnaire-session.ts` 前 80 行 + collapse 相关  
   看了能懂：`canReopenWhileHidden` 为什么必须和 raw listener 绑定。
8. `events.ts`  
   看了能懂：跨扩展频道的稳定性政策，十行内闭合。
9. `ask-user-question.execute.test.ts` + `rpc-fallback.test.ts` + `ask-user-question.session-load.test.ts`  
   看了能懂：三种失败信封和 RPC 分流的合同，比 README 更硬。

包内文档：`docs/hosts.md`（三宿主）、`docs/tool-schema.md`（模型合同）、`docs/keyboard.md`（键）、`docs/configuration.md`（collapseKey / guidance）。和源码冲突时以 `execute` 和 reconciler 为准——尤其是「RPC 还在不在工具列表里」这一条。

本地冒烟：交互终端里让模型调用一次两选项单选题，应弹出底栏 overlay 而不是聊天问句；Esc 应得到 decline 信封。`pi -p` 无头跑同一句，模型不应再有这个工具。RPC 宿主上应出现原生 select，不应空白等待。

二次开发时优先碰的缝：新增错误码必须让模型分清「没看见」和「拒绝」；不要把问卷草稿写进 session custom entry 除非产品改成 todo 那种存活模型；改哨兵文案必须同时改保留集合和校验测试；不要在 `execute` 外再 `await` 一次人机，否则 blocked 事件对不齐。

## 参考资料

- [rpiv-ask-user-question README](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
- 包内 `docs/hosts.md`、`docs/tool-schema.md`、`docs/keyboard.md`、`docs/configuration.md`
- 本仓库 [`看懂 rpiv-todo.md`](./看懂%20rpiv-todo.md)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

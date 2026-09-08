# 看懂 pi-schedule-prompt：宿主进程里的心跳定时器

> 本文面向已经会用 [Pi Coding Agent](https://pi.dev) 的读者，想搞清「Agent 怎么自己约未来的提示词」、定时器到底跑在谁的进程里、关窗口会不会补跑。本文定位：**二次开发深度**——讲清运行形态和两条执行路径后，给一条从入口到触发的源码阅读顺序。
>
> 源码基线：本仓库 `@tintinweb/pi-schedule-prompt`，包版本 `0.4.1`（CHANGELOG 日期 2026-06-23）。父仓库 HEAD `6f1c21c`（2026-09-08）。这是 vendored 快照，不是上游独立 git 历史；命令文案和字段名可能继续变，**稳定认知应放在职责边界和数据流上**。
>
> 权威源：[上游 README](https://github.com/tintinweb/pi-schedule-prompt)、本目录源码 `src/`。同系列：[看懂 pi-subagents](./看懂%20pi-subagents.md)、[看懂 pi-tasks](./看懂%20pi-tasks.md)。

## 1. TLDR：一条调度，两条开火方式

`pi-schedule-prompt` 给当前 Pi 会话加一套「以后再喂一句提示词」的能力。产品自称 **Heartbeat**（心跳）：提醒、延后任务、周期性自动化，都靠它。

它做的事情可以压缩成一条调度链路，开火时再分两条：

```text
用户或 LLM 说「半小时后提醒我 / 每小时扫一次日志」
  → 校验时间表达式
  → 写入 <cwd>/.pi/schedule-prompts.json
  → 在当前 Pi 进程里挂上 croner / setTimeout / setInterval
  → 到点重新读磁盘、核对所有权
       ├─ 没填 model：把 prompt 注入当前对话（唤醒宿主 Agent）
       └─ 填了 model：在同一进程里另开一个一次性 AgentSession
  → 回写 lastStatus / runCount
  → Widget 刷新
```

所以它不是：

- **不是系统 crontab / systemd timer。** 表达式长得像 cron，执行器是 Node 事件循环。Pi 没开，什么都不会响。
- **不是后台守护进程，也不是独立 CLI。** 没有 `bin`，没有常驻 worker。装上的是一段被 Pi 加载的扩展工厂。
- **不是 pi-subagents。** 带 `model` 的路径会新建 `AgentSession`，但调度器、存储、工具名都是本包自己的；和 `@tintinweb/pi-subagents` 的 `Agent({ schedule })` 不是同一套。
- **不是「错过了下次打开会补跑」。** 错过的 tick 直接丢。过期的一次性任务会被禁用并记 error，不会补执行。

正面定义：**寄生在宿主 Pi 进程里的作业调度扩展。磁盘上的 JSON 是权威作业表，内存定时器只是这张表在「当前会话开着」期间的投影。**

权威数据源尽早钉死：

| 东西 | 谁说了算 |
|---|---|
| 作业内容、开关、跑了几次 | `<cwd>/.pi/schedule-prompts.json` |
| 这次会话挂了哪些 timer | 内存里的调度器，随进程死 |
| Widget 显不显、新作业绑不绑会话 | 两层 settings JSON（项目覆盖全局） |

## 2. 为什么不能只用普通 cron

Pi 的主循环是「用户说话 → 模型回合 → 结束」。它没有「半小时后再叫我一声」的原语。操作系统 crontab 能定点跑命令，但解决不了三件 Pi 特有的事：

1. **提示词要进当前对话，或进一个带模型、带工具的 Agent 会话。** crontab 只能拉起进程，不知道 `sendUserMessage`。
2. **同一仓库可能同时开两个 Pi。** 作业默认绑当前 session，避免两扇窗口各打一枪；共享作业则明确接受重复开火。这是会话语义，不是 crontab 用户。
3. **LLM 自己要能增删改。** 工具叫 `schedule_prompt`（给模型用的调度工具），人类入口是 `/schedule-prompt`。两套入口共用同一套时间校验。

正例：用户说「30 分钟后提醒我 review PR」——一次性相对时间，注入当前对话。  
反例：想「每天早上 9 点，即使我没开 Pi 也跑」——本扩展做不到。那是 OS 调度的问题，不要改本包硬补队列。

## 3. 先看整体架构，不急着看类名

文档视角的职责分层（收到什么 → 做什么 → 产出什么）：

```text
接入层     工具 schedule_prompt / 命令 /schedule-prompt / 添加向导
              收到：自然语言或结构化参数
              产出：一条合法 Job 记录

校验层     唯一的时间解析入口
              收到：type + schedule 字符串
              产出：规范化后的 cron / ISO / intervalMs，或拒绝

权威存储   <cwd>/.pi/schedule-prompts.json
              收到：增删改
              产出：原子写盘后的作业表（tmp + rename）

调度层     当前 Pi 进程内的 timer
              收到：enabled 且属于本会话的作业
              产出：到点回调（不补跑错过的）

执行层     两条互斥路径
              没 model → 宿主对话注入
              有 model → 一次性内存 AgentSession

展示层     编辑器下方 Widget + Jobs 浮层 + 自定义消息渲染
              收到：cron:change 事件和 30s 轮询
              产出：用户看见的状态，不回写权威数据
```

进程真相和图纸几乎重合，**差异只有一处，也是精华**：图上的「调度层」听起来像一台服务，实际上只是宿主 Node 进程里的 `croner` 实例和 `setTimeout` / `setInterval`。没有监听端口，没有第二个 OS 进程。子 Agent 路径仍然在**同一进程**里 `createAgentSession`，不是 `fork` 出另一个 `pi`。

```text
┌─────────────────────────────────────────────┐
│  宿主 Pi 进程（你在终端里开的那一个）          │
│                                             │
│   扩展工厂 ──► 存储 ──► 调度器(timer)         │
│                  │            │             │
│                  │            ├─ 注入本对话    │
│                  │            └─ 内存子会话    │
│                  ▼                          │
│         .pi/schedule-prompts.json            │
└─────────────────────────────────────────────┘
        ▲
        │  进程退出 = 全部 timer 消失
        │  文件还在，下次 session_start 再挂
```

## 4. 它主要是一个 Pi 扩展，没有自己的进程

证据不看 README 自述，看安装产物：

- `package.json` 没有 `bin`、没有 `main`。入口是 `"pi": { "extensions": ["./src/index.ts"] }`。
- 工厂签名：`export default async function (pi: ExtensionAPI)`。Pi 加载 TypeScript 源文件，不走 `dist`。
- 注册内容：一个工具、一个命令、一个消息渲染器、`session_start` / `session_shutdown` 两个钩子、编辑器下方一块 Widget。

装了什么、跑起来是什么：

| 产物 | 何时出现 |
|---|---|
| 扩展代码被 Pi 加载进当前进程 | `pi install npm:pi-schedule-prompt` 或 `pi -e ./src/index.ts` |
| `<cwd>/.pi/schedule-prompts.json` | 第一次成功 `add` |
| `<cwd>/.pi/schedule-prompts-settings.json` | 用户在 `/schedule-prompt` → Settings 里改过 |
| `~/.pi/agent/schedule-prompts-settings.json` | **本扩展从不写它**，只读作手动默认 |

有没有常驻进程：**没有。** 定时能力是代码职责，不等于一台持续监听的服务器。每次打开 Pi，扩展在当前进程里创建存储和调度器；Pi 退出，对象和 timer 一起没。用户不需要另外启动 heartbeat 服务。

后台部分点名：

| 节点 | 载体 | 谁拉起 | 崩溃/重启语义 |
|---|---|---|---|
| cron 表达式作业 | 进程内 `croner` | `session_start` → 调度器 `start` | 进程死即停；重开从「现在」对齐下一拍，不补跑 |
| interval | `setInterval` | 同上 | 从挂上那一刻起算周期，不对齐墙钟整点 |
| 一次性 | `setTimeout` | 同上 | 重开时如果已经过期：禁用 + `lastStatus: error`，不执行 |
| 带 model 的执行 | 同进程 `AgentSession` | timer 回调里 fire-and-forget | `session_shutdown` 会 abort 进行中的子会话 |

和宿主的关系：扩展寄生在宿主里。被谁拉起的进程就归谁——这里只有宿主 Pi 一个进程。

还要纠正一个启动错觉：`session_start` **不等于冷启动**。会话 reload / resume / fork 也会再发一次。所以初始化必须先拆掉旧 timer 再挂新的，否则同一条 cron 会双响。这是不变量，不是实现细节。

## 5. 纵向链路：从「约一句」到「真的开火」

把一次真实输入切成八个语义节点。层名连读就是整条链路。

```text
接入 → 校验落盘 → 挂 timer → 到点 → 重读所有权 → 分支执行 → 回写统计 → 展示
```

### 5.1 接入层：收到一句「半小时后提醒我」→ 收成结构化 add

载体：宿主进程，同步。

两条入口：

- 模型调 `schedule_prompt`，`action=add`。
- 人走 `/schedule-prompt` → Jobs 浮层 `a`，或添加向导。

工具侧还有两道闸：同名作业拒绝；最近 10 条会话消息里如果已经有 `scheduled_prompt` 自定义消息，拒绝再 `add`——防止「定时任务触发后又给自己定一条」的环。这是启发式，不是权限旗标。

### 5.2 校验落盘：收到 type+schedule → 写出一条 Job

载体：宿主进程，同步写盘。

时间规则只有一个入口（工具和 TUI 都走它）：

| type | 人怎么写 | 存什么 |
|---|---|---|
| `cron` | 六段：秒 分 时 日 月 周 | 原表达式。五段 crontab 直接拒绝 |
| `interval` | `5m` / `1h` | 原字符串 + 算出的 `intervalMs` |
| `once` | `+30m`、ISO、自然语言日期 | 解析成 ISO。距现在不到 5 秒、或已经过去：拒绝 |

作业 id 用短 nanoid。若当前默认范围是 `session`，写入 `session` 字段，这条作业就只属于本会话。然后原子写盘：先 `.tmp` 再 `rename`。

完成状态：文件里已经有这条 Job。**还不等于会响**——timer 还没挂上，且本会话必须「加载」得了它。

### 5.3 挂 timer：收到已启用作业 → 内存里有一个回调

载体：宿主进程，同步完成挂载；回调本身是异步的。

| type | 原语 | 第一次何时响 |
|---|---|---|
| cron | `croner` | 下一个匹配墙钟的时刻（Pi 必须还开着） |
| interval | `setInterval` | **一个周期之后**，不是立刻 |
| once | `setTimeout` | 那个绝对时间 |

### 5.4 到点：事件循环叫醒回调

载体：宿主 Node 事件循环，异步。

闭包里抓着的 Job 对象可能已经过期（有人手改了 JSON、另一条路径改了 enabled）。所以回调第一件事不是执行，是重读。

### 5.5 重读所有权：收到磁盘上的新鲜记录 → 决定「这枪该不该打」

载体：宿主进程，同步读盘。

三条任一不满足就静默返回：

- 作业已经不在文件里
- `enabled === false`
- 不属于本会话（见第 7 章的 `isLoadedFor`）

先把所有权判死，再碰对话或子会话。理由：错误的会话开火比错过一次更糟——两扇 Pi 窗口会把同一条心跳打成两次用户消息。

### 5.6 分支执行：收到「可以打」→ 要么注入本对话，要么开子会话

见第 6 章。没填 `model` 走 6.1，填了走 6.2。`notify` **不是**这条分叉条件。

### 5.7 回写统计：收到执行结果 → lastStatus / runCount / 一次性禁用

载体：宿主进程，同步写盘。

子 Agent 路径的不变量：**先把终端状态写进 JSON，再发界面 marker。** 展示通道失败不能把作业卡在 `running`。一次性作业开火后 `enabled: false`，会话退出时再被清掉。

### 5.8 展示：收到 `cron:change` → Widget / Jobs 浮层刷新

载体：宿主 TUI。Widget 还自己 30 秒轮询一次。展示层不写权威数据。本会话加载不到的作业，Widget **不显示**；Jobs 浮层能看见，但只读。

同步 / 异步分块：

```text
同步（add 当时就完成）：校验 → 写盘 → 挂 timer → 返回工具结果
异步（以后才发生）：timer 回调 → 重读 → 执行 → 回写 → 事件
```

判定句：**工具返回成功，只证明作业已经落盘并且 timer 已挂。下一次会不会响，取决于那时 Pi 还开不开、作业还属不属于本会话。**

## 6. 第二条路径：填了 model，就不进当前对话

分叉条件只有一个：作业上有没有非空 `model`。

### 6.1 内联：没 model

```text
lastStatus=running
  → 发一条 content 为空的 scheduled_prompt 标记（给人看，不给模型当第二份 prompt）
  → pi.sendUserMessage(prompt, { deliverAs: "followUp" })   ← 唯一进模型上下文的那份
  → 回写 success
```

父对话被唤醒，这是设计，不是副作用。`notify` 在这条路径上被忽略——已经在说话了，不需要再 nudge。

空 `content` 是有意的：如果标记也带正文，模型会看到同一句提示词两次。

### 6.2 子 Agent：有 model

```text
timer 回调立刻返回（不等待）
  → 同进程 createAgentSession + 内存 SessionManager（不落会话文件）
  → 默认工具只有 bash/read/edit/write/grep/find/ls
  → 默认不加载 extensions / skills
  → 跑完写 lastStatus，再发 subagent_start/done/error 标记（content 非空，否则部分供应商会 400）
  → 仅当 notify === true 才用 followUp + triggerTurn 叫醒父对话
```

所以「子 Agent」在这里的意思是：**同一 Node 进程里的一次性会话**，不是子进程，不是另一个 `pi` CLI。Abort 靠 `AbortController`，不是 SIGTERM。

默认最小权限。`extensions: true` 不只是「多几个插件」——它会换成完整工具集并 `bindExtensions`，否则 MCP 一类扩展工具进不去。这是能力开关，不是装饰字段。

`update` 不能把 `model` 清掉（schema `minLength: 1`）。要从子 Agent 改回内联：删了重建。

## 7. 边界、概念区分、常见误区

### 7.1 最容易混的词

| 词 A | 词 B | 不要混 |
|---|---|---|
| cron 表达式 | 系统 crontab | 前者是字符串，后者是 OS 服务。本包只用前者 |
| 作业 JSON | 内存 timer | JSON 是权威；timer 是投影。手改文件后，下次开火以文件为准 |
| session 绑定 | workdir 共享 | 默认新作业绑当前会话。共享作业 = 每个打开这个 cwd 的 Pi 都会打，接受重复 |
| 内联执行 | 子 Agent 执行 | 分叉看 `model`，不看 `notify`、不看 type |
| `notify` | 父对话一定被叫醒 | 只对子 Agent 有效；内联本来就会 `sendUserMessage` |
| 本包的 model 子会话 | pi-subagents 的 `Agent` | 两套调度、两套存储、两套工具名 |
| Settings 里的默认范围 | 已有作业的 session 字段 | Settings 只影响**新**作业。改旧的用 Jobs 浮层的 `s` |

所有权规则就一句话：没有 `session` 字段 = 谁打开这个目录谁加载；有 = 只有 id 对得上的会话加载。这条规则贯穿调度、开火、list、cleanup、Widget、Jobs 浮层，不是 UI 装饰。

### 7.2 常见误区

- **「这是 crontab。」错。** 正：Pi 关了就静音。`daily 9am` 只在「那天 9 点至少有一个 Pi 开在这个目录」时响。
- **「10 点打开 Pi，会补跑 9 点那次。」错。** 正：cron 等下一拍；过期的 `once` 被禁用并记 error。
- **「两个窗口共享一个调度器。」错。** 正：各挂各的 timer。绑定会话的作业不会双响；未绑定的会。
- **「子 Agent 是另一个进程。」错。** 正：`createAgentSession`，内存会话，不落盘。
- **「Widget 列出 JSON 里所有作业。」错。** 正：只列本会话加载得到的。别人的作业在 Jobs 浮层只读可见。
- **「Jobs 存在 `~/.pi`。」错。** 正：作业永远在项目 `<cwd>/.pi/schedule-prompts.json`。全局文件只承载手动 settings。
- **「五段 cron 能用。」错。** 正：必须六段，有秒。

### 7.3 可靠性边界

当前没有「错过的 tick 入队」。没有跨进程锁。两个 Pi 共享未绑定作业时，重复开火是接受的行为，不是 bug。会话退出会删掉**本会话能加载的**已禁用作业；别人会话的禁用作业不动。

这是当前可靠性边界。

## 8. 失败形态与排错

按用户能看见的症状查，不要先怀疑时间库。

**到点完全没反应**

1. Pi 当时开着吗？没开 = 设计如此。
2. 作业 `enabled` 吗？一次性开火后会被关掉。
3. 是否绑了别的 session？看 Jobs 浮层只读行。
4. cron 是不是五段？校验会拒，根本挂不上。

不要先怀疑 croner。

**开着 Pi，9 点没响，10 点打开另一扇窗口也不补**

这不是故障。没有队列。

**同一条作业打了两次**

作业很可能没有 `session` 字段，两个 Pi 共享这个 cwd。要么绑会话，要么接受重复。

**Widget 一直转圈 `running`**

上次开火中途进程没了，状态没清。当前版本在 `start()` 时会清掉本会话遗留的 `running`。若你改调度器，不要拿掉这步。

**子 Agent 跑完了，父对话没接话**

看 `notify`。默认 false。父对话只有一条短标记，这是设计。

**想关掉子 Agent 模式，update 报错**

不能把 `model` 更新成空。删了重建。

**会话 reload 后作业双响**

初始化没有先 `stop`。`session_start` 不是一次性事件。

## 9. 总结：可以独立验证的稳定事实

1. **运行形态是 Pi 扩展，不是服务。** 证据：无 `bin` / 无 `main` / 工厂函数 / timer 在宿主进程。
2. **权威数据是项目内 JSON，不是内存、不是 `~/.pi`。** timer 回调开火前必重读。
3. **错过不补跑。** 关 Pi = 心跳停。过期 `once` 变 error，不执行。
4. **开火分叉看 `model`。** 内联进当前对话；子路径是同进程一次性会话，默认最小权限。
5. **所有权规则贯穿所有入口。** 未绑定 = 此 cwd 的每个 Pi 都打，接受重复。

如果只记一条完整主线：

```text
add（工具或 TUI）
  → 唯一校验器
  → 写 .pi/schedule-prompts.json
  → 本进程挂 timer
  → 到点重读 + 核对 session
  → 无 model：注入本对话 / 有 model：内存子会话
  → 先写状态，再画界面
  → Pi 退出：timer 全死，JSON 还在
```

## 10. 深入通道：按调用链读，不要按文件名散读

从运行入口一路往下。每组回答一个问题。

1. `package.json` + `src/index.ts`  
   它怎么接到 Pi 上？看 `pi.extensions`、工具/命令/渲染器注册，以及 `session_start` 先 cleanup 再 init、`session_shutdown` 先清禁用作业再停 timer。

2. `src/types.ts` + `src/storage.ts`  
   Job 长什么样、文件在哪、怎样原子写。看完应能回答「手改 JSON 下一步谁说了算」。

3. `src/scheduler.ts` 的校验、`start`/`stop`、`isLoadedFor`、`executeJob`  
   何时响、谁有权响、响了走哪条。这是本包的心脏。重点看：闭包 Job 被视为过期、开火前 `getJob`、子路径先写状态后发标记。

4. `src/tool.ts`  
   LLM 能做的 add/list/enable/… 以及环检测、重名、不能清空 `model`。和 TUI 必须共用校验器。

5. `src/subagent.ts`  
   `model` 如何解析、默认七件工具、`extensions`/`skills` 怎样从「全关」变成「全开」。注释写明：无子进程、无扩展递归、无持久化。

6. `src/settings.ts` + `src/ui/cron-widget.ts` + `src/ui/jobs-view.ts` + `src/ui/add-flow.ts`  
   人怎么看见、怎么改范围。重点差异：Widget 过滤到本会话；Jobs 浮层能看见外国作业但热键不理它们；Settings 只改新作业默认值。

组末差异：调度逻辑在 `scheduler.ts`，LLM 入口在 `tool.ts`，人机入口在 `ui/`。不要在 Widget 里判断「该不该补跑」——补跑策略如果要做，只能加在调度器的 `start`，并且 Job 模型得记下足够的上次计划时间。

测试是不变量目录，优先 `test/scheduler.test.ts`（会话绑定、`start` 恢复、shutdown abort、标记投毒、500 字截断）。

本仓库另有一份函数级导航：[pi-schedule-prompt.md](./pi-schedule-prompt.md)。和本文冲突时以源码为准。

### 参考资料

- 上游仓库：https://github.com/tintinweb/pi-schedule-prompt
- Pi 扩展机制：https://pi.dev
- 同系列： [看懂 pi-subagents](./看懂%20pi-subagents.md) · [看懂 pi-tasks](./看懂%20pi-tasks.md)

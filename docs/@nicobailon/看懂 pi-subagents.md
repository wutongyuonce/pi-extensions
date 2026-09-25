# 看懂 pi-subagents：独立 `pi` 进程里跑孩子，结果靠磁盘通知回宿主

> 本文面向已经会用 Pi、第一次碰到 `@nicobailon/pi-subagents` 的读者。仓库很大，**不要从类名读起**。重点是：孩子到底是不是独立 session、是不是同进程、worktree 是不是默认；谁把它拉起来；崩溃或写完结果之后，宿主怎么知道。
>
> **本文定位：中大型、二次开发深度。** 正文点到文件级，不逐类铺开。稳定认知放在进程边界、session 文件、结果投递上。工具参数默认值、TUI 文案、并发数字属于易变细节。
>
> 源码基线：本仓库 `@nicobailon/pi-subagents`，包名 `pi-subagents` 版本 `0.62.0`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游：[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)。安装入口：`pi install npm:pi-subagents`。
>
> **先把三套「子代理」切开。** 本仓库根目录还有一个 `pi-subagents/`（交互式 pane / mux 那套）；`pi-dynamic-workflows` 的 `agent()` 是同进程内存 session。三套都叫子代理，运行形态完全不同。本文只讲 `@nicobailon/pi-subagents`。

## 1. TLDR：它不是同进程 session，也不是默认 worktree

用户说「用 reviewer 看这个 diff」，宿主模型调用 `subagent` 工具。扩展在**当前 Pi 进程**里做编排，真正干活的孩子是另一次 `pi` CLI：

```text
用户口语
  → 宿主模型调用 subagent 工具          （宿主进程，同步工具入口）
  → 扩展解析 agent / task / async
        ├─ 前台：本进程 spawn `pi`，堵住这次工具调用直到退出
        └─ 后台（默认）：本进程 spawn jiti runner，立刻把工具结果交还模型
              → runner 再 spawn `pi --session <孩子.jsonl>`
  → 孩子是独立 OS 进程 + 独立 session 文件
  → 孩子写结果 JSON（临时目录）
  → 宿主 watcher 读到文件
  → pi.sendMessage(customType: subagent-notify) 叫醒宿主下一轮
```

**所以它不是：**

- 不是 `createAgentSession()` 嵌在宿主进程里的内存对话（那是 `pi-dynamic-workflows` 的 `agent()`）。
- 不是根目录 `pi-subagents/` 那种「在 Herdr / tmux / zellij pane 里开一个交互孩子」。
- 不是常驻 daemon / 子代理服务器。扩展跟宿主同生共死。
- 不是默认 git worktree。worktree 是可选隔离，要显式开。
- 不是「进程退出 = 宿主已经拿到结果」。进程死了只证明 writer 停了；宿主认账要等结果文件被投递。

**正面定义：** 这是一套 Pi 扩展。它把「命名专家 + 独立 `pi` 进程 + 磁盘结果文件 + 回宿主通知」焊成一条委派链路。孩子有自己的 session 文件（`.jsonl`），环境变量 `PI_SUBAGENT_CHILD=1` 让孩子**不要再注册家长那套扩展**。

专名第一次出现：

- **session 文件**：Pi 把一轮对话记成 `.jsonl`。孩子用 `--session` 指向另一份文件，所以它不是宿主 transcript 的一个线程，是另一次 Pi 会话。
- **runner**：后台路径里夹在宿主和孩子 `pi` 之间的 Node 进程（`subagent-runner.ts`，用 jiti 跑 TypeScript）。宿主不直接盯孩子 stdout。
- **worktree**：`git worktree add` 出来的第二份工作副本。可选，不是每个孩子都有。

## 2. 为什么要独立进程，而不是在宿主里再开一个 session

正例：宿主正在改认证模块，同时想让 reviewer 盯 diff、scout 摸调用图。如果孩子和宿主共用一份 transcript、同一把工具锁，reviewer 的长输出会污染宿主下一轮；scout 的 `bash` 会跟宿主抢 cwd。独立 `pi` 进程 + 独立 session 文件，让「专家」有自己的上下文窗口和退出码。

反例：如果只是想在脚本里扇出几个只读检查、立刻 `await` 拿到结构化 JSON，再决定下一步——那是 `pi-dynamic-workflows` 的 `agent()` 更合适。它故意**不** spawn OS 进程，孩子和宿主同进程、同 cwd，失败时也没有第二份 git 树可丢。

架构判断可以压成四行：

- **宿主模型**决定「要不要委派、委派给哪个 named agent、要不要等」。
- **扩展**决定怎么 spawn、写哪份 session、结果文件归谁。
- **孩子 `pi`** 才真正读仓库、调模型、跑工具。
- **磁盘上的结果 JSON** 才是「孩子说完了」的权威源；进程 PID 只是存活证据。

不要把「扩展注册了 `subagent` 工具」理解成「孩子也在这个工具函数里跑完」。工具函数多数时候只负责**点火**；燃烧发生在另一个进程。

## 3. 先看整体架构，不急着看类名

文档视角（职责）：

```text
接入层     口语 / subagent 工具 / bg_wait / /subagents-fleet / 管理 action
   ↓
编排层     发现 named agent → 解析 async/fork/worktree → 写启动合同
   ↓
拉起层     前台：宿主 spawn pi
           后台：宿主 spawn runner → runner spawn pi
   ↓
孩子运行时  独立 pi 进程；独立 session.jsonl；可选 worktree cwd
   ↓
交接层     结果 JSON + process-terminal.json + session lease
   ↓
回宿主     watcher / 所有权校验 / sendMessage(subagent-notify)
```

进程真相：上面六层**没有**单独的服务进程。接入、编排、watcher、`sendMessage` 都在宿主 Pi 里。多出来的只是：每个孩子一个 `pi` 进程；后台再多一个 runner。

| 节点 | 载体 | 触发 | 同步？ |
|---|---|---|---|
| 用户说话 | 宿主 TUI / headless | 人 | 对用户是一轮对话 |
| `subagent` 工具 | 宿主进程 | 模型发 tool call | 工具入口同步；孩子默认异步 |
| runner | 独立 Node 进程（后台） | 宿主 `spawn` | 异步，unref |
| 孩子 `pi` | 独立 OS 进程 | runner 或宿主 `spawn` | 孩子内部自己跑 turn |
| 结果文件 | `os.tmpdir()/pi-subagents-*/async-subagent-results/` | 孩子/runner 写盘 | 写完 ≠ 宿主已读 |
| 通知 | `pi.sendMessage` | watcher 认定这份结果归本 session | 可能 `triggerTurn` 叫醒模型 |

权威数据源尽早说清：

- **named agent 长什么样**：Markdown + YAML frontmatter。内置在包的 `agents/`，用户在 `~/.pi/agent/agents/`，项目在 `.pi/agents/`。
- **这次 run 的状态**：后台 run 目录里的 `status.json`。
- **这次 run 的结论**：结果目录里的 `<runId>.json`。事件总线只是观察通道，**不是**投递回执。
- **配置**：`~/.pi/agent/extensions/subagent/config.json`（`PI_CODING_AGENT_DIR` 可改根）。
- **给人类看的工件**：项目下 `.pi/subagents/`（输出 md、transcript、progress）。这是交接副本，不是 run 是否成功的权威。权威仍是结果 JSON。

## 4. 运行形态：谁活在哪个进程里

### 4.1 它是扩展，不是服务

`package.json` 的 `pi.extensions` 指向 `./index.ts`。Pi 加载扩展时调用默认导出。没有 listen 端口，没有伴生 daemon。宿主退出，编排层一起没。

入口有一个硬分流：

```text
PI_SUBAGENT_CHILD=1  → 不注册家长扩展
未设置               → 注册 subagent / bg_wait / TUI / watcher
```

证据：`@nicobailon/pi-subagents/index.ts`。孩子进程如果再把整套家长扩展装进去，会套娃 spawn。嵌套委派走另一条窄门（见 4.4）。

### 4.2 孩子是独立 session，也是独立进程

孩子命令由 `src/runs/shared/pi-spawn.ts` 解析：优先 `PI_SUBAGENT_PI_BINARY`，否则当前 Node + 已安装的 `@earendil-works/pi-coding-agent` CLI，再否则 PATH 上的 `pi`。参数里会带 `--session <孩子.jsonl>`（`src/runs/shared/pi-args.ts`）。

所以同时成立两件事：

1. **独立进程**：`child_process.spawn`，不是 `createAgentSession()`。
2. **独立 session**：另一份 `.jsonl`。fork 只是把家长 transcript **拷贝/裁剪**进这份新文件，不是共享同一个打开的 session 对象。

`session-lease`（`src/runs/shared/session-lease.ts`）保证同一份 session 文件同一时刻只有一个 writer。resume 走的是文件，不是「把旧对象从内存里捞回来」。

### 4.3 worktree 不是默认形态

`src/runs/shared/worktree.ts` 会 `git worktree add`，分支前缀默认 `pi-subagents/`。这是**可选隔离**：并行改代码、互不踩工作区时才开。只读 scout / reviewer 通常就在宿主 cwd 里跑。

文档视角常把「子代理」画成「每人一棵树」。进程真相：没开 worktree 的孩子和宿主抢同一份磁盘。失败时没有第二份树可 `discard`。

### 4.4 前台、后台、嵌套，三条进程图

**前台**（`async: false`，或配置把 `asyncByDefault` 关掉）：

```text
宿主 Pi ──spawn──► 孩子 pi ──stdout JSONL──► 宿主解析 ──工具结果返回模型
```

宿主这次 tool call **堵住**。孩子退出后，工具结果里已经有输出。仍可能再发一条 `subagent-notify`，但模型不必等通知才看见结论。

**后台**（默认；`asyncByDefault !== false`）：

```text
宿主 Pi ──spawn jiti+runner──► runner 进程（detached，Windows 除外）
                                └──spawn──► 孩子 pi
宿主工具立刻返回「已点火」
runner 写结果 JSON ──► 宿主 watcher ──► sendMessage
```

宿主 `unref()` runner，自己继续下一轮。孩子崩溃时，宿主当时可能已经在干别的事。

**嵌套**：孩子若被允许再委派（agent frontmatter `tools: subagent` 或 `allowNestedSubagents`），孩子进程会走 `src/extension/fanout-child.ts`：仍注册名为 `subagent` 的工具，但管理动作缩成 list/status/steer 这类只读或轻控制，禁止 delete/eject。深度由 `PI_SUBAGENT_DEPTH` / `maxSubagentDepth` 卡住。

### 4.5 常驻吗？谁拉起？

不常驻。每一次委派都是一次 spawn。拉起者永远是**当前这次工具调用所在的那个 Pi 进程**（家长或被允许 fanout 的孩子）。

Mission 和 schedule 容易被看成「后台服务」。进程真相：

- **Mission**（`src/missions/`，记录默认在 `~/.pi/agent/missions/projects/<hash>/`）是**耐久账本**：为什么委派、绑了哪些 run id、工件路径、外部回执。它不跑孩子。自动建账失败默认不阻断 run（`details.missionWarning`）；显式 `missionId` 才会在点火前严格失败。`mission: false` 表示这次故意不留账。
- **Schedule** 也不是 crontab。到期检查发生在宿主扩展还活着的时候，真正干活仍走第 6 章那条 spawn。

家长进程都没了，账本还在磁盘上，但没有人会凭空把孩子再拉起来——除非另一次 Pi 会话读到这份账、再调用 `subagent`。

## 5. 变体：三套「子代理」不要混

本仓库里至少有三种完全不同的东西都叫子代理。二次开发先认准路径。

| | `@nicobailon/pi-subagents`（本文） | 仓库根 `pi-subagents/` | `pi-dynamic-workflows` 的 `agent()` |
|---|---|---|---|
| 来源 | Nico Bailon，npm `pi-subagents` | 根目录另一份扩展（HazAT 交互式 fork 一脉） | Michaelliv，prototype |
| 孩子形态 | spawn 真正的 `pi` CLI | 也 spawn `pi`，但目标是 Herdr/tmux/zellij **pane** 或 `pi -p` | **同进程** `createAgentSession`，内存 `SessionManager` |
| session | 独立 `.jsonl`，`--session` | 独立 session + 交互 pane | 内存消息数组，用完 `dispose` |
| worktree | 可选 git worktree | 不是主故事 | 无；和宿主同 cwd |
| 结果怎么回 | 结果 JSON → watcher → `sendMessage` | pane / widget / 父子通信 | `await agent()` 的 Promise |
| 编排脚本 | `workflowScript`：worker 线程里的 vm，**里面的 `runs.run` 仍 spawn `pi`** | orchestrator 模式 | `agent()` / `parallel` / `pipeline` 就在 vm 里调同进程 session |
| 崩溃单元 | runner + 孩子进程组 | pane 里的 `pi` | 无第二进程；throw / 返回文本 |

一句话：**看到 `agent()` 先问在哪个包。** nicobailon 的脚本原语叫 `runs.run` / `runs.all`，不是 `agent()`。根目录那套的主故事是「交互孩子占一个终端 pane」。dynamic-workflows 的主故事是「脚本沙箱 + 同进程短命 session」。

外部 CLI 适配（`claude-code`、`codex-exec`、`cursor-agent`）是第四条岔路：孩子根本不是 Pi，是别人的 CLI。fork context、structured output、Pi 工具预算对它们多数不适用。本文主线不展开。

## 6. 纵向链路 A：从口语到孩子开始跑

按语义层切。每一层写清载体和「完成 ≠ 就绪」。

### 6.1 用户层：人说「用 reviewer 看 diff」

载体：宿主 Pi 会话。同步于用户。扩展可以零配置起步——内置 agent 名在 `src/agents/builtin-names.ts`：`scout` / `reviewer` / `worker` / `oracle` / `advisor` 等。人不需要先写 YAML。

完成 ≠ 就绪：用户说完只证明宿主模型**看见了请求**。此时还没有孩子进程。

### 6.2 宿主模型层：决定调用 `subagent`

载体：宿主模型的 tool call。扩展在 `src/extension/index.ts` 注册工具名 `subagent`。描述里会强烈暗示：默认后台、别为了等结果就 `async: false`、普通完成会自己 notify，不要用 `bg_wait` 空转。

完成 ≠ 就绪：tool call 被接受，只证明参数过 schema。agent 名对不对、cwd 在不在，还在后面。

### 6.3 发现层：Markdown 变成启动合同

载体：宿主进程读盘。`src/agents/agents.ts` 按范围合并：包内置 → 用户目录 → 项目 `.pi/agents/`。同名时项目覆盖用户覆盖内置。

每个 agent 是「frontmatter 约束 + 系统提示」。`tools` / `model` / `defaultContext` 是合同字段，不是建议。

完成 ≠ 就绪：发现成功只证明「有这个名字」。还没 spawn。

### 6.4 启动计划层：cwd、输出路径、fork 还是 fresh

载体：`src/runs/shared/child-launch-plan.ts`。算出孩子 cwd、输出文件、要不要带 skills。

`context` 两种：

- **fresh**：空 session 文件，孩子只看见这次 task。
- **fork**：从家长 transcript 派生一份新 `.jsonl`。默认会对超长内容做裁剪（`src/shared/pruned-fork.ts`），不是无损复制。`worker` / `oracle` / `advisor` 省略 `context` 时偏向 fork；家长还没有可持久化 session 时退回 fresh。

完成 ≠ 就绪：计划写完不等于孩子已启动。fork 裁剪要另一次模型调用时，家长可能先卡一下。

### 6.5 拉起层：真正出现第二个进程

前台：`src/runs/foreground/execution.ts` 里 `getPiSpawnCommand` + `spawn`。宿主听孩子 stdout 的 JSON 行（协议在 `src/runs/shared/child-protocol.ts`），拼进度、等退出。

后台：`src/runs/background/async-execution.ts` 把配置写成临时 `async-cfg-*.json`，然后：

```text
node + jiti CLI + src/runs/background/subagent-runner.ts + cfgPath
```

runner 通过启动屏障（startup proceed 文件）才被允许继续，避免「进程已创建、合同还没写完」的窗口。然后 runner 再 spawn 孩子 `pi`。POSIX 上 runner `detached: true`。

完成 ≠ 就绪：

- 前台：`spawn` 返回只证明 PID 有了。终端事件（assistant stop / agent settled）才是「孩子自己认为说完了」。
- 后台：工具结果「queued/running」只证明 runner 已拉起。宿主模型此时**不**掌握孩子输出。

## 7. 纵向链路 B：孩子写完之后，结果怎么回到宿主

这条才是后台路径的心脏。前台路径大部分被 6.5 的阻塞调用吃掉，但所有权、去重、通知格式仍共用。

### 7.1 孩子运行层：独立 Pi turn

载体：孩子 `pi` 进程。它有自己的模型调用、自己的工具、自己的 session 追加。环境变量包括 `PI_SUBAGENT_CHILD=1`、`PI_SUBAGENT_CHILD_AGENT`、家长 session id、steer inbox 路径等。

孩子**看不到**打包给家长的 `pi-subagents` skill，避免它再教自己「如何当编排者」。

完成 ≠ 就绪：孩子最后一条 assistant 文本已经出现在它自己的 `.jsonl` 里，家长会话还一无所知。

### 7.2 落盘层：结果 JSON 是权威

载体：`src/runs/background/result-files.ts`。结果写在：

```text
$TMPDIR/pi-subagents-<scope>/async-subagent-results/<runId>.json
```

另有按 session / run 建的索引，以及 `result-pending/`。后台 run 自己的工作目录在 `async-subagent-runs/<runId>/`，里面有 `status.json`、`process-terminal.json`、runner 日志。

`TEMP_ROOT_DIR` 可用 `PI_SUBAGENTS_TEMP_ROOT` 改；默认按用户 home 做隔离，避免多用户抢同一临时根。

完成 ≠ 就绪：文件出现在目录里，只证明 runner **打算**交接。没通过所有权校验之前，宿主模型不会被叫醒。

### 7.3 进程死亡层：和结果文件分开记账

载体：`src/runs/background/process-terminal.ts` + `owned-process-tree.ts`。POSIX 上 runner/孩子按进程组 SIGTERM，超时 SIGKILL，再用 `ps` 核对组内是否还有活成员。

这是「进程真相」。它可以证明 writer 不在了，**不能**单独当成功。成功必须有结果 JSON 且 `success` 对得上。

完成 ≠ 就绪：`process-terminal.json` 写好，只证明杀干净或观察到退出。宿主仍可能还没投递。

### 7.4 监视层：宿主进程里的文件 watcher

载体：`src/runs/background/result-watcher.ts`，活在宿主扩展里。session 启动时挂上，shutdown 时拆。用 fs watch（或退化为轮询）看结果目录。

读到文件后：

1. 解析 `sessionId` / `completionOwnerId` / `runId`。
2. **所有权**：`result-delivery-ownership.ts` 要求 `completionOwnerId` 等于本宿主这次 runtime 的 owner，且 session 对得上。防止把别人的完成通知灌进当前对话。
3. 去重：同一完成键 TTL 内只投一次。
4. 事件总线发 `subagent-async-complete`——这是观察，不是回执。
5. 真正投递给模型的是下一步。

完成 ≠ 就绪：watcher 打印了日志 ≠ 模型已经读到。

### 7.5 投递层：`sendMessage` 才算回到对话

载体：`src/runs/background/notify.ts`。`pi.sendMessage({ customType: "subagent-notify", content, display }, { triggerTurn })`。

注释写得很死：**结果文件只有在 `sendMessage` 接受之后才删。** 事件总线不是 acknowledgement。`sendMessage` 抛错就当没投出去，文件留着重试。

`triggerTurn: true` 会让宿主模型再跑一轮，把通知当新输入消化。成功的后台完成可以故意 `display: false`，避免闲置 tab 被标未读；失败 / 暂停 / 前台来源仍显示。

完成 ≠ 就绪：`sendMessage` 成功 = 通知进了宿主会话。模型是否据此改代码，是下一轮的事。compaction 期间扩展甚至会另发 `subagent-compaction-resume`，避免家长压缩完把后台结果忘了。

### 7.6 中途插话：steer 也是文件，不是共享内存

孩子跑起来之后，家长还能 `steer` / `follow_up` / `interrupt`。载体不是 RPC 进孩子 V8，而是 run 目录里的 inbox 文件（`src/runs/background/control-channel.ts`）。runner 盯着 inbox，把请求转给还活着的孩子 `pi`。

所以「家长和孩子在对话」的进程真相是：两个进程 + 一截磁盘队列。孩子已经退出，steer 文件再漂亮也没人读。inbox 被 close 之后，后续 steer 必须失败，而不是假装写进了已死的 session。

完成 ≠ 就绪：steer 请求落盘只证明家长写完了。孩子 ack 之前，不要当成它已经改了行为。

### 7.7 等待层：`bg_wait` 不是默认完成路径

载体：工具名 `bg_wait`（`src/runs/background/wait-tool.ts`）。只给「没有原生通知」的工作：外部 provider job、被 detach 的前台 run、headless 需要在 `agent_end` 排干的情况。

交互会话里，普通异步子代理**已经会 notify**。模型再 `bg_wait` 只为了等，是在浪费一轮。这是合同，不是风格建议。

### 7.8 验收门：孩子说完了 ≠ 合同通过

载体：`src/runs/shared/acceptance.ts`，在孩子进程退出之后、结果定稿之前。agent frontmatter 可以要求 attested / checked / verified（测试命令、git 是否脏、变更证据）。跑的是家长或 runner 这边的检查，不是孩子模型再嘴硬一次。

完成 ≠ 就绪：孩子 `.jsonl` 里已经有最终回复，验收失败仍会把这次 run 标成未通过。不要只读 assistant 文本就宣布 worker 交货。

## 8. 纵向链路 C：`workflowScript` 仍在 spawn `pi`

nicobailon 也有「一段 JS 扇出孩子」。它看起来像 dynamic-workflows，骨架不同。

```text
宿主模型填写 workflowScript 字符串
  → 扩展做静态校验（语法、runs.run 字面量 key、禁止嵌套 async 函数）
  → worker_threads 里跑 vm
  → 脚本调用 runs.run / runs.all
  → 每一次 run 仍然走第 6–7 章那条「spawn pi」链路
  → vm 的返回值成为这次 subagent 工具的输出（前台）或结果 JSON 的一部分（后台）
```

载体：`src/workflows/scripted-workflow.ts`。脚本在 **worker + vm** 里，没有 `fs`、没有随便 `require`。这只隔离**编排代码**。被编排的孩子不是 vm 里的函数，是外面的 `pi` 进程。

和 `pi-dynamic-workflows` 的差别：

- 那边 `agent()` = 同进程 `createAgentSession`，return 值就是孩子最后一句话或 `structured_output`。
- 这边 `runs.run('key', { agent, task })` = 点火独立 `pi`，await 的是那次 run 的交接记录（output / 状态 / 工件路径）。
- 这边有持久化 run 目录、结果文件、mission、resume；那边明确是 prototype，没有持久化 run。

完成 ≠ 就绪：脚本校验通过只证明形状合法。一个从不调用 `runs.run` 的脚本，不会凭空长出孩子。`runs.all` 返回**数组**不是 key map——这是行为合同，写错会在运行时拿到 `undefined`。

## 9. 边界、概念区分、常见误区

**session ≠ 进程 ≠ worktree ≠ 结果文件**

四个东西可以各自存活：

- 进程死了，session `.jsonl` 还在，可以 resume。
- worktree 还在，不代表孩子还在跑。
- 结果文件在，不代表当前这个宿主 session 有权投递（owner 不对就丢给对的人）。
- 宿主 session 被 compact / reload 后，`completionOwnerId` 会换；旧文件要靠所有权规则决定是投还是忽略。

**fork ≠ 共享会话对象**

fork 是「把家长 transcript 变成孩子启动时的一份新 jsonl」。两边之后各自追加。家长后来说的话，孩子不会自动看见，除非你 `steer`。

**工具返回「已启动」≠ 任务成功**

后台路径的同步返回值是点火回执。成功/失败在后来的 `subagent-notify` 里。把点火回执当结论，是这条扩展最常见的逻辑错误。

**不要和根目录 `pi-subagents/` 对着读源码**

根目录那套的 `src/launch/child-command.ts` 也在找 `pi` 二进制，也在 spawn。相似点到此为止。它的产品目标是交互 pane、mux、parent-close-policy。本包的产品目标是「委派合同 + 监督 + 磁盘交接」。文件名撞车（两边都有 `child-launch-plan`）不表示能互相 import。

**不要把 `workflowScript` 里的 `runs.run` 念成 `agent()`**

二次开发时搜 `agent(` 会进错包。本包脚本 API 是 `runs`。

**Mission 不是 runner**

`~/.pi/agent/missions/` 里有 JSON 不表示有进程。没有宿主 Pi 读这份账，就不会有下一次 spawn。

## 10. 失败形态：崩溃之后谁还活着

按症状查，不按类名查。

| 你看见的 | 先查哪一层 | 通常已经发生了什么 |
|---|---|---|
| 工具立刻回来，过了很久没有 notify | 7.4 watcher / 7.2 结果目录 / owner | runner 还在，或结果写了但 sessionId 对不上 |
| notify 说 failed，session 文件还在 | 7.1 孩子 turn / 孩子 `.jsonl` | 进程已死，对话可 resume |
| 家长退出，后台还在跑 | 4.4 detached runner | POSIX 上 runner 不跟家长进程组；这是设计，不是泄漏的唯一解释 |
| 磁盘满 / ENOSPC | 结果写入走 capacity-resilient 路径 | 可能留下 pending，不删源文件 |
| 两个孩子抢同一 session 文件 | session-lease | 后到的会冲突失败，而不是静默互写 |
| 孩子被 SIGKILL | 7.3 进程组 | `process-terminal` 可能是 `observed`，结果 JSON 仍可能写成 failed |
| 家长 reload 后重复通知 | 7.4 去重 + owner | 旧 owner 的文件不该进新 session；否则是所有权 bug |
| `bg_wait` 立刻返回 | waitTool 被关掉，或根本没有无通知的活 | 不要用它等普通 async 孩子 |
| 脚本报 nested async | 8 的静态校验 | 改成顶层 await / 普通函数，不是换 spawn 方式 |
| 孩子有长回复但 run 仍失败 | 7.8 验收门 | 文本交货了，合同检查没过 |
| Fleet 里永远 running | 7.3 / stale reconciler | 家长重启前 runner 已死，结果没写成 |

前台还有硬超时：孩子已经发出终端事件但仍不退出，会 SIGTERM，再宽限后 SIGKILL。这解决的是「协议上说完了、进程卡住」——不是模型质量问题。

`stale-run-reconciler.ts` 在家长重启后扫未交接的 run：PID 已死但没有结果，就补一份失败结果，避免 Fleet 里永远 `running`。

## 11. 总结：可验证的稳定事实

1. **孩子是独立 OS 进程里的另一次 `pi`，带着自己的 `--session` 文件。** 不是宿主进程里的 `createAgentSession`。
2. **扩展活在宿主进程；后台默认再夹一个 runner 进程。** 没有子代理服务器。
3. **worktree 可选，默认不是。** 没开就和宿主共用工作区。
4. **后台完成的权威是结果 JSON + `sendMessage` 成功，不是 PID 退出。** 事件总线只观察。
5. **`workflowScript` 的 vm 只跑编排；`runs.run` 仍 spawn `pi`。** 不要和 `pi-dynamic-workflows` 的 `agent()` 混。

主线：

```text
用户 → 宿主模型 → subagent 工具
                 →（默认）spawn runner → spawn pi --session 孩子.jsonl
                 → 孩子跑完写结果 JSON
                 → 宿主 watcher 校验 owner
                 → sendMessage(subagent-notify) → 宿主下一轮
```

## 12. 源码阅读顺序

二次开发按这个顺序读，到文件级即可。

1. `@nicobailon/pi-subagents/index.ts` — 为什么孩子进程不注册家长扩展。看了能懂进程分流。
2. `src/extension/index.ts` — 工具注册、session_start 挂 watcher、compaction 恢复。看了能懂「谁活在宿主里」。
3. `src/runs/shared/pi-spawn.ts`、`src/runs/shared/pi-args.ts` — 孩子命令行和 `PI_SUBAGENT_CHILD=1`。看了能懂独立 session 怎么点着。
4. `src/runs/foreground/execution.ts` — 前台 spawn、stdout 协议、超时杀进程。看了能懂堵住的那条路。
5. `src/runs/background/async-execution.ts`、`src/runs/background/subagent-runner.ts` — 两跳 spawn。看了能懂默认后台。
6. `src/runs/background/result-files.ts`、`result-watcher.ts`、`notify.ts`、`result-delivery-ownership.ts` — 落盘到叫醒。看了能懂崩溃/成功如何回宿主。
7. `src/runs/background/process-terminal.ts`、`owned-process-tree.ts`、`stale-run-reconciler.ts`、`src/runs/shared/acceptance.ts` — 进程死 ≠ 交接完；说完 ≠ 验收过。
8. `src/runs/shared/session-lease.ts`、`src/shared/pruned-fork.ts` — 文件所有权和 fork 裁剪。
9. `src/runs/shared/worktree.ts` — 可选隔离，别当成默认。
10. `src/workflows/scripted-workflow.ts` — `runs.run` 仍是 spawn，不是同进程 `agent()`。
11. `src/runs/background/control-channel.ts` — steer/interrupt 的磁盘 inbox。看了能懂家长插话不走共享内存。
12. `src/extension/fanout-child.ts` — 嵌套时孩子手里那把缩水的 `subagent`。
13. `src/agents/agents.ts`、`agents/*.md` — named agent 从哪来。看了能懂合同字段。
14. `src/missions/` — 账本不是运行时。看了能懂「记录还在」和「孩子还在」为什么能分开。

本地冒烟：`pi install` 本目录或 `npm:pi-subagents`，`/reload`，然后说「用 scout 列出本仓库主模块」。应看到 `subagent` 工具调用、后台进度、随后一条 `subagent-notify`。同一时刻 `ps` 里多一个 `pi`（后台再多一个 node/jiti）。这比读 Fleet TUI 更能证明进程形态。

对照实验（可选，用来钉死第 5 章）：在装了 `pi-dynamic-workflows` 的会话里跑一个 `agent()` workflow——`ps` 不应为每个子任务多一个 `pi`。两边都叫子代理，进程表不会说谎。

## 参考资料

- [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)
- 包内 `docs/agents.md` / `docs/workflows.md` / `docs/observability.md` / `docs/tool-reference.md` / `docs/configuration.md`
- 本仓库对照笔记：`docs/看懂 pi-dynamic-workflows.md`（同进程 `agent()`）
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

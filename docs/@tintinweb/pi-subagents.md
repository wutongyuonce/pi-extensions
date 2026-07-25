# pi-subagents 项目解析与源码导航

本文件配合 `pi-subagents-source-course/index.html` 使用：网页负责按一次调用讲清主线和互动练习；本文件负责把源码位置、函数职责和从零实现顺序压缩成可检索的地图。

## 一句话模型

这是一个 pi 扩展。它在宿主 pi 中注册 Claude Code 风格的 `Agent`、`get_subagent_result`、`steer_subagent` 工具，将一次子代理请求转换为独立 `AgentSession`，并用 `AgentManager` 保存状态、限制后台并发、提供 UI、通知、恢复、工作树与定时任务。

主链路：

`pi 加载 src/index.ts` → `Agent 工具参数校验/解析` → `resolveAgentInvocationConfig` → `AgentManager.spawn/spawnAndWait` → `runAgent` → `createAgentSession + bindExtensions + session.prompt` → 事件回流更新 `AgentRecord` → widget/fleet/viewer/通知读取记录。

## 先读的 8 个文件

1. `package.json`：确认入口为 `src/index.ts`，依赖的 pi API 与测试命令。
2. `src/types.ts`：全局契约；先认识 `AgentConfig`、`AgentRecord`、`ScheduledSubagent`。
3. `src/index.ts`：装配根；注册工具、命令、生命周期、UI、RPC、调度器。
4. `src/agent-manager.ts`：任务真相来源；状态、队列、并发、停止和恢复。
5. `src/agent-runner.ts`：执行真相来源；把配置装配成真实 pi 会话。
6. `src/agent-types.ts` + `src/custom-agents.ts`：角色配置如何被读取、合并、覆盖。
7. `src/prompts.ts` + `src/context.ts`：系统提示词和父会话上下文如何进入子代理。
8. `test/agent-manager.test.ts`、`test/agent-runner.test.ts`：把边界行为当作可执行说明书阅读。

## 目录和职责

| 位置 | 职责 | 不应该放什么 |
| --- | --- | --- |
| `src/index.ts` | pi 适配层、注册入口、组合对象 | 队列算法、会话构造细节 |
| `src/agent-manager.ts` | 任务状态、后台队列、生命周期 | 解析 YAML、UI 渲染 |
| `src/agent-runner.ts` | 会话创建、提示词/工具/扩展装配、事件桥接 | 管理多个任务的全局队列 |
| `src/*agents*.ts` | 类型注册与 Markdown 配置加载 | 真正执行模型调用 |
| `src/ui/` | 从 `AgentRecord` 渲染终端 UI | 自己维护第二份任务状态 |
| `src/schedule*.ts` | 定时表达式、持久化、触发 | 普通 Agent 的队列策略 |
| `src/memory.ts`、`worktree.ts`、`output-file.ts` | 文件系统边界 | 业务调度 |

## 核心数据结构：每个字段为什么存在

### `AgentConfig`（`src/types.ts`）

这是“某类代理的静态蓝图”。`name/displayName/description` 服务注册表与 UI；`builtinToolNames/extSelectors/disallowedTools/extensions/excludeExtensions` 描述能力边界；`skills/model/thinking/maxTurns` 描述运行策略；`systemPrompt/promptMode` 描述人格和提示词拼接方式；`memory/isolation/persistSession/outputTranscript` 描述持久化与隔离。

关键判断：`builtinToolNames` 为 `undefined` 表示“没有声明限制，使用全部内置工具”；`[]` 则表示“明确不给任何内置工具”。这两个值不能混为一谈。

### `AgentRecord`（`src/types.ts`）

这是“一次具体运行”的可变事实来源。`id` 是外部句柄，`status` 驱动 UI/通知，`session` 用于转向和恢复，`abortController` 用于停止，`promise` 给前台等待，`pendingSteers` 解决会话尚未建立时的转向竞争，`lifetimeUsage/compactionCount` 让 token 指标跨压缩持续正确，`worktree/outputFile` 保存外部资源的清理句柄。

状态语义不能合并：`queued` 尚未启动；`running` 正在运行；`completed` 正常完成；`steered` 是触发软 turn 限制后收尾；`aborted` 是运行器强制中止；`stopped` 是用户主动停止；`error` 是配置/运行失败。

## 主线 A：一次 `Agent()` 调用

### 1. 入口层：`src/index.ts`

入口函数创建 `AgentManager`，再注册 pi 工具、`/agents` 命令、渲染函数、事件监听和 RPC。它的定位是**编排**：输入来自 pi，输出仍回到 pi；它不应直接实现队列或构造底层会话。

阅读 `index.ts` 时按工具处理器分段：`Agent` 负责参数/类型/调用策略；`get_subagent_result` 从 manager 取结果；`steer_subagent` 给 manager 发转向；`/agents` 打开管理菜单。搜索 `registerTool`、`registerCommand`、`new AgentManager` 是最快定位方法。

### 2. 调用策略：`src/invocation-config.ts`

`resolveAgentInvocationConfig(...)` 把“本次工具调用”和“类型蓝图”按优先级合并，产出模型、思考等级、最大轮数、隔离、上下文继承和后台标记；它避免在 `index.ts` 中散落重复的 `??` 判断。

`resolveJoinMode(...)` 只处理后台完成通知的 join 策略。把它从执行层抽走，意味着 UI/通知策略不会影响代理是否执行。

### 3. 类型解析：`src/agent-types.ts`

- `BUILTIN_TOOL_NAMES`：通过 pi 自己的工具工厂动态取名，而非手写常量，跟随上游新增工具。
- `registerAgents`：清空旧表，先放默认角色，后放用户角色；后者自然覆盖同名键。
- `resolveType/getAgentConfig`：通过私有 `resolveKey` 大小写不敏感地查找。
- `getAvailableTypes/getAllTypes/getDefaultAgentNames/getUserAgentNames`：分别服务可调用列表与管理 UI。
- `isValidType`：同时验证存在且未 disabled。
- `getMemoryToolNames/getReadOnlyMemoryToolNames`：为记忆功能补齐最低工具集合，避免重复。
- `getToolNamesForType`：保留 `undefined`（全工具）与空数组（无内置工具）的语义。
- `getConfig`：给旧/简单调用方一个兼容视图；未知类型回退 `general-purpose`，最后有绝对回退。

### 4. 执行前的排队：`src/agent-manager.ts`

`spawn` 先用 `assertValidSpawnCwd` 检查调用方给的 cwd 是已存在的绝对目录；这是 RPC 可能携带任意 JSON 时的防线。它创建 `AgentRecord` 和 AbortController，后台且到达 `maxConcurrent` 则保存 `{ id, args }` 到 FIFO 队列，否则进入 `startAgent`。

`startAgent` 是唯一启动点：必要时先创建 worktree，再把运行器回调接到 record（工具次数、文本、用量、压缩、session 就绪），最后处理成功、失败、worktree 清理、完成通知和 `drainQueue`。这里的关键规则是：状态变化先写 record，UI 只观察 record。

`drainQueue` 在名额释放或最大并发提高时循环启动任务；若队列任务延迟启动时 cwd 已消失，任务转为 `error` 而不是让整个队列卡死。

`spawnAndWait` 是前台包装：临时安装 `onSpawned` 钩子以便输出文件在流开始前就准备好，然后等待 record.promise。`resume` 复用已有 session；`steer` 对未就绪会话写入 `pendingSteers`，避免丢指令；`abort` 停止会话/排队项；查询方法供工具和 UI 使用。

## 主线 B：`runAgent` 如何造出子会话

`src/agent-runner.ts` 很长，因为它承担“边界适配器”而非单纯模型调用。按以下区块读：

1. 名称与配置解析：`extensionCanonicalName`、`extensionCanonicalNames`、`parseExtensionsSpec`、`parseExtSelectors` 统一扩展路径、包名、`extensions:` 和 `tools: ext:*` 的声明。
2. 动态工具作用域：`installExtensionToolScope` 处理 MCP 等扩展**晚于会话创建**才注册工具的问题。静态 allowlist 会漏掉晚到工具，因此对有扩展的场景改用排除列表和实时范围判定。
3. 运行默认值：`normalizeMaxTurns` 将 0 规范为无限；getter/setter 是 settings 与运行器之间唯一的全局策略接口。
4. 文本与错误收集：`collectResponseText`、`getLastAssistantText`、`finalTurnError` 从事件流和历史中可靠取出“本次运行”的最终文本；边界索引避免 resume 时把上次答案误当本次结果。
5. `runAgent`：合并 cwd/configCwd、环境、记忆、技能、提示词、扩展、模型、工具、会话目录；创建 `DefaultResourceLoader`，再 `createAgentSession`、绑定扩展、订阅事件、可选前置父上下文、`session.prompt`，并在 finally 中解绑订阅。
6. `resumeAgent`：同样用“开始消息下标”限定本次输出；`steerAgent` 只是会话 API 的窄包装；`getAgentConversation` 把结构化消息格式化给对话查看器。

turn 限制是两阶段：达到 `maxTurns` 时 `session.steer` 要求立刻收尾；达到 `maxTurns + graceTurns` 才 `abort`。这样兼顾成本上限与完整结果。

## 配置、提示词、外部能力

| 文件 | 函数/类 | 精确定位 |
| --- | --- | --- |
| `default-agents.ts` | `DEFAULT_AGENTS` | 内置 general-purpose、Explore、Plan；Explore/Plan 为 read-only replace prompt，general-purpose 为 append prompt。 |
| `custom-agents.ts` | `loadCustomAgents` | 从项目 `.pi/agents`、`.agents/agents` 和全局位置读 Markdown frontmatter，生成 `AgentConfig`。 |
| `prompts.ts` | `buildAgentPrompt` | 将配置、cwd、环境、父提示词及 memory/skill extras 拼成最终 system prompt。 |
| `context.ts` | `extractText`、`buildParentContext` | 从 pi 的结构化 content 提取文字，并为 inherit_context 构造有限的父对话桥。 |
| `model-resolver.ts` | `resolveModel` | 对 provider/modelId 做精确、模糊、跨 provider 回退匹配。 |
| `enabled-models.ts` | `readEnabledModels`、`resolveEnabledModels`、`isModelInScope` | 读取 pi scoped model 配置，并在开启 scope 后验证模型。 |
| `skill-loader.ts` | `preloadSkills` | 预读指定 `SKILL.md`，把内容作为 prompt extras 注入。 |
| `env.ts` | `detectEnv` | 检测 git、分支和平台，供提示词与 UI 使用。 |

## 可靠性和持久化：函数导航

| 文件 | 函数/类 | 精确定位 |
| --- | --- | --- |
| `memory.ts` | `isUnsafeName/isSymlink/safeReadFile` | 防目录穿越与链接绕过，安全读取记忆。 |
|  | `resolveMemoryDir/ensureMemoryDir/readMemoryIndex` | 根据 user/project/local 范围定位并初始化目录。 |
|  | `buildMemoryBlock/buildReadOnlyMemoryBlock` | 向可写或只读代理说明记忆规则。 |
| `worktree.ts` | `createWorktree` | 创建临时分支和 worktree，计算子目录映射。 |
|  | `cleanupWorktree` | 有变更时保留分支并返回结果；无变更时删除。 |
|  | `pruneWorktrees` | 处理遗留 worktree 元数据。 |
| `output-file.ts` | `encodeCwd/createOutputFilePath` | 可逆/稳定地把 cwd 与 agent id 映射为转录路径。 |
|  | `writeInitialEntry/streamToOutputFile` | 写 JSONL 开头和持续的会话事件流。 |
| `usage.ts` | `getLifetimeTotal/addUsage/getSessionTokens/getSessionContextPercent` | 统一 token 统计与上下文占用率，避免 UI 口径分裂。 |
| `settings.ts` | `loadSettings/saveSettings/applySettings` | 读取、保存并把设置分发到各个运行部件。 |
|  | `persistToastFor/applyAndEmitLoaded/saveAndEmitChanged` | 将设置持久化结果变成 UI 提示与事件。 |

## 调度、RPC 与 UI：函数导航

| 文件 | 函数/类 | 精确定位 |
| --- | --- | --- |
| `schedule-store.ts` | `resolveStorePath`、`ScheduleStore` | session-scoped JSON 的路径、PID 锁、读写迁移。 |
| `schedule.ts` | `SubagentScheduler` | 解析 cron/interval/once，恢复、启动、停止、触发后台 spawn。 |
| `group-join.ts` | `GroupJoinManager` | 汇总近时间窗口内的后台完成通知。 |
| `cross-extension-rpc.ts` | `PROTOCOL_VERSION`、`registerRpcHandlers` | 通过 pi event bus 实现 ping/spawn/stop 及标准回复包络。 |
| `status-note.ts` | `getStatusNote` | 将内部状态转为用户可读的简短说明。 |
| `ui/agent-widget.ts` | `format*`、`describeActivity`、`AgentWidget` | 格式化 token/时间/turn/调用标签，实时渲染上方小组件。 |
| `ui/fleet-list.ts` | `formatFleet*`、`FleetList` | 渲染可键盘导航的 main + subagent 列表。 |
| `ui/conversation-viewer.ts` | `ConversationViewer` | 渲染滚动对话、暂停跟随、内联转向和停止确认。 |
| `ui/viewer-keys.ts` | `createViewerKeys` | 集中管理查看器按键。 |
| `ui/schedule-menu.ts` | `showSchedulesMenu` | 显示、启停、删除已持久化的 schedule。 |

## 从零复刻：建议提交顺序

1. 定义 `AgentRecord` 和最小 manager，仅支持一个前台任务；为 completed/error/stopped 写测试。
2. 写一个独立 `runAgent`，只做 `createAgentSession → prompt → text`；用 fake pi 测输出边界。
3. 让 manager 接收 runner 回调，加入 `AbortController`、会话保存、steer/resume。
4. 加后台队列和 `maxConcurrent`，测试 queued、完成 drain、bypassQueue、延迟失败。
5. 加 `AgentConfig` 注册表和 frontmatter loader；把角色策略从代码移出。
6. 加 prompt/context/model/tool scope；先实现静态工具，再处理扩展的异步注册。
7. 加 memory、output transcript、worktree、schedule；每个文件系统写入点必须有路径和清理测试。
8. 最后接 widget、fleet、viewer、命令与通知；UI 只能读 manager 的记录。

## 如何做到“逐行”而不是迷路

逐行阅读应当服务于一个问题，而不是机械扫描。对任何函数，用这五问标注每一段代码：输入从哪里来？它读取/写入哪个状态？是否调用外部系统？失败时状态如何变化？谁消费输出？

本项目最值得逐行精读的函数依次为：`AgentManager.spawn`、`AgentManager.startAgent`、`runAgent`、`resolveAgentInvocationConfig`、`buildAgentPrompt`、`loadCustomAgents`、`SubagentScheduler` 的触发逻辑。其余函数多数是这些主链的纯工具、展示适配或安全边界；先掌握主链，回看它们时每一行才有定位。

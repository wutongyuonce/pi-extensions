# 看懂 pi-todo：把多步工作钉在编辑器上方

> 本文面向第一次接触该扩展的读者。需要先知道：Pi 是编码 Agent 宿主，「扩展」装进 Pi 进程，不是另起一个服务。
>
> 源码基线：`@narumitw/pi-todo` **v0.3.0**（本仓库 `@narumiruna/pi-todo`）。列表上限、UI 文案和设置项易变；稳定认知放在「谁改列表、列表存在哪、widget 不是权威源」上。
>
> 官方说明：[README](../../@narumiruna/pi-todo/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-todo)

本文定位：小/轻量，二次开发深度。

## 1. TLDR：它到底是什么

pi-todo 给当前会话一条可见的多步清单。它做的事情可以压成一条链路：

```text
模型认为工作需要分步
→ 调用 update_todo_list（一次提交完整数组）
→ 扩展校验、替换内存中的列表
→ TUI 在编辑器上方画出 widget
→ 同一条列表写入 session 分支，压缩/恢复后还能重建
```

所以它不是：

- 不是项目管理工具，也不是跨会话的任务数据库；
- 不是 `/goal` 那种会自动续跑的执行引擎；
- 不是模型「心里的待办」——模型不改工具参数，屏幕上就不会变；
- 不是独立进程。关掉 Pi，widget 和运行时列表一起消失；能活下来的只有 session 分支里的记录。

正面定义：**一个工具 + 一个会话级 widget + 一套从 session 分支重建列表的规则。** 判断「现在该干什么」的仍然是宿主 Agent；扩展只保证列表合法、可见、可恢复。

权威数据源是 **session 分支里的工具结果 / 自定义条目**，不是屏幕上的 widget。widget 是派生视图。

## 2. 为什么需要一个专门的清单工具

普通对话里模型也会写「接下来三步」，但那些字在滚动历史里，压缩后容易丢，用户也看不见当前到底卡在哪一步。

该用：一次任务明显超过两三步，而且步骤状态会变（进行中、完成、被外部堵住）。

不该用：单步改动、已经能用 diff/测试说清楚的工作。README 也要求模型只在「有意义的多步工作」时调用这个工具。

职责分工可以记四行：

| 谁 | 管什么 | 不管什么 |
|---|---|---|
| 宿主 Agent | 决定步骤怎么拆、哪一步 in_progress | 不负责画 UI |
| `update_todo_list` | 校验并替换整份列表 | 不理解任务内容 |
| session 分支 | 权威列表，供恢复 | 不负责渲染 |
| widget | 给用户看 | 不是存储 |

一个硬约束能说明设计意图：同一时刻最多一个 `in_progress`；`blocked` 必须带原因。扩展用这两个规则逼模型把「正在做」和「卡住了」说清楚，而不是堆一串模糊的 checkbox。

## 3. 先看整体架构，不急着看类名

一共四个源文件。文档视角可以看成四层：

```text
宿主 Pi
 └─ 扩展初始化（todo-widget.ts）
     ├─ 工具层：update_todo_list
     ├─ 视图层：widget-renderer.ts
     ├─ 设置层：pi-todo.json
     └─ 恢复层：从 session 分支重建 todos[]
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 初始化 | Pi 的 `ExtensionAPI` | 注册工具和 session 事件 | 进程内一份 `todos[]` |
| 工具 | 完整 `todos` 数组 | 校验长度、状态、in_progress 唯一、blocked 必须有 reason | 新列表 + 工具结果详情 |
| 视图 | 当前列表 + 终端尺寸 | 按设置折叠/展开 | 编辑器上方的 widget |
| 设置 | `getAgentDir()/pi-todo.json` | 损坏则回退默认，不抛死 | `enabled` / 显示模式等 |
| 恢复 | session 分支条目 | 按版本重建列表 | 与压缩前一致的 todos |

进程真相和图纸几乎重合：没有 runner、没有 adapter、没有网络。差异只有一句——**widget 看起来像「应用状态」，其实每次 `session_start` 都是从分支重建的。**

## 4. 实际怎样运行：它主要是一个挂在 Pi 里的 widget

证据：

- `package.json` 的 `pi.extensions` 指向 `./dist/index.ts`；
- `src/index.ts` 只转发 `todo-widget.ts` 的默认导出；
- 没有 `bin`，没有监听端口，没有 slash command。

装了什么：一个 npm 包。启用后，当前 Pi 进程多一个工具名 `update_todo_list`（旧名 `todo_widget` 只为兼容）。设置文件在 Agent 目录下的 `pi-todo.json`。

有没有常驻进程：**没有。** 唯一的定时器是全部完成后约 3 秒的完成摘要，存在宿主进程里，会话一换就取消。

和宿主的关系：

```text
Pi 宿主进程
 ├─ 模型循环（可能调用 update_todo_list）
 ├─ session 分支（权威列表）
 └─ 本扩展：内存 todos[] + TUI widget
```

被谁拉起就归谁：Pi 加载扩展 → `session_start` 绑到当前 `sessionManager` → `session_shutdown` 清 widget。换会话等于换主人，旧定时器和旧列表不得写到新会话上。

## 5. 一条真实输入：模型更新清单

以「模型决定把工作拆成三步，并把第一步标成进行中」为例。

```text
模型调用 update_todo_list
→ 校验整份数组
→ 替换内存 todos[]
→ 写入工具结果详情
→ 重画 widget
→ （之后）压缩/重开 session 时从分支重建
```

### 5.1 工具层收到完整数组，而不是 patch

模型必须提交**当前完整列表**，空数组表示清空。扩展同步校验：最多 50 项、步骤文本有长度上限、状态只能是 `pending | in_progress | completed | blocked`、最多一个 in_progress、blocked 必须有非空 reason。失败则拒绝，并要求「修正后重交完整数组」。

这一步在调用工具的那一轮里同步完成，没有队列。

### 5.2 运行时用新数组整体替换

通过校验后，内存中的 `todos` 被整份替换。扩展不合并、不自动勾完、不替模型发明下一步。

### 5.3 视图层按终端高度画派生 UI

TUI 模式下，widget 放在编辑器上方。设置可以自适应高度、隐藏已完成项、限制可见条数，但会尽量保住 in_progress 和 blocked。全部完成后先闪一条完成摘要，再把 widget 摘掉。

非 TUI 模式不画 widget，列表仍然走工具结果，存在 session 里。

### 5.4 权威源落到 session 分支

工具结果带版本化的 `details`——**最后一次成功的 `update_todo_list` details 才是可重建的权威列表**（旧名 `todo_widget` 只在恢复时认）。压缩可能把工具结果从模型窗口里摘掉，所以 `context` 钩子会往消息里塞一条隐藏的 `todo-list-status`（`display: false`），必要时再 `appendEntry` 一条 `todo-restored-context-boundary`，让同一轮压缩纪元复用当时的快照，而不是拿实时内存去改写历史。

`session_start` / 切分支时 `restoreBranchState()` 从当前分支重建 `todos[]`。`pi-todo.json` 只在 `session_start` 读一次，中途改文件不会立刻生效。

所以：**widget 没了 ≠ 列表没了**；**进程退出但 session 文件还在 = 下次还能重建**。列表不写入 git，也不进设置文件。

同步/异步：工具执行和校验是同步的；完成摘要的消失是进程内 `setTimeout`。没有后台 worker。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| 列表 | 当前 session 分支上的一份 todos | 用户的全局任务库 |
| widget | 派生视图 | 权威存储 |
| `blocked` | 「外部卡住了，原因如下」 | 完成的另一种说法 |
| 设置文件 | 显示开关 | 待办内容 |

常见误区：

- 「模型说了三步，屏幕上就该有三步。」错。正：只有成功的 `update_todo_list` 才会改列表。
- 「清空 widget 就是删了任务历史。」错。正：空数组会摘掉 widget；历史工具调用仍在 session 里，重建规则看的是分支上的最新有效状态。
- 「这就是 goal 模式的简化版。」错。正：todo 不会在 `agent_settled` 后续跑，也不会阻止模型停下来。

症状式排错：

- **工具能调，但看不见 widget**：先看是不是 TUI、`widget.enabled` 是否为 false、列表是不是空、是不是刚显示完完成摘要。不要先怀疑渲染器算错行数。
- **恢复会话后列表不对**：先看当前分支，而不是设置文件。重建走 `reconstructTodos(branch)`，和 `pi-todo.json` 无关。

当前可靠性边界：没有包住「工具结果 + widget + 上下文消息」的总事务。工具已经成功但 UI 来不及画，以 session 分支为准。

## 7. 总结

可独立验证的稳定事实：

1. 它是 Pi 扩展，不是服务；权威列表在 session 分支，widget 是派生视图。
2. 模型一次提交完整数组；扩展只做合法性，不做任务规划。
3. 同时最多一个 `in_progress`；`blocked` 必须带原因。
4. 设置文件不管待办内容；进程内定时器只用于完成摘要。

如果只记一条主线：

```text
update_todo_list(完整数组) → 校验替换 → 画 widget → 写入 session 分支 → 下次从分支重建
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` — 确认入口只是转发。
2. `src/todo-widget.ts` — 工具注册、校验、session 事件、恢复；几乎全部行为在这里。
3. `src/widget-renderer.ts` — widget 怎么把列表变成终端行。
4. `src/settings.ts` — `pi-todo.json` 的容错读取。
5. `test/todo-widget.test.ts` — 行为合同：校验失败、恢复、完成摘要。
6. `test/todo-widget-enhancements.test.ts` — 自适应高度和 blocked。
7. `test/todo-cache-contract.test.ts` — 工具描述如何被缓存，改 description 前要看。

二次开发时优先改校验规则和恢复函数，而不是先动渲染。渲染崩了用户只是暂时看不见；恢复错了会把错误列表当成事实。

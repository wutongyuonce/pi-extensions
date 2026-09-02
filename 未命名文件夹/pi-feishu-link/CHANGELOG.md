# Changelog

## 0.2.3 (2026-08-14)

**卡片/交互/文件发送修复** —— 0.2.2 发布后用户实测反馈四连修。

### 飞书卡片 schema 2.0 重构（/help 无响应根因）

- **`tag:"action"` 容器被飞书 2.0 移除**（ErrCode 200861 "cards of schema V2 no longer support this capability"）——help/欢迎/审批/状态卡全用 action 容器 → 发送必 400。按钮改为**直接放 `body.elements`**（`tag:"button"`），交互回传用 `behaviors:[{type:"callback",value}]`（新版 card.action.trigger 回调，原有 `event.action.value` 解析兼容）
- **按钮缩略**：`column_set flow` 布局宽度均分把按钮挤成省略号——改为每按钮**独立一行平铺** + `width:"fill"` 撑满
- **字体乱码**：移除卡片内部分 emoji（🩺⚙️ 等在部分客户端字体渲染异常），标题改纯文本加粗

### 按钮点击不再"消息消失"

- 回调返回卡片 → 飞书**替换原卡片**（用户观感"点了就没了"）——改为点击后**发一条新消息**（outbox command-reply），回调返回 undefined 不动原卡

### 诊断包/文件发送修复（no file_key）

- SDK `file.create`/`image.create` 实际返回**顶层** `{file_key}`/`{image_key}`，代码取 `res.data.*` 永远 undefined → 上传必失败。改为兼容两种结构（顶层 + data 嵌套），4 个新测试覆盖

### support → doctor 改名

- 命令/卡片按钮（🩺 诊断包）/文案/README 统一 `doctor`（旧 `/support` 保留兼容）

**测试**：262 → **273 项全绿**（卡片 7 + 上传 4）；`tsc --noEmit` 干净。

## 0.2.2 (2026-08-13)

**可靠性修复** —— 用户报告"发飞书消息没回复"，排查定位四个叠加 bug 并根治。

### 消息链路修复（"发消息没回复"根因）

- **daemon 启动即死（50ms）回归修复**：6b552b3 把保活管道 `tail -f /dev/null | exec pi` 改成后台 `&`，使 daemon 的 pi 进程 stdin=/dev/null 立即 EOF → RPC 模式触发 `session_shutdown` → `stopBridge` → daemon 启动即退出。恢复为 `{ tail -f /dev/null & echo $! > pid; wait; } | exec pi …`——管道保活 stdin（永不 EOF）+ tail pid 落盘（killDaemonTail 防孤儿仍有效），pi 退出后 tail 自动 SIGPIPE 自灭，无僵尸
- **机器重启后 daemon 不自动拉起**：`readGatewayOwner` 不校验 pid 存活，gateway.json 残留僵尸锁让 `autoStart` 误判"已有 daemon"而不 spawn。新增 `readLiveGatewayOwner`（读时校验 pid 存活，僵尸锁自动清理），index.ts 全部 6 处（autoStart / start / stop / restart / takeover / 状态刷新）替换
- **消息收到但静默丢弃（断链根因）**：`messageHandlerDeps` 在 startBridge **之前**构造，`conversations/transport/outbox/eventForwarder/bridgeRuntime` 等 startBridge 才创建的 let 变量在构造时是快照 undefined，startBridge 赋值后 deps 不更新 → 对话处理永远进不去（收不到回复、无日志）。4 个 deps 对象（notify / diagnostics / commandRouter / messageHandler）的可变字段全部 **getter 化**（运行时实时读取闭包状态）

### 表情回执修复

- **随机表情 400 修复**：配置池含飞书无效 emoji_type（`FIRE`/`AMAZE`/`AWESOME`/`COOL`，正确值为 `Fire`/`AWESOMEN`，大小写敏感），随机抽到就报 231001 "reaction type is invalid"，用户收不到"已收到"表情。新增飞书 `VALID_EMOJI_TYPES` 全集（emojis-introduce 文档抓取）+ `pickRandomReaction` 过滤无效类型（配置池全无效自动回退默认池），DONE 表情确认有效

### 可观测性

- `handleInbound` 各 drop 分支（无配置 / 用户白名单 / 群策略拒绝 / 依赖缺失）打结构化日志——此前静默 return 无法定位
- `handleConversationMessage` 依赖守卫缺依赖时明确记录缺失项

**测试**：259 → **262 项单元测试全绿**（新增僵尸锁、管道命令、表情过滤用例）；`tsc --noEmit` 干净。

## 0.2.0 (2026-08-08)

**Pi × 飞书/Lark 双向桥接扩展首个正式版本** —— 集成了 2026-08-06 至 08-08 全部设计、实现与实机修复（前 0.1.x 历史合并于此）。

### 核心架构（R1-R3 可靠性底座）

- **R1 消息零丢失**：持久化 Outbox（JSONL 段文件、at-least-once + 幂等键、分航道并行、退避重试、崩溃恢复、压缩清理、容量护栏、blob 溢出）——进程被 kill 后重启自动续投
- **R2 连接自愈**：ConnectionSupervisor（**probe 心跳健康时静默不重建**——修复"正常空闲 20 分钟被误判僵尸 + 误报断连恢复"；probe 持续失败才重建；指数退避 + 恢复通知；断连期间消息自动补收）
- **R3 回合监督**：TurnSupervisor（模型卡死自动中止 + 队列解锁 + 排队/处理中提醒）
- **QuotaGovernor 连接配额熔断**：连接失败历史落盘（60min 窗口 / 12 次上限），超额即熔断停手——不再疯狂重连烧穿租户配额；成功连接自动解除；跨 daemon 生效
- **会话隔离**：per-conversation AgentSession + workspace 绑定 + 懒加载/空闲回收/常驻上限 + sessionId→key 持久映射
- **状态可观测**：status.json 单一真相源（TUI + 飞书同源）、结构化 JSONL 日志轮转、`/support` 一键脱敏诊断包（作为文件发回会话）

### 流式中间输出（用户指令 2026-08-08）

- 模型文本 **delta 逐块流式显示**（节流合并）——工具执行/思考过程对用户隐藏
- 修复流式卡片创建/更新类型不一致：**从创建就用 interactive 卡片**（此前 text 消息 patch 卡片报 230001，回复停在半截）
- finalize 固化最终结果，不被残余 delta 覆盖（I10）

### pi 命令原生适配（spec 2026-08-08-1400）

- **三级输入分流**：桥特有命令（status/workspace/stop/support/feishu-config）→ 桥处理；**pi 内置命令 → CommandAdapter → AgentSession API**；其他（插件命令/skill/模板/未知）→ **原样交 prompt()**（pi 原生执行扩展命令）
- **已适配**：`/model`（列已认证模型 + 编号选择 + 切换，支持 `provider/id` 与纯 id）、`/thinking`、`/compact`（真实压缩）、`/new`、`/resume`（列会话 + 编号恢复）、`/name`、`/session`、`/copy`、`/help`
- **`/login` API key 通道**：`/login <provider> <key>` 直接写入 auth.json（复用 `ModelRuntime.setRuntimeApiKey`），或 `/login <provider>` 交互输入——无需浏览器 OAuth
- 其余内置命令（settings/export/login 详情/fork/clone/tree 等）明确降级提示；**命令拦截全部移除**（无 blocked、无 admin 门禁）

### 权限模型 v1.3（用户指令 2026-08-07）

- **默认全部放行**：除破坏性黑名单外一切工具调用直接放行（私聊/群聊一致，零打扰）
- **黑名单改审批卡**：`rm -rf /`、`curl|sh` 等弹飞书审批卡（⚠️ 危险横幅），管理员批准才执行，5min 超时自动拒绝；`strict` 模式可切回全面审批
- **对抗性加固**：审批卡只发请求者会话、仅管理员可审批、群聊审批不记忆、dispose 后 gate 仍生效、双模式管道黑名单（下载即执行/内容即执行，33 样本拦截 24）

### 表情回执（用户指令 2026-08-07）

- 收到消息 → 随机表情回执（THUMBSUP/OK/HEART…，**DONE 永不参与随机池**）
- **任务/命令完成 → 对触发消息打 DONE 表情**（✅）；池可热改

### 认证与 UX

- `/feishu setup` 扫码创建应用（**自动带事件订阅 `im.message.receive_v1` + 群聊全量权限 `im:message.group_msg` + 表情权限**——buildSetupAddons）+ 阶段进度 + 系统通知
- 卸载卫生：`pi remove` 后状态目录（config/outbox/日志/锁）自动清理（双重守卫防误删）；daemon 自监控注册状态退出
- `/feishu start` 启动判定修复（真实 daemon pid 检测）；`takeover/stop/restart` SIGTERM→SIGKILL 逐级升级
- 群聊免 @（open 策略）、关键词/回复触发；欢迎/命令面板/审批/状态全按钮化卡片
- 多媒体：入站图片→视觉模型、文件→文本提取、语音→不支持提示；出站图片/文件经 `feishu_send_local_file`
- 定时任务（可选依赖 my-pi-scheduler）：说"每天 9 点总结 commit"即创建，结果回投会话

### 关键实机修复（排障沉淀）

- **事件结构解析修复（终极根因）**：`normalizeInbound` 兼容飞书 v2.0 嵌套结构（`event.message.message_id`）——此前 v2.0 事件 message_id 在嵌套里被静默丢弃，平台推送 SUCCESS 但桥无记录（"收不到消息"的真正根因）
- **断连补偿 400 修复**：补偿用真实 chat_id（oc_xxx）而非 conversationKey（p2p:ou_x）
- **模型匹配修复**：setModel 支持 `provider/id` 解析 + 兜底只选已认证模型（此前 find("configured"/"*") 匹配不到、getAll().find 命中未认证同名模型）
- **应用未订阅消息事件 → setup 自动订阅 + 自检兜底**
- **僵尸 daemon 清理**：卸载自监控 + 升级式终止 + 状态目录清理
- **会话队列毒化/发错会话/附件无界下载/流式卡竞态** 等 I1-I11 系列修复

**测试**：152 项起步 → **252 项单元/集成测试全绿**（node:test，零额外 dev 依赖）；`tsc --noEmit` 干净。

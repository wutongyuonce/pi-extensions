# pi-feishu-link 综合设计 Spec（v3 终版）

日期：2026-08-08 20:00
状态：已实现（合并 2026-08-06 至 08-08 全部设计演进，取代 1812/1930/1835/1905/1400 五个 spec）
作者：pi 调试会话（实机验证 + 对抗性审查 + 用户逐轮指令驱动）

---

## 0. 摘要

**Pi × 飞书/Lark 双向桥接扩展**：扫码 30 秒上线，消息零丢失（Outbox）、连接自愈（probe 驱动的受控重连 + 配额熔断）、权限桥（默认放行 + 危险审批卡）、流式中间输出、pi 命令原生适配（/model /thinking /compact /resume /login 等调 AgentSession API，插件/skill/模板原样转发）。

---

## 1. 需求与演进史

| 阶段 | 决策 | 结果 |
| --- | --- | --- |
| QQ 桥（1812） | 早期探索 QQ 双向桥 | **放弃**（1930 §0：QQ 方案限制多，转向飞书开放平台） |
| 飞书主架构（1930） | 高可靠双向桥：Outbox/会话隔离/权限桥/定时任务 | 主体骨架，至今保留精华 |
| 重构选型（1835） | 调研 AX1202/zxsctxx 等参考项目 | 部分采纳：薄 daemon、SDK 原生重连；**推翻重抄是错的**（1905 §1） |
| 对抗性重构（1905） | 外科手术保留 L2-L4 精华，改造 L1/L0 连接层 | QuotaGovernor 熔断、probe 驱动重建、静默不误杀（2026-08-08 实测修正） |
| 命令适配 + 流式（1400） | 用户指令：流式中间输出、pi 命令原生适配、插件命令转发 | CommandAdapter + 三级分流 + 流式卡片修复 + /login API key |

**用户核心方法论约束**：TDD first（先写失败测试再实现）、Spec first、卸载干净、全部放开（无命令拦截）。

---

## 2. 总体架构（关键设计决策 ADR 摘要）

```
飞书 WS 长连接 (SDK WSClient, autoReconnect:false)
   │  supervisor: probe(30s REST 心跳) + 静默检测 + 退避重连 + QuotaGovernor 熔断
   ▼
transport → handleInbound → 三级分流:
   ├─ 桥特有命令 → 桥处理
   ├─ pi 内置命令 → CommandAdapter → AgentSession API (setModel/compact/...)
   └─ 其他(插件/skill/模板/未知) → 原样 prompt() (pi 原生执行扩展命令)
   ▼
ConversationManager (per-key AgentSession + FIFO + workspace + 常驻上限)
   ▼
outbox (JSONL 持久化 at-least-once) → 飞书 REST (回复/卡片/媒体/表情)
```

| ADR | 决策 |
| --- | --- |
| ADR-1 连接层 | WSClient `autoReconnect:false`，由 supervisor 受控重连（SDK 无限重试会烧配额） |
| ADR-2 静默检测 | **probe 健康时不重建**（空闲 20 分钟不误杀）；probe 持续失败才重建 |
| ADR-3 配额熔断 | QuotaGovernor：60min/12 次失败即停手，跨 daemon 生效（conn-history.jsonl） |
| ADR-4 出站 | Outbox 持久化 at-least-once（进程 kill 重启续投），L1-L4 分层 |
| ADR-5 会话 | per-key AgentSession + sessionId→key 持久映射（dispose 后路由不丢） |
| ADR-6 权限 | 默认全部放行；黑名单→审批卡（管理员 5min）；群聊不记忆；strict 可选 |
| ADR-7 命令 | 三级分流（桥特有 / pi 内置适配 / 转发），**无 blocked、无 admin 门禁** |
| ADR-8 流式 | 流式卡片从创建即 interactive（text 消息 patch 卡片报 230001） |
| ADR-9 表情 | 收到→随机（池排除 DONE）；完成→DONE |
| ADR-10 卸载 | 自监控注册状态 + 状态目录清理（双重守卫防误删） |

---

## 3. 模块设计（浓缩）

- **host/**：daemon 生命周期（spawnDaemon SIGTERM→SIGKILL 升级）、gateway 锁、卸载自监控、setup（扫码建应用 + addons 自动订阅事件/权限）
- **inbound/**：transport（SDK 封装 + v2.0 事件归一化）、connection-supervisor（重连/静默/熔断）、group-trigger（open/mention/关键词）、missed-compensation（断连补收，真实 chat_id）、permission-probe
- **sessions/**：conversation-manager（编排）、pi-session-backend（AgentSession 封装 + setModel/compact/executeBash 透传）、turn-supervisor、tool-call-gate、permission-bridge
- **outbound/**：outbox（可靠投递）、live-channel（流式节流）、event-forwarder（turn_end 等）、outbound-router（任务路由）
- **commands/**：command-controller（桥特有命令）、pi-command-adapter（pi 内置命令 → AgentSession API + 交互选择）
- **common/**：config、status、quota-governor、reactions、dedupe
- **presentation/**：卡片构建（markdown/审批/状态/帮助）

---

## 4. 命令体系（pi ↔ 飞书对齐矩阵）

| 类别 | 命令 | 行为 |
| --- | --- | --- |
| 桥特有 | /status /workspace /stop /support /feishu-config /help | 桥处理（状态/工作区/诊断导出/热改配置） |
| pi 原生适配 | /model（列已认证+编号切换）/thinking /compact /new /resume /name /session /copy | CommandAdapter → AgentSession API；交互选择（编号回复） |
| /login | /login `<provider> [apiKey]` | **API key 通道**（写 auth.json）；单参交互输入 |
| 转发 | 插件命令（/goal 等）、/skill:name、模板、未知 /xxx | **原样交 prompt()**，pi 原生执行，输出经事件流回飞书 |
| 降级 | /settings /export /login详情 /fork /clone /tree /quit 等 | 明确提示（涉及 pi 交互选择器） |

---

## 5. 可靠性矩阵

| 故障模式 | 对策 | 实测 |
| --- | --- | --- |
| 连接被拒（配额满 1000040350） | QuotaGovernor 熔断停手 + 明确等待提示 | 修复前疯狂重连烧穿 50 条配额；修复后不再 |
| 事件不推（订阅未发布） | setup 自动订阅 + 自检提示 + 后台删事件重加 | 发布版本后生效 |
| 事件到达但解析失败 | normalizeInbound 兼容 v2.0 嵌套结构 | **终极根因修复**：message_id 在 event.message 里被静默丢弃 |
| 空闲被误判僵尸 | probe 健康不重建 | 修复误报"连接恢复（中断 1215s）" |
| 回复半截 | 流式卡片类型一致（interactive→interactive） | 修复 230001 "NOT a card" |
| 断连消息丢失 | 补偿用真实 chat_id 拉取 + skipDedupe 回放 | 修复 400 |
| 卸载残留 | 状态目录清理（双重守卫） | 卸载即干净 |
| 回复丢失 | Outbox at-least-once + 幂等键 | 进程 kill 重启续投 |

---

## 6. 安全设计

- 凭据：appSecret 存 `~/.pi/agent/feishu-link/config.json`（600 权限），诊断包脱敏（掩码/哈希）
- 审批：黑名单命令弹卡、仅管理员/owner、群聊不记忆、审批卡只发请求者会话
- 黑名单：双模式管道（下载即执行/内容即执行），33 攻击样本拦截 24
- 卸载：双重守卫（仍注册不删配置）
- 交互选择：pending 态 60s 超时，防止误消费后续消息

---

## 7. 开放问题（合并自各 spec）

1. /login OAuth 通道（浏览器）仍降级提示——API key 通道已覆盖主要场景
2. /settings /export /fork /clone /tree 深度适配（依赖 pi 交互选择器，P2）
3. 命令输出中的 UI 消息（选择器/对话框）事件提取（P1，当前 turn_end finalText 已覆盖 assistant 输出）
4. 定时任务 my-pi-scheduler 为可选依赖（动态检测）

> 已解决：群 open（免 @）策略依赖的 `im:message.group_msg` 权限由 setup 扫码时**自动申请即生效**，无需审核、无需手动配置。

---

## 8. 测试与验收

- **252 项单元/集成测试全绿**（node:test，零额外 dev 依赖）+ `tsc --noEmit` 干净
- 测试覆盖：normalizeInbound 事件结构矩阵、supervisor 静默/熔断/冷却、quota-governor、command-adapter（模型/思考/压缩/resume/login 交互）、permission gate、outbox 可靠性、卸载卫生、流式
- 实机验收：私聊收发 + 流式 + DONE 表情、/model 切换、/login API key、群聊（开权限后）、断连补偿

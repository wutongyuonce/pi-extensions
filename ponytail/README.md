这是一个 **PI Extension**，用于将 Ponytail 的规则注入到 AI agent 的会话生命周期中。

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  pi										                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  PI Extension System                                    │ │
│  │  ┌─────────────────────────────────────────────────┐   │ │
│  │  │  ponytailExtension(pi)                          │   │ │
│  │  │  ├─ Command Registry  (/ponytail, /ponytail-*)   │   │ │
│  │  │  ├─ Event Hooks     (session_start, agent_start)│   │ │
│  │  │  └─ Prompt Injection (before_agent_start)        │   │ │
│  │  └─────────────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 主链路详解

### 1. 初始化链路（Session Start）

```
用户打开会话
    ↓
pi.on("session_start") 触发
    ↓
┌────────────────────────────────────────┐
│ resolveSessionMode(entries, default)   │  ← 从会话历史倒查最近的 ponytail-mode 记录
│   • 遍历 entries 从后往前找            │
│   • 找到最近的 "ponytail-mode" custom entry → 取其 mode
│   • 没找到 → 用 configuredDefaultMode  │
└────────────────────────────────────────┘
    ↓
currentMode = resolved mode
syncStatus(ctx)  → 状态栏显示 🐴 ⚡ FULL（如果 hideStatus 为 false）
如果 !quietStartup → 通知 "Ponytail loaded: full"
```

**关键设计：** 模式持久化在会话分支的 `custom` entry 中，不是全局状态。这样每个会话分支可以独立设置模式。

---

### 2. 命令处理链路

```
用户输入 /ponytail <args>
    ↓
pi.registerCommand("ponytail") 捕获
    ↓
parsePonytailCommand(args, defaultMode)
    ├─ "" (空)        → set-mode: 当前模式的 toggle（off → full, 其他保持）
    ├─ "status"       → 返回当前模式 + 默认模式
    ├─ "default lite"  → 写入默认配置文件（~/.config/ponytail/mode）
    ├─ "lite"         → set-mode: lite
    ├─ "full"         → set-mode: full
    ├─ "ultra"        → set-mode: ultra
    └─ "off"          → set-mode: off
    ↓
setMode(mode, ctx)
    ├─ 写入 custom entry: pi.appendEntry("ponytail-mode", { mode })
    ├─ 更新 currentMode
    └─ syncStatus(ctx) → 刷新状态栏
```

**模式切换命令映射：**

| 输入                            | 行为                         |
| ------------------------------- | ---------------------------- |
| `/ponytail`                     | toggle：off → full，其他保持 |
| `/ponytail status`              | 显示当前 + 默认模式          |
| `/ponytail lite/full/ultra/off` | 切换到对应模式               |
| `/ponytail default <mode>`      | 修改默认配置文件             |

---

### 3. 核心注入链路（Prompt Injection）

```
Agent 开始处理用户请求
    ↓
pi.on("before_agent_start") 触发
    ↓
if currentMode === "off" → 直接返回，不注入
    ↓
┌─────────────────────────────────────────────────────────────┐
│ const base = event.systemPrompt ? `${event.systemPrompt}\n\n` : ""; │
│ return {                                                    │
│   systemPrompt: `${base}${getPonytailInstructions(currentMode)}`    │
│ };                                                          │
└─────────────────────────────────────────────────────────────┘
    ↓
Agent 的 systemPrompt 被追加 Ponytail 规则
    ↓
Agent 按规则生成回复（爬阶梯、YAGNI、最简实现）
```

**这是整个扩展的核心**——在 agent 开始工作前，把 Ponytail 的阶梯规则注入到 system prompt 中。`getPonytailInstructions(currentMode)` 根据当前模式（lite/full/ultra）返回不同强度的规则文本。

---

### 4. 状态同步链路

```
pi.on("agent_start")  → isActive = true  → syncStatus() → 状态栏 ●（实心，活跃中）
    ↓
[Agent 处理中...]
    ↓
pi.on("agent_end")    → isActive = false → syncStatus() → 状态栏 ○（空心，空闲）
```

状态栏格式：
```
● 🐴 ponytail: ⚡ FULL   ← 活跃中
○ 🐴 ponytail: ⚡ FULL   ← 空闲
```

如果 `hideStatus = true`（用户配置），状态栏完全不显示，但规则仍然生效。

---

### 5. 辅助命令链路（Skill Alias）

```
用户输入 /ponytail-review
    ↓
sendAlias("/skill:ponytail-review", "", ctx)
    ├─ 如果 agent 正在忙（isIdle() === false）
    │   → pi.sendUserMessage(message, { deliverAs: "followUp" })
    │   → 通知 "queued as follow-up"
    └─ 如果 agent 空闲
        → pi.sendUserMessage(message)  ← 直接发送
```

其他 alias 命令同理：
- `/ponytail-audit` → `/skill:ponytail-audit`
- `/ponytail-gain` → `/skill:ponytail-gain`
- `/ponytail-debt` → `/skill:ponytail-debt`
- `/ponytail-help` → `/skill:ponytail-help`

---

### 6. 停用检测链路

```
用户输入任意消息
    ↓
pi.on("input") 触发
    ↓
if currentMode !== "off" && isDeactivationCommand(text)
    → setMode("off")  ← 自动关闭 Ponytail
```

`isDeactivationCommand` 检测停用关键词（如 "stop ponytail"、"normal mode"）。

## 数据流总结

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  配置文件   │────→│ configuredDefault│────→│ resolveSessionMode │
│ ~/.config/  │     │  (getDefaultMode) │     │  (查历史 entry)   │
└─────────────┘     └─────────────────┘     └────────┬────────┘
                                                     │
                              ┌──────────────────────┘
                              ↓
                    ┌─────────────────┐
                    │   currentMode   │◄──── 用户 /ponytail 命令
                    │  (lite/full/    │      或历史 entry 恢复
                    │   ultra/off)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
        ┌─────────┐   ┌──────────┐  ┌──────────────┐
        │syncStatus│  │ setMode  │  │ before_agent │
        │ (状态栏)  │  │ (持久化)  │  │ _start (注入) │
        └─────────┘   └──────────┘  └──────────────┘
                                             │
                                             ↓
                                    ┌─────────────────┐
                                    │ getPonytailInstructions │
                                    │ (根据 mode 返回规则)    │
                                    └─────────────────┘
```

## 关键设计亮点

| 设计                          | 说明                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| **模式持久化在会话 entry 中** | 不是全局变量，每个分支独立，支持跨中断恢复                   |
| **倒查历史恢复模式**          | `resolveSessionMode` 从后往前遍历，找到最近的设置            |
| **systemPrompt 追加而非替换** | `before_agent_start` 保留原有 prompt，只追加规则             |
| **空值保护**                  | `event?.systemPrompt` 为 null/undefined 时不注入 `"undefined"` 字符串 |
| **忙时排队**                  | skill alias 在 agent 忙时自动转为 follow-up，避免打断        |
| **配置优先级**                | 环境变量 > 配置文件 > 默认值                                 |

整个扩展的核心就是一句话：**在 agent 开始工作前，把 Ponytail 的"偷懒阶梯"规则塞进 system prompt 里。** 其余都是围绕模式管理、状态同步和用户体验的配套设施。
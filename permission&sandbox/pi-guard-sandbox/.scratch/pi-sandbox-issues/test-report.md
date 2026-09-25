# Pi 沙箱环境问题测试报告

日期: 2026-04-30
测试环境: pi v0.70.6, sandbox-for-pi 项目

---

## 1. 测试目标

验证两个插件机制的生效情况：
- **插件 A（外部写保护）**：阻止 AI 向工作区外写入文件
- **插件 B（ReadOnly 模式）**：只允许读操作，禁止 write/edit

同时排查 bash 工具不可用的问题。

---

## 2. 测试结果总表

| # | 操作 | 预期 | 实际结果 | 拦截方 | 是否正常 |
|---|------|------|---------|--------|---------|
| 1 | `write` → `/tmp/xxx`（工作区外） | 被插件 A 拦截 | ❌ `User denied external write.` | 插件 A ✅ | ✅ 正常 |
| 2 | `write` → 工作区内新文件 | 被插件 B 拦截（readonly） | ❌ `write is denied in readonly mode.` | 插件 B ✅ | ✅ 正常 |
| 3 | `edit` → 工作区内已有文件 | 被插件 B 拦截（readonly） | ❌ `edit is denied in readonly mode.` | 插件 B ✅ | ✅ 正常 |
| 4 | `bash` → `touch` 工作区内文件 | 正常运行或被 readonly 拦截 | ❌ `bwrap: Can't mount tmpfs on /newroot/home/lee/.aws: No such file or directory` (exit code 1) | **bwrap** ❌ | ❌ 异常 |
| 5 | `bash` → `echo "hello"` | 正常运行 | ❌ 同上 bwrap 错误 | **bwrap** ❌ | ❌ 异常 |
| 6 | `bash` → `ls` `find` `grep` `which` | 正常运行 | ❌ 同上 bwrap 错误 | **bwrap** ❌ | ❌ 异常 |
| 7 | `read` → `/etc/hostname` | 正常读取 | ✅ 返回 `DESKTOP-TQRSMTD` | 无 | ✅ 正常 |
| 8 | `read` → 工作区内文件（如 AGENTS.md） | 正常读取 | ✅ 返回内容 | 无 | ✅ 正常 |
| 9 | `read` → 不存在的路径 | 返回 ENOENT | ❌ `ENOENT: no such file or directory` | 文件不存在 | ✅ 正常 |

---

## 3. 插件拦截特征

### 3.1 插件 A：外部写保护

- **触发条件**：`write` 工具的目标路径不在 `cwd`（工作目录）范围内
- **返回消息**：`User denied external write.`
- **返回机制**：通过 `pi.on("tool_call", ...)` 事件处理器的 `{ block: true, reason: "User denied external write." }` 返回值
- **不拦截的操作**：`read`（可读任意路径）、`edit`（仅拦截 readonly 模式）

### 3.2 插件 B：ReadOnly 模式

- **触发条件**：`write` 或 `edit` 工具被调用
- **返回消息**：`write is denied in readonly mode.` / `edit is denied in readonly mode.`
- **返回机制**：同上，通过 tool_call handler block
- **不拦截的操作**：`read`、`bash`（设计上不拦 bash）

### 3.3 插件源码定位结果

- 已知 `.pi/extensions/` 目录存在（`read` 返回 `EISDIR`）
- 但无法枚举目录内容（bash 不可用），因此**无法定位具体文件名**
- 通过猜测 30+ 个常见命名均未命中（`restrict-workspace.ts`, `sandbox.ts`, `guard.ts`, `block.ts` 等）
- 需要在 bash 可用后执行 `ls .pi/extensions/` 定位

### 3.4 插件规模预估（基于 pi 扩展架构推断）

根据 pi 扩展系统架构分析，此插件结构应为单文件扩展：

```typescript
// 估算 80-150 行
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { resolve } from "path";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.on("tool_call", async (event, ctx) => {
    // 1. ReadOnly 检查
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      // 检查 readonly 标记
      // 返回 { block: true, reason: "... readonly mode" }
    }

    // 2. 外部写检查
    if (isToolCallEventType("write", event)) {
      const targetPath = resolve(ctx.cwd, event.input.path);
      // 检查 targetPath 是否在 cwd 范围内
      // 返回 { block: true, reason: "User denied external write." }
    }
  });
}
```

---

## 4. Bash/Bwrap 异常诊断

### 4.1 错误信息

```
bwrap: Can't mount tmpfs on /newroot/home/lee/.aws: No such file or directory
```

### 4.2 特征

- **影响范围**：所有 bash 命令（包括 `echo`, `ls`, `touch`, `which`, `grep` 等）
- **错误一致性**：无论执行什么命令，返回相同的 bwrap 错误
- **退出码**：`exit code 1`
- **与插件无关**：该错误在 readonly 模式开启前后均存在，说明是 pre-existing 环境问题

### 4.3 根因分析

Bubblewrap (bwrap) 是 pi 的 bash 工具使用的系统级沙箱。它的工作原理：
1. 创建新的根文件系统在 `/newroot/`
2. 将家目录、临时目录等通过 bind mount / tmpfs 挂载到新根中
3. 在隔离环境中执行命令

错误表明 bwrap 尝试在 `/newroot/home/lee/.aws` 挂载 tmpfs，但路径不存在。

**可能原因：**
- `/newroot/home/lee/` 目录在新根中尚未创建
- bwrap 的挂载参数（`--bind`, `--tmpfs`）配置中 `.aws` 被列为挂载点，但父目录未预先创建
- pi 的 bash 沙箱实现中，bwrap 参数构建逻辑缺少对嵌套路径的 `--dir`（创建目录）步骤

### 4.4 验证记录

- `/home/lee/.aws` 是**存在的目录**（`read` 返回 `EISDIR`），所以不是源路径问题
- 错误出在目标路径 `/newroot/home/lee/.aws` — 是新根内的路径没被创建

---

## 5. 总结

| 问题 | 状态 | 严重度 |
|------|------|--------|
| 插件 A（外部写保护） | ✅ 正常 | — |
| 插件 B（ReadOnly 模式） | ✅ 正常 | — |
| Bash 全部不可用（bwrap 配置错误） | ❌ 异常 | 🔴 阻塞 |
| 无法定位插件源码（bash 不可用导致无法 ls） | ❌ 间接阻塞 | 🟡 次要 |

**最核心阻塞项**：bwrap 沙箱配置错误导致 bash 完全不可用，需要先修复才能定位插件源码和执行修复操作。

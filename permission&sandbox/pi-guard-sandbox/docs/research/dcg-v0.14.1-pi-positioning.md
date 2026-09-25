# DCG v0.14.1 与 Pi Guard 的定位

> 研究日期：2026-09-07
> DCG 源码快照：`9569d4f181e43e7bdd4fba254834762a092b4b29`（v0.14.1）

## 结论

DCG 和 Pi Guard 解决相邻但不同的问题：

- **DCG**：在 Bash 执行前判断命令是否具有破坏性。
- **Pi Guard**：限制 Pi Agent 能读写什么，并以系统沙箱限制 Bash 进程实际能访问的文件系统和网络。

因此，Pi 用户同时使用两者的理由是：**DCG 判断“这条命令是否危险”；Pi Guard 限制“即使命令漏判，它最多能造成多大影响”。**

## DCG 对 Pi 的已有支持

DCG 有正式的 Pi 集成文档，但它提供的是一份用户自行放入 Pi extensions 目录的 TypeScript 示例。该示例只监听 `bash` 工具调用，调用：

```bash
dcg --robot test "<command>"
```

DCG 返回拒绝时，扩展返回 `{ block: true, reason }`。DCG 文档明确说 Pi 不会被其安装器自动配置。

来源：[Pi Integration](https://github.com/Dicklesworthstone/destructive_command_guard/blob/9569d4f181e43e7bdd4fba254834762a092b4b29/docs/pi-integration.md)

## DCG 单独使用时的能力与边界

DCG 的优势：

- 丰富的命令风险规则包；
- 可检查嵌套 shell、inline script、heredoc 等；
- 可选数据库、容器、Kubernetes、云平台等规则包；
- 可解释的拒绝原因和 allowlist。

它在 Pi 中只守 Bash 的执行前入口。其 Pi 文档明确说明：模型仍可能写脚本后通过别的工具执行，或使用不是 `bash` 的工具；若需要硬边界，应使用容器或 sandbox。

来源：[DCG README](https://github.com/Dicklesworthstone/destructive_command_guard/blob/9569d4f181e43e7bdd4fba254834762a092b4b29/README.md)、[Pi Integration — Limitations](https://github.com/Dicklesworthstone/destructive_command_guard/blob/9569d4f181e43e7bdd4fba254834762a092b4b29/docs/pi-integration.md#limitations)

## Pi Guard 提供的增量价值

Pi Guard 在同一个 Pi `tool_call` 入口上，还做了 DCG 示例没有做的事：

- 对 `read`、`write`、`edit` 也实施项目级路径策略；
- 拒绝读取敏感路径；
- 控制项目内写入、项目外写入和受保护文件；
- 将 Bash 替换为受系统沙箱限制的执行路径；
- 提供只读/项目可写、网络、Sandbox、DCG 的项目配置和运行时开关。

对应实现：[tool-policy.mjs](../../extensions/pi-guard/src/tool-policy.mjs)、[guard.mjs](../../extensions/pi-guard/src/guard.mjs)、[runtime-sandbox.mjs](../../extensions/pi-guard/src/runtime-sandbox.mjs)。

## 产品定位建议

不要将 Pi Guard 宣传成“另一个 DCG”。建议用以下定位：

> **Pi Guard 是 Pi 的项目边界与执行隔离层；DCG 是可选的 Bash 风险判断引擎。**

适用选择：

| 用户需求 | 适合方案 |
|---|---|
| 在多个 Agent 工具中识别危险命令 | 单独 DCG |
| 在 Pi 中限制 Agent 的文件、网络和 Bash 影响范围 | Pi Guard |
| 同时需要丰富的命令风险识别与硬性工作区边界 | Pi Guard + DCG |

Pi Guard 内置 Bash 规则应保持为无 DCG 时的基础兜底，不应与 DCG 的规则库竞争。DCG 可用时，由 DCG 做命令语义判断；Pi Guard 做范围隔离。

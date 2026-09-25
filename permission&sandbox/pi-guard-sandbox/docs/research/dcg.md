# DCG：Destructive Command Guard 核心研究

> 研究对象：`Dicklesworthstone/destructive_command_guard`，以下简称 **DCG**。  
> 参考版本：`v0.6.9`，源码快照 `a9ed9bac73b24d99778b4fe0af680cf4b32d5214`。

## 一句话结论

**DCG 不是 Shell、沙箱或操作系统级拦截器；它是一个运行在 AI coding agent 工具调用之前的、静态分析型命令安全策略门。**

它接收 agent 准备执行的命令字符串，判断该命令是否符合已启用的危险规则，然后向 agent 返回 `allow`、`deny` 或需要复核的结果。真正执行命令的是 agent 后面的 Shell；DCG 本身不执行被检查的命令。

依据：[README](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/README.md)、[evaluator.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/evaluator.rs)、[main.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/main.rs)。

## 去掉产品外表后的最小模型

```text
AI agent 准备调用 Bash
        │
        ▼
Pi 扩展 / Claude Hook / Codex Hook / 其他适配器
        │  提交 command 字符串
        ▼
DCG：解析、归一化、匹配规则、形成决策
        │
        ├── allow  ──► agent 继续执行原命令
        └── deny   ──► agent 不执行原命令
```

核心接口可以抽象成：

```text
Decision = evaluate(command, policy, allowlist, context)
```

其中 `policy` 主要由规则包（packs）组成，`context` 包括 Shell 方言、工作目录、agent 类型以及嵌套脚本等信息。

## 它实际做什么

### 1. 在执行前检查命令

DCG 作为各类 agent 的 pre-tool/pre-command hook 工作。Hook 输入通常是 JSON，DCG 从中抽取工具名和命令；拒绝结果写到 agent 能解析的 stdout，给人看的解释写到 stderr。不同 agent 有不同 JSON 协议，因此 DCG 有协议适配层，但这些适配层不是安全判断本身。

依据：[hook.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/hook.rs)、[agents.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/agents.md)。

### 2. 用规则包识别危险操作

每个 pack 由以下内容组成：

- 关键词：先做快速候选筛选；
- safe patterns：明确安全的例外；
- destructive patterns：危险命令模式；
- 原因、规则名、严重级别、替代建议。

匹配逻辑不是简单的“命中字符串就拒绝”：先处理安全模式，再处理破坏性模式；复合命令会拆分检查，避免一个安全片段掩盖另一个危险片段。关键词快速筛选使用 Aho-Corasick 等结构降低每次 hook 的开销。

依据：[packs/mod.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/packs/mod.rs)。

### 3. 默认保护最核心的破坏面

没有额外配置时，核心保护包括：

- `core.git`：可能丢失未提交工作、删除 stash、重写历史的 Git 操作；
- `core.filesystem`：递归删除、`find -delete`、文件截断/覆盖、敏感路径移动，以及某些通过复合命令形成的删除链；
- `system.disk`：`mkfs`、对设备执行 `dd`、分区表修改、`wipefs` 等磁盘级操作，默认启用但可以显式关闭。

数据库、Docker、Kubernetes、云平台等 pack 默认不是全部开启的，需要配置启用。Windows 还会默认启用一部分 native Windows pack。

依据：[config.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/config.rs)、[packs/core/git.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/packs/core/git.rs)、[packs/core/filesystem.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/packs/core/filesystem.rs)。

### 4. 不只看命令表面

DCG 会处理一部分“危险命令藏在外壳里”的情况，包括：

- Shell wrapper、绝对路径和 Shell 方言；
- PowerShell alias/script block；
- Git alias 和部分静态语义展开；
- `bash -c`、`python -c` 等嵌套解释器；
- heredoc、here-string、inline script；
- heredoc 内的 Python、Bash、JavaScript、Ruby、Go、PHP 等 AST 内容。

它会对明显是数据的字符串做上下文消毒，例如搜索词、提交消息和文档内容，减少“命令中出现了 `rm -rf` 文字”造成的误报。

heredoc 检查采用“触发器 → 有界提取 → AST 匹配”的分层管线，不是完整的通用恶意代码检测器。

依据：[evaluator.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/evaluator.rs)、[adr-001-heredoc-scanning.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/adr-001-heredoc-scanning.md)、[security.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/security.md)。

## 它如何形成最终决策

可以把主流程压缩为：

1. 检查显式 block/allow 配置；
2. 处理可递归分析的 launcher、alias、脚本和 heredoc；
3. 快速判断是否可能命中已启用 pack；
4. 对命令做上下文消毒和归一化；
5. 应用 allowlist；
6. 按顺序匹配 packs；
7. 根据严重级别和策略生成最终结果。

严重级别的默认行为是：

- `Critical` / `High`：`deny`；
- `Medium`：`warn`，通常允许继续但留下警告；
- `Low`：`log`，主要用于记录和学习。

策略、agent profile、allowlist、confidence 和 graduated response 可以改变处理方式。因此，“某个正则匹配了”不等于“最终一定硬阻断”。

依据：[evaluator.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/evaluator.rs)、[packs/mod.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/packs/mod.rs)、[configuration.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/configuration.md)。

## 最重要的边界和局限

### 它不是 OS 级安全边界

DCG 依赖 hook/extension 被正确安装，并依赖 agent 尊重返回的拒绝结果。未接入 DCG 的工具、绕过 hook 的调用、直接运行 Shell 的用户命令，都不受它保护。Pi 集成文档明确指出：如果模型把命令写入脚本后通过其他工具执行，单纯的 pre-tool guard 可能看不到；需要容器或真正的 sandbox 才能建立更硬的边界。

### 它不是 undo 或备份系统

DCG 只在命令执行前做判断。它不会保存工作树快照，不会恢复已删除文件，也不会回滚数据库、云资源或磁盘操作。

### 它不是恶意软件检测器

它的目标是覆盖已知的破坏性操作模式，尤其是 AI agent 误执行命令的风险；对任意混淆、动态代码、未知解释器和未建模的非 Shell 破坏操作，没有完整保证。

### 它存在明确的容错策略

- 分析超过有界时间时，结果是 `indeterminate`，不能把“没分析完”当成安全；支持复核的客户端会要求 review，不支持的客户端会阻断。
- 原始 hook JSON 解析失败默认 fail-open，可通过 `fail_closed` 改为阻断；这是传输层兼容性与安全之间的显式配置取舍。
- 存在 `DCG_BYPASS=1`、allow-once 和 allowlist 等逃生机制，目的是让人处理合法但高风险的操作。

依据：[main.rs](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/src/main.rs)、[security.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/security.md)、[configuration.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/configuration.md)。

## 对我们当前 Pi 项目的直接含义

DCG 最适合被看作一个**外部策略引擎**，而不是要嵌进 Pi 的一套完整沙箱：

```text
Pi tool_call handler
    └── dcg --robot test "<command>"
          ├── exit 0：允许
          ├── exit 1：拒绝
          └── exit >= 3：DCG 自身出错，按我们的风险偏好决定 fail-open 或 fail-closed
```

上游为 Pi 提供的集成方案就是在 `tool_call` 事件中调用 robot mode，再根据退出码返回 `{ block: true, reason }`。这意味着我们未来如果借鉴 DCG，最值得复用的不是它的漂亮终端输出，而是：

1. **命令进入执行器前的统一决策接口**；
2. **pack 化的规则组织方式**；
3. **安全例外与破坏规则分离**；
4. **上下文消毒、归一化和嵌套命令分析**；
5. **机器协议和人类解释严格分流**。

依据：[pi-integration.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/a9ed9bac73b24d99778b4fe0af680cf4b32d5214/docs/pi-integration.md)。

## 最终判断

DCG 的本质可以命名为：

> **面向 AI agent 工具调用的、规则驱动的、静态命令风险分类器与执行前策略门。**

它的核心价值不是“知道所有危险命令”，而是把“agent 想执行什么”放进一个**可配置、可解释、可审计、可在执行前拒绝**的决策点。它能显著降低误删和误操作风险，但不能单独承担操作系统沙箱或强隔离边界的职责。

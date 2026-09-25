# DCG v0.6.9：Pi Guard 集成事实报告

> 目的：为 Pi Guard 集成 `destructive_command_guard` 提供事实依据。本文只记录 DCG 文档、源码和测试中能确认的行为，不提出大规模实现方案。
>
> 参考版本：DCG `v0.6.9`，本地源码快照：`a9ed9bac73b24d99778b4fe0af680cf4b32d5214`。
>
> 说明：本文讨论的主要入口是 `dcg --robot test "<command>"`，不要把它和 DCG 的原生 agent hook 模式、`dcg hook --batch` 或 `dcg mcp-server` 混为一谈。

## 结论摘要

1. 对一个**有效的** `dcg --robot test "<command>"` 调用，当前 `test` 实现的实际决策退出码主要是：`0 = allow`，`1 = deny 或 indeterminate`。
2. `TestOutput` 的 JSON 决策值是 `allow`、`deny`、`indeterminate`。当前 `test` 的 robot JSON 没有独立的 `warn` 决策值。
3. `warn` 是 DCG 内部的 `DecisionMode`，在普通人类输出中可以显示为 `WARN (policy allows)`；但当前 robot `test` 分支仍按 `EvaluationDecision::Deny` 序列化并返回退出码 `1`，除非结果被明确转成 `Allow`。
4. DCG 的 hook evaluator 有默认 200ms 的绝对分析预算；但当前 `dcg test` 调用 evaluator 时传入的是 `None` deadline，因此不能直接把 hook 模式的 200ms 行为当作 `dcg --robot test` 的行为。
5. 官方 Pi 集成示例只是每次启动外部 `dcg` 进程并读取退出码/JSON。示例没有超时；DCG 缺失或子进程启动失败时示例默认 fail-open。
6. `dcg --robot test` 不会执行候选命令。它只分析作为 CLI 参数传入的字符串。
7. DCG 没有在官方 Pi 示例中提供 allow-once 或 bypass 自动调用。外部扩展不应把 `dcg allow-once`、`dcg allow` 或 `DCG_BYPASS=1` 暴露给模型自动调用。
8. 配置和 allowlist 都受当前工作目录、用户环境、`DCG_CONFIG`、`XDG_CONFIG_HOME` 等影响；Pi 子进程默认继承 Pi 的环境和工作目录。
9. DCG 有 `dcg hook --batch` 和长期运行的 `dcg mcp-server`，但官方 Pi recipe 使用的是逐命令 `dcg --robot test`，不是 batch 或 MCP。
10. Linux/macOS/WSL 使用 POSIX 安装脚本和对应平台二进制；native Windows 使用 `dcg.exe` 和 PowerShell 安装脚本。WSL 按 Linux 处理，不按 native Windows 处理。

---

## 1. `dcg --robot test` 的退出码契约

### 已确认事实：有效命令评估

`src/cli.rs` 的 `Command::TestCommand` 分支把 robot mode 强制为 JSON，然后调用 `test_command(...)`。`test_command` 最后按 `blocks_cli_execution(result.decision)` 判断是否阻断；该函数对所有不是 `EvaluationDecision::Allow` 的结果都返回需要阻断。

因此，对于有效的 `test` 调用：

| evaluator 结果 | robot JSON `decision` | `dcg --robot test` 实际退出码 | 含义 |
|---|---:|---:|---|
| `Allow` | `allow` | `0` | 允许继续 |
| `Deny` | `deny` | `1` | 阻止 |
| `Indeterminate` | `indeterminate` | `1` | 未完成安全分析，按阻止处理 |

源码依据：

- `.references/destructive_command_guard/src/cli.rs`：`run_command`、`test_command`、`blocks_cli_execution`、`TestOutput`。
- `.references/destructive_command_guard/src/exit_codes.rs`：`EXIT_SUCCESS = 0`、`EXIT_DENIED = 1`。
- `.references/destructive_command_guard/tests/e2e/robot_mode_test.sh`：验证允许命令退出 `0`、拒绝命令退出 `1`。
- `.references/destructive_command_guard/install.sh`：安装自测验证 `git status` 为 allow、`rm -rf /` 为退出 `1` 和 JSON deny。

### 已确认事实：其它退出码不是普通 `test` 决策

`src/exit_codes.rs` 还定义了：

```text
2 = EXIT_WARNING
3 = EXIT_CONFIG_ERROR
4 = EXIT_PARSE_ERROR
5 = EXIT_IO_ERROR
```

但这些是 DCG 的统一 robot/CLI 退出码定义，不等于当前 `dcg --robot test` 每种情况都会返回这些值。当前 `test` 分支明确使用 `EXIT_DENIED` 表示 evaluator 的非 Allow 结果。

CLI 参数解析发生在 robot 输出初始化之前：`src/main.rs` 的 `Cli::try_parse()` 失败时直接使用 clap 的退出码和错误文本。因此，下面这类错误不属于 `TestOutput` JSON：

```text
dcg --robot test          # 缺少 command 参数
```

其行为是 CLI 参数错误，通常由 clap 返回退出码 `2`，并输出命令行帮助/错误文本。

### 合理推断

对 Pi Guard 来说，不能只把“退出码非零”统一解释成“危险规则命中”，至少应区分：

- `1`：DCG 判断阻止，或者安全分析未完成；
- `0`：DCG 明确允许；
- 其它/无退出码：DCG 本身或外部进程异常，不是安全结论。

---

## 2. allow、deny、warn、indeterminate、内部错误

### `allow`

#### 已确认事实

robot `test` 输出 `TestOutput { decision: "allow", ... }`，退出码 `0`。如果命令曾经匹配过规则但被 allowlist 放行，JSON 还可以包含 `allowlist` 对象。

#### 适合展示的内容

- `decision`；
- 原始 `command`；
- 如果存在，allowlist 的 `layer` 和 `reason`。

源码依据：`src/cli.rs` 的 `TestOutput` 构造和 allow 分支。

### `deny`

#### 已确认事实

命中阻断规则时，robot JSON 可能包含：

- `rule_id`，例如 `core.filesystem:rm-rf-general`；
- `pack_id`；
- `pattern_name`；
- `reason`；
- `explanation`；
- `source`；
- `matched_span`；
- `severity`；
- `agent`。

退出码为 `1`。

### `warn`

#### 已确认事实

DCG 内部有独立的 `DecisionMode::Warn`。普通人类 `dcg test` 输出路径会显示：

```text
Result: WARN (policy allows)
```

但当前 `TestOutput` 的 `decision` 文档和结构只有：

```text
allow | deny | indeterminate
```

robot structured 分支是按 `result.decision` 分支序列化的；它没有把 `DecisionMode::Warn` 映射成 JSON `"warn"`。同时，`test_command` 的退出判断也看 `EvaluationDecision`，而不是 `resolved_mode`。

因此，当前版本对 `dcg --robot test` 的独立 `warn` 机器协议**没有确认到稳定契约**。如果需要明确的 `warn` JSON/退出码，应查看另一个入口 `dcg classify`；`classify` 明确返回 `allow`、`warn`、`block`、`indeterminate`，并把 `warn` 映射到退出码 `2`。这不是官方 Pi recipe 使用的入口。

源码依据：

- `src/packs/mod.rs`：`DecisionMode::{Deny, Warn, Log}`。
- `src/cli.rs`：`TestOutput` 的 decision 注释、structured 输出分支、pretty 输出中的 `WARN (policy allows)`、`classify_command` 的 warn 映射。
- `src/evaluator.rs`：`EvaluationDecision` 和 `DecisionMode` 是两个不同层次。

### `indeterminate`

#### 已确认事实

`EvaluationDecision::Indeterminate` 表示安全分析没有完成，不能当作 allow。robot `TestOutput` 分支会输出：

```json
{
  "decision": "indeterminate",
  "reason": "Safety evaluation did not complete within the analysis budget",
  "explanation": "Execution is blocked because DCG could not complete safety analysis.",
  "source": "analysis_budget"
}
```

退出码为 `1`。

#### 重要范围区别

hook 模式在 `src/main.rs` 中创建 deadline，默认使用 `HOOK_EVALUATION_BUDGET`。但 `src/cli.rs` 的 `test_command` 调用
`evaluate_command_with_pack_order_deadline_at_path(...)` 时传入的是 `None` deadline。

因此：

- hook 模式有明确的 200ms 绝对分析预算；
- 当前 `dcg --robot test` 的普通 test 路径没有把这个外层 deadline 传进去；
- `TestOutput` 仍然保留 `indeterminate` 分支，公共 evaluator 也支持它；
- 不能据此保证每个 robot `test` 超时都会产生 `indeterminate`。

源码测试 `src/evaluator.rs` 的 deadline tests 用一个已过期的 `Duration::ZERO` deadline 验证：即使输入是 `git reset --hard`，结果也必须是 `indeterminate`，不能静默 allow。这证明了 evaluator 的预算语义，但不是一个证明 `dcg --robot test` 当前默认会超时的 E2E 测试。

### 内部错误

#### 已确认事实

当前没有找到一个专门为 `dcg --robot test` 定义的稳定“错误 JSON envelope”。`TestOutput` 只覆盖 allow、deny、indeterminate。

内部错误可能表现为：

- CLI 参数解析失败：clap 错误文本和退出码，非 `TestOutput`；
- 配置文件读取/解析问题：通常警告并继续使用其它配置层或默认配置；
- 子进程启动失败：这是 Pi extension 的 `spawn` 错误，不是 DCG JSON；
- DCG 进程被信号终止、异常退出或输出非 JSON：由外部扩展自行处理。

`.references/destructive_command_guard/docs/adr-002-robot-mode-api.md` 和 `src/exit_codes.rs` 描述了更宽泛的 `3/4/5` 标准化错误码，但 `test` 的实际 dispatch 没有为所有错误路径建立独立 JSON 错误协议。

---

## 3. robot mode JSON 字段、示例和展示建议

### 已确认字段

`src/cli.rs` 的 `TestOutput` 是当前 `dcg test` JSON 的主要事实来源：

| 字段 | 是否可能出现 | 用途 |
|---|---|---|
| `schema_version` | 是 | 当前为 `1`，用于版本兼容 |
| `dcg_version` | 是 | DCG 版本 |
| `robot_mode` | 是 | 当前是否启用了 robot mode |
| `command` | 是 | 被检查的原始命令 |
| `decision` | 是 | `allow`、`deny` 或 `indeterminate` |
| `rule_id` | deny 时可能有 | 组合形式，如 `core.git:reset-hard` |
| `pack_id` | deny 时可能有 | 命中的规则包 |
| `pattern_name` | deny 时可能有 | pack 内规则名 |
| `reason` | deny/indeterminate 时可能有 | 简短理由 |
| `explanation` | deny/indeterminate 时可能有 | 更长解释 |
| `source` | deny/indeterminate 时可能有 | `pack`、`legacy_pattern`、`config_override`、`heredoc_ast`、`analysis_budget` 等 |
| `matched_span` | 某些 deny 时可能有 | 命令中的字节范围，不是字符范围 |
| `severity` | 规则 deny 时可能有 | `critical`、`high`、`medium`、`low` |
| `allowlist` | allowlist 放行时可能有 | `layer`、`reason` |
| `agent` | 当前 structured test 分支会填充 | `detected`、`trust_level`、`detection_method` |

可参考的 deny 示例：

```json
{
  "schema_version": 1,
  "dcg_version": "0.6.9",
  "robot_mode": true,
  "command": "rm -rf ./src",
  "decision": "deny",
  "rule_id": "core.filesystem:rm-rf-general",
  "pack_id": "core.filesystem",
  "pattern_name": "rm-rf-general",
  "reason": "rm -rf is destructive and requires human approval",
  "explanation": "The command can recursively delete a directory tree.",
  "source": "pack",
  "severity": "high",
  "agent": {
    "detected": "unknown",
    "trust_level": "medium",
    "detection_method": "none"
  }
}
```

可参考的 allow 示例：

```json
{
  "schema_version": 1,
  "dcg_version": "0.6.9",
  "robot_mode": true,
  "command": "git status",
  "decision": "allow",
  "agent": {
    "detected": "unknown",
    "trust_level": "medium",
    "detection_method": "none"
  }
}
```

### 适合直接展示给用户的字段

优先展示：

1. `decision`；
2. `reason`；
3. `explanation`；
4. `rule_id`；
5. `severity`；
6. 必要时展示原始 `command`。

适合作为调试信息、而不是主消息的字段：

- `pack_id`、`pattern_name`；
- `source`；
- `agent`；
- `dcg_version`；
- `matched_span`。

`matched_span` 是字节偏移，直接展示给普通用户意义较低。当前 `TestOutput` 也没有 `remediation` 字段；Pi 集成文档提到 denial JSON 可能带 remediation，但当前 `dcg test` 的 `TestOutput` 结构并不提供该字段。不要把 Pi 文档中的 remediation 描述当作 `--robot test` 的稳定字段。

依据：

- `.references/destructive_command_guard/src/cli.rs`：`TestOutput`。
- `.references/destructive_command_guard/tests/e2e/robot_mode_test.sh`：验证 decision、rule_id、pack_id、severity、reason、command、agent。
- `.references/destructive_command_guard/docs/pi-integration.md`：官方 Pi 调用方式，但其字段描述比当前 `TestOutput` 结构更宽泛。
- `.references/destructive_command_guard/tests/json_schema_conformance.rs`：hook JSON schema 的真实输出校验；它主要验证 hook protocol，不应替代 `TestOutput` 结构。

### Robot mode 的 stdout/stderr/UI

#### 已确认事实

robot mode 的设计和 E2E 测试要求：

- stdout 是 JSON；
- 没有 ANSI 装饰；
- stderr 静默；
- 不使用 DCG 的 rich/TUI 人类面板。

官方 Pi recipe 的 `spawn` 设置是：

- `stdin: ignore`；
- `stdout: pipe`；
- `stderr: ignore`。

因此 Pi extension 通常只读取 stdout JSON，并把 `reason` 转换成 Pi 的 block reason。用户看到的最终 UI 是 Pi 的 UI，不是 DCG 的 rich denial panel。

---

## 4. 配置缺失、无效、分析超时和进程异常

### 配置缺失

#### 已确认事实

缺少配置文件不是错误。`Config::load()` 从默认配置开始；默认情况下至少启用：

- `core`，展开为 `core.git` 和 `core.filesystem`；
- `system.disk`，默认开启但可显式关闭。

其它数据库、容器、云和 Kubernetes pack 通常需要额外启用。

依据：`src/config.rs` 的 `PacksConfig::enabled_pack_ids`，以及 `README.md` 的默认 pack 说明。

### 配置无效

#### 已确认事实

`src/config.rs` 的配置加载器遇到无效 TOML 时会打印 warning，并忽略该层，而不是让 hook 直接崩溃。`tests/config_error_repro.rs` 验证无效的显式配置会被吞掉，命令继续使用默认配置。

`dcg test --config <path>` 如果 `Config::load_from_file` 失败，`src/cli.rs` 会打印 warning，并回退到已经加载的基础配置。

自动发现的项目 `.dcg.toml` 解析失败时会被忽略。

#### 注意

robot mode 的设计文档要求 stderr 静默，但配置加载器的某些错误路径直接调用 `eprintln!`。E2E 测试主要验证正常 robot evaluation 的 stderr 静默，没有覆盖所有配置错误组合。因此“配置错误时 stderr 永远为空”不能作为已完全确认的事实。

### 分析超时

#### 已确认事实

hook 模式的默认绝对 evaluator budget 是 200ms，`src/perf.rs` 定义：

```text
ABSOLUTE_MAX = 200ms
HOOK_EVALUATION_BUDGET_MS = 200
MIN_HOOK_TIMEOUT_MS = 10
```

hook 模式超时会变成 `EvaluationDecision::Indeterminate`，不能静默 allow。`src/main.rs` 会向支持的 hook 协议输出 indeterminate/review 或 block 结果。

#### 重要区别

当前 `dcg --robot test` 的 `test_command` 没有传递 deadline，因此其启动成本、配置读取和 evaluator 执行没有复用 hook 模式的全局 200ms deadline。内部规则自身仍有深度、输入大小和 AST/解释器限制。

### Pi 子进程异常

#### 已确认事实

官方 `docs/pi-integration.md` 示例的行为是：

- `spawn` 失败：返回 `deny: false`，即 fail-open；
- 退出码为 `1`：尝试解析 stdout；解析失败则使用通用 deny reason；
- 退出码为 `0`：继续放行；
- 其它退出码：示例也走放行分支，并注释为把 DCG error 当作 fail-open。

示例没有设置 child-process timeout，也没有在 DCG 卡住时主动 kill 子进程。

### 合理推断

对 Pi Guard 来说，以下三类状态不能混为“命令安全”：

```text
DCG 返回 allow       = DCG 明确完成了检查并允许
DCG 返回 deny        = DCG 明确阻止
DCG 无法启动/异常退出 = 没有得到安全结论
```

官方示例选择了最后一种 fail-open，这是兼容性选择，不是“已证明安全”。

### 仍然未知

源码和 Pi recipe 没有给出一个完整的“外部扩展应该如何处理所有异常”的稳定协议，特别是：

- 子进程启动后长时间不退出时的推荐 timeout；
- stdout 半截 JSON、进程被 signal 杀死时的正式语义；
- `dcg --robot test` 遇到所有配置/IO 失败组合时是否都保持纯 JSON。

---

## 5. allowlist、allow-once、bypass 和外部安全调用

### Allowlist

#### 已确认事实

DCG 有分层 allowlist：

- 项目：`.dcg/allowlist.toml`；
- 用户：`~/.config/dcg/allowlist.toml` 或平台配置目录下的等价路径；
- 系统：Unix 下 `/etc/dcg/allowlist.toml`，macOS 下 `/private/etc/dcg/allowlist.toml`，native Windows 下名义路径为 `%ProgramData%\\dcg\\allowlist.toml`，但系统层在 Windows 上有额外信任限制。

allowlist 可以按以下方式放行：

- rule ID；
- exact command；
- command prefix；
- pattern；
- 带路径范围的项目例外。

`dcg allow <rule-id> --reason ...` 默认写用户层；项目 allowlist 需要明确的项目策略信任。DCG 不把仓库中自动发现的内容自动当作用户授权。

项目 `.dcg/allowlist.toml` 默认只有在用户通过 `DCG_CONFIG` 明确选择并信任仓库根 `.dcg.toml` 时才激活。

依据：

- `src/allowlist.rs` 模块注释、`load_default_allowlists`、`user_allowlist_path`、`project_allowlist_path`。
- `src/config.rs` 的项目配置信任边界。
- `docs/configuration.md` 的 allowlist 章节。

### allow-once

#### 已确认事实

原生 hook 模式在产生 deny 时，会创建 pending exception，并把短码、完整 hash 等信息放入 hook denial 输出。用户可以执行：

```text
dcg allow-once <CODE>
```

它会把 pending exception 转成一个当前目录/项目范围的 active allow-once entry；可配置为单次消费，记录有过期、消费和撤销状态。对 config blocklist，默认还要求额外的 `--force`。

重要的是：`dcg --robot test` 的 `TestOutput` 结构没有 `allowOnceCode` 字段，`test_command` 也不是原生 hook deny 分支。因此官方 Pi recipe 不会自动获得一个可直接用于 allow-once 的 DCG 短码。

依据：

- `src/main.rs` deny 分支中的 `PendingExceptionStore::record_block` 和 hook denial 输出。
- `src/cli.rs` 的 `AllowOnceCommand` 和 `handle_allow_once_command`。
- `src/pending_exceptions.rs` 的 pending/active/consume 实现。
- `docs/allow-once-usage.md`。

### bypass

#### 已确认事实

`DCG_BYPASS=1` 是一个全局逃生变量。`src/main.rs` 的无子命令 hook 路径在读取 hook 输入前检查 `Config::is_bypassed()`，设置后直接返回，不进行 hook 评估。

#### 重要实现边界

源码中对 `DCG_BYPASS` 的直接检查位于 bare hook 路径；`Command::TestCommand` 的 CLI dispatch 没有同样的 bypass 检查。因此“`DCG_BYPASS=1` 一定绕过 `dcg --robot test`”不是当前源码能确认的结论，甚至看起来并不适用于该 test dispatch。

#### 外部 Pi 扩展是否能安全调用

- `dcg --robot test`：只读检查接口，可以安全调用；
- `dcg allow-once`：会改变持久化状态并放行后续命令，不应由模型自动调用；
- `dcg allow` / `allowlist add`：会写持久化授权，不应由模型自动调用；
- `DCG_BYPASS=1`：应禁止由模型或不受信任命令传入；
- `dcg allow-once --yes`、`--force`：更不能作为自动化工具暴露。

---

## 6. 配置发现顺序和作用域

### 配置文件发现顺序

#### 已确认事实

配置的有效优先级（高到低）是：

1. 环境变量覆盖；
2. 显式 `DCG_CONFIG`；
3. 用户配置；
4. 系统配置；
5. 编译默认值。

源码实际加载系统层后加载用户层，再处理自动发现的项目 `.dcg.toml`，最后合并显式 config，最后应用环境变量。因此项目文件不是普通的“更高优先级用户配置”。

自动发现的仓库 `.dcg.toml` 只允许单调增强安全的设置，例如：

- 增加启用 pack；
- `default_mode = "deny"`；
- `general.fail_closed = true`；
- 启用 heredoc；
- 关闭 heredoc 的 fail-open fallback。

它不能通过仓库内容自动：

- 关闭 pack；
- 添加 allowlist；
- 改写 allow 规则；
- 加载仓库控制的 custom pack 路径；
- 放松 agent profile。

用户可以显式使用 `DCG_CONFIG=.dcg.toml`，这会把该文件作为完整的显式配置层。

### 路径

| 层 | 默认路径 |
|---|---|
| 显式 | `DCG_CONFIG` 指定；支持 `~` 和相对当前目录解析 |
| 用户 Unix | `$XDG_CONFIG_HOME/dcg/config.toml`；否则 `~/.config/dcg/config.toml`；再否则 `dirs::config_dir()/dcg/config.toml` |
| 系统 Linux/其它 Unix | `/etc/dcg/config.toml` |
| 系统 macOS | `/private/etc/dcg/config.toml` |
| 系统 native Windows | `%ProgramData%\\dcg\\config.toml`，但当前系统层有 ACL/reparse trust 限制 |
| 自动项目 | 当前 Git 仓库根目录的 `.dcg.toml`，最多向上搜索 50 层 |

### Pi 相关作用域

官方 Pi extension 的 `spawn` 没有覆盖 `cwd` 或 `env`，因此 Node 子进程默认继承：

- Pi 当前工作目录；
- Pi 的环境变量；
- `HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`、`DCG_CONFIG` 等。

这意味着 Pi 从哪个目录发起 tool call，会影响项目 `.dcg.toml`、项目 allowlist、Git 根目录和 path-scoped allowlist。

依据：

- `src/config.rs` 的 `Config::load_internal`、`user_config_candidates`、`system_config_dir`。
- `docs/configuration.md`。
- `src/allowlist.rs`。
- `docs/pi-integration.md` 的 `spawn` 示例。

---

## 7. 每条命令启动一次子进程的开销、daemon 和批量接口

### 已确认事实：官方 Pi recipe

官方 recipe 对每个非空 Bash tool call 执行一次：

```text
spawn(DCG_BIN, ["--robot", "test", command])
```

这意味着每次都要重新启动一个 DCG 进程，并重新经过 CLI、配置、allowlist、pack 初始化路径。

### 已确认事实：仓库已有的性能数据边界

仓库 README 和 `src/perf.rs` 描述的是 DCG evaluator/hook 的目标：

- 常规分析通常低于 10ms；
- hook 绝对预算 200ms；
- README 宣称典型执行可达到 sub-millisecond。

但是 `benches/hook_latency.rs` 测量的是已经初始化好的**进程内 evaluator**，不是“Node `spawn` + DCG 进程启动 + 配置加载”的端到端成本。`tests/e2e/robot_mode_test.sh` 只验证一次 robot 调用不超过 200ms，不提供稳定的 p50/p95/p99 数字。

因此：

> 仓库没有给出每次外部子进程调用的可靠典型开销数字。可以确认它包含进程启动成本，但不能从现有 benchmark 推导具体毫秒数。

### Batch 接口

DCG 有：

```text
dcg hook --batch
```

它从 stdin 读取 JSONL，一行一个 hook 输入，输出 JSONL；还支持 `--parallel`、`--workers` 和 `--continue-on-error`。批处理进程级退出码是：

- 任意 deny/indeterminate：`1`；
- 解析错误导致停止：`4`；
- 其它情况：`0`。

但 batch 模式的 evaluator 调用也传入 `None` deadline，不能自动套用 hook 模式的全局 200ms deadline。

### Server/daemon 接口

DCG 有：

```text
dcg mcp-server
```

它通过 stdio 启动长期运行的 MCP server，一次加载配置，并提供：

- `check_command`；
- `scan_file`；
- `explain_pattern`。

它可以避免每条命令重复启动进程，但它是 MCP 工具服务器，不是官方 Pi `tool_call` pre-execution extension 的同一接口。它是否适合作为 Pi Guard 的阻断点，不能仅凭 DCG 仓库事实确认。

依据：

- `docs/pi-integration.md`。
- `src/cli.rs` 的 `HookCommand` / `run_hook_command`。
- `src/mcp.rs`：MCP server 是 stdio 长进程，并在 `DcgMcpServer::new()` 时加载配置。
- `benches/hook_latency.rs`。
- `tests/e2e/robot_mode_test.sh`。

---

## 8. Linux、macOS、WSL、Windows 的安装和调用差异

### Linux

#### 已确认事实

`install.sh` 的预编译 target：

- x86_64：`x86_64-unknown-linux-musl`；
- aarch64：`aarch64-unknown-linux-gnu`。

默认安装到：

```text
~/.local/bin/dcg
```

可用 `--system` 安装到 `/usr/local/bin`，`--easy-mode` 修改 shell PATH，`--version v0.6.9` 固定版本，`--verify` 执行自测。

### macOS

预编译 target：

- Intel：`x86_64-apple-darwin`；
- Apple Silicon：`aarch64-apple-darwin`。

同样使用 `install.sh`，默认路径是 `~/.local/bin/dcg`。系统配置目录是 `/private/etc/dcg`，不是直接使用 `/etc/dcg`，因为 macOS 的 `/etc` 是 symlink。

### WSL

#### 已确认事实

DCG 文档明确说：WSL 下按 Linux 行为运行。应在 WSL 环境中安装 Linux `dcg`，使用 Linux PATH、Linux HOME 和 Linux 配置路径；不要把 native Windows `dcg.exe` 当成 WSL 版本。

### native Windows

#### 已确认事实

使用 PowerShell installer：

```powershell
install.ps1 -EasyMode -Verify
```

预编译 target：

- `x86_64-pc-windows-msvc`；
- `aarch64-pc-windows-msvc`。

默认文件名是 `dcg.exe`，默认安装目录是：

```text
%USERPROFILE%\\.local\\bin
```

`-EasyMode` 修改 User PATH。Node 的 `spawn` 可以使用 `dcg.exe` 或显式的绝对路径；Windows 下不要假设 Unix 的 `/usr/local/bin/dcg` 存在。

native Windows 额外默认开启：

- `windows.filesystem`；
- `windows.system`。

WSL 不享受这两个 native Windows 默认 pack；WSL 使用 Linux 规则和 Linux binary。

### 安全安装依据

两个安装器都支持版本固定和 checksum 校验；PowerShell 文档确认 Windows 强制 SHA256 校验，minisign/cosign 视条件可用。这里的“安装器自动配置 agent hooks”不等于自动配置 Pi：DCG 文档明确表示 Pi 需要用户自己安装 extension。

依据：

- `install.sh` 的 `detect_platform`、artifact 选择、`run_install_self_test`。
- `install.ps1`。
- `docs/windows.md`。
- `docs/pi-integration.md`。

---

## 9. 复合命令、`bash -c`、脚本路径和 heredoc

### 复合命令

#### 已确认事实

DCG 会拆分 shell sequence/pipeline segment，并检查各个 segment；随后在需要时也检查完整命令。这样可以避免一个安全 segment 掩盖另一个危险 segment。

例如，下面这种命令不会因为第一段安全就自动整体放行：

```bash
git status && git reset --hard
```

不同 pack 的安全模式也不会简单地遮蔽另一个 segment 的危险模式。

依据：`src/packs/mod.rs` 的 `check_command`、`check_command_single`，以及 `src/evaluator.rs` 的主流程。

### `bash -c`、inline launcher、嵌套解释器

#### 已确认事实

DCG 会对一部分 launcher 做递归分析，例如：

```bash
bash -c 'rm -rf ./src'
```

内层 payload 会作为嵌套命令重新进入 evaluator。类似路径还包括 `sh -c`、`python -c`、PowerShell `-Command`、PowerShell script block 和若干 executable text sink。

静态分析无法确认动态 payload 时，很多路径不是 allow，而是一个高严重级别的 fail-closed deny，例如：

- 动态 launcher payload；
- 超过嵌套深度；
- 动态 `eval`/`Invoke-Expression` 源码；
- 过多 indirect input flow。

`MAX_EMBEDDED_SHELL_DEPTH` 当前为 `8`；相关 evaluator 测试构造超过 8 层的 PowerShell/Cmd 嵌套并验证阻止。

### 脚本路径

#### 已确认事实

`dcg --robot test "bash script.sh"` 只把命令行字符串交给 evaluator。源码对 POSIX shell pipeline input 的分类明确区分：

- bare `bash`/`sh` 可能从 stdin 读取源码；
- `bash -c CODE` 有 inline payload；
- positional script path 不被当作 stdin source。

目前没有找到 `dcg test` 对任意 `bash script.sh` 自动打开并完整扫描该脚本文件内容的通用路径。文件内容扫描是 `dcg scan` 的职责，例如扫描显式路径、staged 文件、Git diff 等。

因此，不能把下面两个行为等同起来：

```text
dcg --robot test "bash script.sh"  → 主要分析这条启动命令

dcg scan script.sh                  → 读取并扫描脚本文件内容
```

这是当前代码的一个重要 scope boundary。

### heredoc

#### 已确认事实

DCG 有一条独立的 heredoc/inline-script 三层管线：触发器、内容提取、AST 匹配。支持 Bash、Python、JavaScript、TypeScript、Ruby、Go、PHP 等语言的部分 AST 分析。

但 `HeredocConfig::default()` 中：

```text
enabled = false
fallback_on_parse_error = true
fallback_on_timeout = true
```

因此官方 Pi recipe 不传 `--heredoc-scan`；是否检查 heredoc，取决于 DCG 配置文件。也可以在 CLI `dcg test` 中用 `--heredoc-scan` 覆盖，但官方 Pi extension 没有传这个 flag。

静态可重建的 pipeline source（例如 literal producer 送入 bare `bash`）还有独立的 executable-source 分析路径；动态 source、文件 source 或无法静态验证的 source 可能 fail-closed deny。不能只用“heredoc 开关”概括所有内嵌 Shell 源码分析。

依据：

- `src/evaluator.rs`：launcher、executable text sink、command substitution、pipeline source、脚本路径分类。
- `src/config.rs`：`HeredocConfig` 和 `HeredocSettings::default`。
- `src/heredoc.rs`。
- `docs/adr-001-heredoc-scanning.md`。
- `docs/security.md`。
- `src/scan.rs`：文件扫描入口。

---

## 10. 证据索引与未知问题

### 已确认事实的主要依据

| 事实 | 主要依据 |
|---|---|
| Pi recipe 是逐命令 spawn 外部 binary | `docs/pi-integration.md` |
| robot `test` JSON 字段 | `src/cli.rs` 的 `TestOutput` |
| robot test 实际 0/1 退出逻辑 | `src/cli.rs` 的 `test_command`、`run_command` |
| 退出码常量 | `src/exit_codes.rs` |
| robot stdout/stderr 测试 | `tests/e2e/robot_mode_test.sh` |
| config 层和项目 trust boundary | `src/config.rs`、`docs/configuration.md` |
| allowlist 路径和层 | `src/allowlist.rs` |
| allow-once 状态转换 | `src/main.rs`、`src/cli.rs`、`src/pending_exceptions.rs`、`docs/allow-once-usage.md` |
| hook deadline | `src/main.rs`、`src/perf.rs`、`src/evaluator.rs` |
| `test` 不传 deadline | `src/cli.rs` 的 `test_command` evaluator 调用 |
| batch JSONL | `src/cli.rs` 的 `run_hook_command`、`tests/stdin_batch_mode.rs` |
| 长期 MCP server | `src/mcp.rs`、`src/cli.rs` |
| 平台安装 | `install.sh`、`install.ps1`、`docs/windows.md` |
| 复合/嵌套/脚本/heredoc 分析 | `src/evaluator.rs`、`src/heredoc.rs`、`src/scan.rs`、`docs/adr-001-heredoc-scanning.md` |

### 合理推断

1. 官方 Pi recipe 的最大运行时成本不只是规则匹配，还包括每次子进程启动、配置加载和 pack 初始化。
2. Pi extension 应把 `dcg --robot test` 的 stdout 当作结构化结果，把 stderr 和人类 TUI 当作非协议内容；不过正常 robot mode 下 stderr 应为空。
3. 当前官方示例的 fail-open 异常策略不能直接当作 Sandbox 的安全结论。
4. 如果要使用项目级策略，Pi 子进程的 cwd 和 `DCG_CONFIG` 继承关系必须保持可观察，否则用户会看到“同一命令在不同目录结果不同”。

### 仍然未知的问题

以下问题没有被 DCG v0.6.9 的文档、源码和测试完全定义：

1. `dcg --robot test` 的每次冷启动端到端 p50/p95/p99 开销；仓库只有 evaluator benchmark 和 200ms 阈值测试。
2. 官方 Pi recipe 在子进程启动后无限等待的实际风险边界；recipe 没有 child timeout。
3. 所有配置错误、stdout 截断、signal termination 组合下的正式 robot error JSON 协议。
4. `dcg --robot test` 是否会在未来把 `DecisionMode::Warn` 正式映射为独立的 `warn` JSON；当前 `TestOutput` 没有该值。
5. 对任意 `bash script.sh` 的脚本文件内容，`dcg test` 当前不承担通用文件扫描；`dcg scan` 才是明确的文件扫描接口，但 Pi pre-execution 期间是否需要另行扫描脚本文件，DCG 文档没有给出一个统一 hook contract。
6. MCP server 与 Pi Guard pre-execution veto 之间没有 DCG 官方适配契约；它只确认 MCP 工具协议和 stdio server 的存在。

---

## 范围声明

本报告没有修改 Pi Guard，没有新增 extension，也没有决定 DCG binary 的下载、版本更新、fallback 或 fail-open/fail-closed 策略。它只整理了 DCG v0.6.9 为后续规划所需的事实、推断和未决问题。

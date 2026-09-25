# Pi Guard Sandbox 设计文档 v0.1（定稿）

## 1. 目标

Pi Guard v0.1 的目标不是完整隔离，也不是信息防泄漏。

它的目标是：

> **write-boundary protection**
>
> 防误改、防越界写、防破坏性操作，同时尽量保留 Pi 的自由度和效率。

换句话说，v0.1 重点解决：

1. Pi 不能未经批准修改 workspace 外文件
2. `readonly` 下 bash 仍可运行，但不能写真实持久文件系统
3. `workspace-write` 下 Pi 可自由修改当前 workspace，但 workspace 外写入必须 approval
4. 明显危险命令即使发生在 workspace 内，也要 approval 或 direct-block

## 2. 非目标

v0.1 **不解决**：

1. 完整 workspace isolation
2. 信息外泄防护
3. 默认网络隔离
4. bash 外部写入路径的静态分析与 approval
5. 用户手动 `!cmd` / `!!cmd` 的保护
6. `grep/find/ls` 三个可选内建工具的纳管
7. 审计日志系统
8. 通用 package 化

## 3. 作用范围

v0.1 是一个**项目级 extension**，先服务当前项目，不预付通用 package 成本。

只保证 Pi 默认 4 个工具：

- `read`
- `write`
- `edit`
- `bash`

明确不纳管：

- 用户手动 `!cmd` / `!!cmd`
- `grep/find/ls`（即使 Pi 本体支持，这一版也不保证）

Guard 的 scope 必须在 UI 和 `/guard` 状态中明确显示：

> **Scope: agent tools only**

## 4. 核心架构结论

### 4.1 总体路线

v0.1 采用：

- **重写 extension 主体**
- **选择性复用现有规则代码**
- `bash` 改为走 **`@anthropic-ai/sandbox-runtime`**

原因：

- 现有 `approval-gate` 的目标与新目标不完全同构
- 继续在旧主体上缝合 mode + sandbox + config，路径依赖更重
- 最短路径是：新主体 + 局部复用规则实现

### 4.2 安全边界分层

#### 文件工具层

- `read/write/edit` 走 Guard 的路径策略与 approval 逻辑

#### bash 执行层

- `bash` 走 sandbox runtime
- 用 OS 级边界强制限制写入范围

#### 重要原则

- 黑名单不是主边界
- bash 的主边界是 sandbox
- 不把 v0.1 拖成 bash 静态分析器

## 5. workspace 定义

v0.1 的 `workspaceRoot` 定义为：

> **Pi 启动时 cwd 的 realpath**

并且：

- 当前项目内固定不变
- 不跟随运行时 `cd` 漂移
- 不做配置化 root

## 6. 模式定义

v0.1 只有两个模式：

- `readonly`
- `workspace-write`

没有 `off` 模式。

想完全不受保护：

> 不加载这个 extension

### 6.1 默认模式

新项目/新配置初始化后的默认模式是：

> `workspace-write`

原因：效率优先，且它已保住最关键边界。

### 6.2 readonly

`readonly` 的**准确定义**是：

> 禁止对真实持久文件系统写入，但允许 sandbox 内临时运行环境写入。

允许写：

- sandbox `/tmp`
- 临时 HOME，例如 `/tmp/pi-home`
- 临时 cache 目录

不允许写：

- 真实 workspace
- 真实 home
- 真实系统目录
- 任何真实持久文件系统路径

### 6.3 workspace-write

`workspace-write` 的语义是：

- 允许 bash 写 `workspaceRoot`
- 允许 bash 写 sandbox `/tmp`
- 不允许 bash 写 workspace 外真实路径
- workspace 外 bash 写入不做 approval 主路径，直接失败

## 7. 各工具行为

## 7.1 read

v0.1 的 `read` 策略：

- workspace 内：允许
- workspace 外普通路径：允许
- 命中敏感读取 deny：直接拒绝
- 不做 approval

### v0.1 默认敏感读取 deny 最小集合

- `~/.ssh`
- `~/.aws`
- `~/.gnupg`
- `~/.git-credentials`
- `~/.env`
- `~/.env.*`
- `~/.npmrc`
- `~/.pypirc`
- `~/.netrc`
- WSL 下 `/mnt/c/.../.ssh` 这类 Windows 侧敏感凭据路径

用户可以在配置文件中追加更多 deny 路径。

## 7.2 write / edit

### readonly

- 一律拒绝
- 不做 approval 例外
- 想写先切到 `workspace-write`

### workspace-write

- workspace 内：直接允许
- workspace 外：**allow-once approval**
- approval 通过后，继续调用原生 `write/edit`
- Guard 不自己重写文件工具实现

### approval 粒度

workspace 外写入 approval 按：

> **具体目标路径**

不是目录级授权，不做 session 级白名单。

### protected paths

v0.1 保留 protected paths，但只作用于 `write/edit`，**不作用于 bash**。

默认建议策略：

#### direct-block

- `.git`
- `node_modules`

#### approval

- `.env`
- `.env.*`
- `.pi/pi-guard.json`

说明：

- `.pi/pi-guard.json` 可被 `write/edit` 修改，但必须 approval
- `.pi/pi-guard.json` 不允许通过 `bash` 修改

## 7.3 bash

### 总原则

- `bash` 一律走 sandbox backend
- 主边界靠 sandbox，不靠命令静态分析
- 不支持 bash workspace 外写入 approval

### readonly

- 可运行 bash
- 不能对真实持久文件系统写入
- 可写 sandbox `/tmp` / 临时 HOME / cache

### workspace-write

- 可运行 bash
- 可写 `workspaceRoot` 与 sandbox `/tmp`
- 写 workspace 外直接失败

### 敏感读取 deny

敏感读取 deny 不只作用于 `read`，也作用于 `bash`。

也就是：

- `read ~/.ssh/id_rsa` → deny
- `bash: cat ~/.ssh/id_rsa` → deny

实现上：

- `read` 走 Guard 路径策略
- `bash` 走 sandbox `denyRead`

## 8. 危险 bash 策略

危险命令分两层：

- direct-block
- require-approval

这套分类在 `readonly` / `workspace-write` 两种模式里：

> **保持一致**

模式只影响文件系统边界，不改变危险命令分类。

### 8.1 direct-block（v0.1）

- `sudo`
- `su`
- `mount`
- `umount`
- `mkfs*`
- `dd`
- `docker run -v /:/host ...` 及等价 host root bind mount
- `curl | sh`
- `curl | bash`
- `wget | sh`
- `wget | bash`

### 8.2 require-approval（v0.1）

- `rm -rf`
- `git reset --hard`
- `git clean -fd`
- `git clean -xdf`
- `chmod -R`
- `chown -R`
- `bash -c ...`
- `sh -c ...`

### 8.3 无 UI 行为

所有需要 approval 的操作，在没有 UI 时：

> **一律 deny**

## 9. 用户手动 bash

v0.1 明确不保护：

- `!cmd`
- `!!cmd`

也就是说：

> **Guard 只管 Agent tool path，不管用户手动 bash。**

这个边界必须在 `/guard` 状态与 UI 状态中明确写出。

## 10. 配置文件

项目级权威配置文件路径：

> `.pi/pi-guard.json`

### 10.1 配置原则

- 完整显式配置
- 权威配置
- 只包含 v0.1 真实生效字段
- 路径规则采用**路径 / glob 风格**，不暴露 regex
- 配置负责**策略透明**，代码负责检测实现

### 10.2 配置所有权

mode 是：

> **项目级状态**

不是 session 级状态。

所以：

- `/guard readonly`
- `/guard workspace-write`

会直接改写 `.pi/pi-guard.json`，并立即生效。

### 10.3 配置文件示例（v0.1）

```json
{
  "mode": "workspace-write",
  "sensitiveReadDeny": [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.git-credentials",
    "~/.env",
    "~/.env.*",
    "~/.npmrc",
    "~/.pypirc",
    "~/.netrc",
    "/mnt/c/Users/*/.ssh"
  ],
  "protectedPaths": {
    "block": [
      ".git",
      "node_modules"
    ],
    "approval": [
      ".env",
      ".env.*",
      ".pi/pi-guard.json"
    ]
  },
  "bashPolicy": {
    "directBlock": [
      "sudo",
      "su",
      "mount",
      "umount",
      "mkfs",
      "dd",
      "docker-host-root-bind",
      "curl-pipe-sh",
      "curl-pipe-bash",
      "wget-pipe-sh",
      "wget-pipe-bash"
    ],
    "requireApproval": [
      "rm-rf",
      "git-reset-hard",
      "git-clean-fd",
      "git-clean-xdf",
      "chmod-r",
      "chown-r",
      "bash-c",
      "sh-c"
    ]
  }
}
```

## 11. 初始化与失效状态

## 11.1 未初始化

如果 `.pi/pi-guard.json` 不存在：

- extension 可以加载
- Guard **不生效**
- UI 必须明确显示：`Guard: uninitialized`
- 用户通过 `/guard init` 生成模板配置

v0.1 不自动生成配置。

## 11.2 `/guard init`

`/guard init` 的行为：

1. 生成完整显式模板配置
2. 不覆盖已有配置
3. 成功后**立即启用 Guard**
4. 不需要 `/reload`

如果生成失败：

- fail-closed
- 不进入受保护状态
- UI 明确报错

## 11.3 无效配置

如果 `.pi/pi-guard.json` 存在但内容无效：

- extension 继续加载
- Guard **不生效**
- UI 明确显示：`Guard: invalid-config`
- `/guard` 可查看错误原因
- 修复后通过 `/reload` 生效

## 11.4 sandbox 初始化失败

如果 sandbox backend 初始化失败：

- fail-closed
- Guard 不能声称自己处于受保护状态
- UI 必须明确显示失败状态
- 不能静默退回普通 bash

## 12. 命令与 UI

## 12.1 命令

v0.1 提供：

- `/guard`：查看当前状态
- `/guard init`：初始化配置
- `/guard readonly`：切换到 `readonly`
- `/guard workspace-write`：切换到 `workspace-write`

其中 mode 切换：

- 立即改写 `.pi/pi-guard.json`
- 立即更新当前 Guard 内存状态
- 不需要 `/reload`

## 12.2 状态显示

v0.1 必须在 UI 中持续显示 Guard 状态。

推荐最低实现：

- `setStatus()` 显示 footer 状态
- 必要时可追加 `setWidget()` 显示 editor 上方提示

不要求 v0.1 做输入框右上角精确定位 UI。

### 状态至少包含

- `uninitialized`
- `invalid-config`
- `readonly`
- `workspace-write`
- `sandbox-unavailable`（或等价失败状态）
- `scope: agent tools only`

## 13. 手工编辑配置后的生效方式

用户手工修改 `.pi/pi-guard.json` 后：

> 通过 `/reload` 生效

v0.1 不做自动热加载。

## 14. 实现建议

建议拆成这些最小模块：

1. `guard-extension.ts`
   - 新 extension 主体
   - 注册 `/guard` 命令
   - 维护 UI 状态

2. `guard-config.ts`
   - 读取/校验/写回 `.pi/pi-guard.json`
   - 生成 init 模板

3. `guard-rules.ts`
   - protected path 判定
   - sensitive read deny 判定
   - bash policy id 到检测实现的映射

4. `guard-bash.ts`
   - override `bash`
   - 对接 `@anthropic-ai/sandbox-runtime`
   - 构造 readonly / workspace-write 的 runtime config

5. `guard-tools.ts`
   - `read/write/edit` 的前置策略与 approval 逻辑

现有 `approval-gate` 中可选择性复用：

- 路径归一化与 workspace 判定思路
- protected path 匹配
- 部分危险命令 pattern

但不保留旧主体结构作为包袱。

## 15. 最小验证标准

### readonly

应成功：

- `pwd`
- `ls`
- `git status`
- `git diff`
- `python3 -c 'print("ok")'`

应失败：

- `echo x > a.txt`
- `touch a.txt`
- `python3 -c 'open("a.txt", "w").write("x")'`

应允许但只写临时区：

- `echo x > /tmp/a.txt`

### workspace-write

应成功：

- workspace 内 `write/edit`
- workspace 内 bash 写入

应失败：

- bash 写 workspace 外真实路径
- bash 修改 `.pi/pi-guard.json`

应 approval：

- workspace 外 `write/edit`
- `rm -rf`
- `git reset --hard`
- `git clean -fd`

应 direct-block：

- `sudo ...`
- `dd ...`
- `curl ... | sh`

### 敏感读取 deny

应拒绝：

- `read ~/.ssh/id_rsa`
- `bash -lc 'cat ~/.ssh/id_rsa'`

## 16. 最终结论

Pi Guard v0.1 不是完整隔离系统。

它是一个清晰、可落地、效率优先的第一版：

> **项目级 Agent write-boundary protection**
>
> - 只管 Agent
> - 只保证 4 个默认工具
> - bash 用 sandbox 做真实写边界
> - 外部读默认宽松，但拦最小敏感读
> - 外部写默认收紧，并通过明确 approval 管理
>
> 先把“不能随便乱改、乱写、乱执行危险命令”这件事做扎实。

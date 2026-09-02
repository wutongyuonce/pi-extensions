<img src="1image.png" width="720" />


<p align="left">
  <a href="https://www.npmjs.com/package/pi-guard-sandbox">
    <img src="https://img.shields.io/npm/v/pi-guard-sandbox" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/pi-guard-sandbox">
    <img src="https://img.shields.io/npm/dm/pi-guard-sandbox" alt="npm downloads" />
  </a>
  <a href="https://www.npmjs.com/package/pi-guard-sandbox">
    <img src="https://img.shields.io/npm/dt/pi-guard-sandbox" alt="npm total downloads" />
  </a>
</p>


> [!IMPORTANT]
> 已加入对 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard) [![DCG GitHub Stars](https://img.shields.io/github/stars/Dicklesworthstone/destructive_command_guard?style=flat&label=DCG%20stars)](https://github.com/Dicklesworthstone/destructive_command_guard) 的支持；DCG 需要您自行下载、安装和升级。

> [!NOTE]
> 两轮真实环境测试 **全部通过**：日常 bash、文件读写、git 操作丝滑无感；越界写入、危险命令、敏感读取一击即拦。

**支持平台：Linux / WSL。** macOS 未测试，理论上可能可用。Windows 不支持。

**Pi Guard** 给你的 Agent 加了一层 OS 级的**写边界保护**。它不靠正则猜意图，不搞令牌审批地狱。它知道什么时候该闭嘴让你干活，什么时候该出手替你挡刀。

- ⚙️ **完全可控**：保护模式、网络、Sandbox 和 DCG 策略都可按项目配置，并可在当前 Pi 运行中临时调整
- 🧠 **聪明**：工作区内任意发挥，工作区外寸步难行
- 🪶 **无感**：不打断你的正常编码流，只拦截真正越界的操作
- 🛡️ **硬核**：bash 命令运行在真实 sandbox 里，不是字符串匹配
- 🔍 **可选 DCG 支持**：可接入 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)，获得更完整的 Bash 命令风险判断
- 🎯 **精准**：read-only 和 workspace-write 两个模式，选一个就不用再纠结

---

**[English](README.md)**

---

## Changelog

- **0.2.4** — 新增可选 [Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) 集成、运行时 Guard／Sandbox／DCG 开关、`/guard` 参数补全和 Footer 状态显示。
- **0.2.1** — 沙箱继承宿主机环境变量，使用真实 `HOME`。修复 Tavily 等依赖 `~/.` 配置文件的工具。
- **0.2.0** — 新增网络开关：`/guard non` / `/guard noff` 打开或阻断全部外网连接。默认开放。footer 显示 `· network: open|blocked`。
- **0.1.0** — 初始发布：写边界保护，read-only / workspace-write 双模式，bash 沙箱，危险命令拦截。

---

## 1. 安装

### 系统依赖

| 工具 | 作用 | 安装 |
|------|------|------|
| `bwrap` | Linux 进程沙箱 | `sudo apt install bubblewrap` |
| `socat` | 沙箱网络代理 | `sudo apt install socat` |
| `rg` | 文件扫描 | `sudo apt install ripgrep` |

### 安装扩展

#### 从 npm 安装

```bash
pi install npm:pi-guard-sandbox      # 全局安装，所有项目生效
```

```bash
pi install -l npm:pi-guard-sandbox   # 仅当前项目生效
```

安装完成后进入项目，执行 `/guard i` 初始化。

#### 在本仓库内安装

如果你已经克隆了本仓库，开发源码位于 `extensions/pi-guard/`。它刻意不放在 `.pi/extensions/` 下，避免从仓库根目录启动 Pi 时自动加载开发中的插件：

```bash
cd extensions/pi-guard && npm install
```

请用 Pi 的 extension 参数显式测试它，再执行 `/guard init`。安装后的包仍遵循 Pi package 的正常 discovery 路径，不要把源码路径和安装路径混淆。

> 要全局安装，将 `extensions/pi-guard/` 复制到 `~/.pi/agent/extensions/pi-guard/`，在该目录执行 `npm install` 即可。

---

## 2. Guard 在你的项目里留下了什么

安装 Guard 之后，你的项目里会多出这些东西。了解它们，免得困惑。

| 项目 | 说明 |
|------|------|
| `.pi/pi-guard.json` | `init` 时创建，Guard 全部配置 |
| footer 状态行 | Pi 底部持续显示当前模式 |
| bash 沙箱 | 所有 Agent bash 命令改为沙箱执行，不在宿主机直跑 |
| `vendor/` 目录 | ~1.8MB，沙箱运行时（fork 自 `@anthropic-ai/sandbox-runtime`） |
| `extensions/pi-guard/` | 本仓库开发源码，不是 Pi 自动发现路径 |

> 删除 `.pi/pi-guard.json` 后执行 `/reload` 即可停用 Guard。

---

## 3. 快速开始

在项目目录启动 Pi，然后：

```
/guard init              → 初始化，创建配置
/guard read-only         → 临时切到 read-only
/guard sandbox off       → 临时关闭 OS 沙箱包装
/guard dcg off           → 临时改用内置 Bash policy
```

初始化后 Guard 立即生效，footer 会显示当前状态。

---

## 4. 命令参考

| 命令 | 简写 | 作用 |
|------|------|------|
| `/guard status` | — | 查看完整运行时状态和配置 |
| `/guard init` | `/guard i` | 创建 `.pi/pi-guard.json` 并启用 Guard |
| `/guard on` / `/guard off` | — | 仅在当前 Pi 运行中开启/关闭全部 Guard |
| `/guard sandbox on` / `off` | — | 仅在当前 Pi 运行中开启/关闭 OS Sandbox |
| `/guard dcg on` / `off` | — | 仅在当前 Pi 运行中开启/关闭可选 DCG policy |
| `/guard read-only` | `/guard r` | 切换到 read-only 模式 |
| `/guard workspace-write` | `/guard w` | 切换到 workspace-write 模式 |
| `/guard network on` | `/guard non` | 开放全部外网连接（默认） |
| `/guard network off` | `/guard noff` | 阻断全部外网连接 |

Slash 命令都是运行时 override，不会写回 `.pi/pi-guard.json`；重启 Pi 后恢复项目默认值。`/guard <Tab>` 可补全规范化命令，`/guard status` 显示当前 override。Footer 只显示紧凑状态，例如 `[Guard: workspace-write · DCG]`、`[Guard: sandbox-off · built-in]` 或 `[Guard: OFF]`。

关闭 Sandbox 后，path policy 和 Bash policy 仍生效，但 Agent Bash 拥有宿主机正常的文件系统和网络权限；关闭 Guard 则会暂停全部保护，直到用户执行 `/guard on`。

> **注意：** 即使网络开放，沙箱内 `ping`（ICMP）也不可用。Bubblewrap 默认剥离 `CAP_NET_RAW`。HTTP/HTTPS（curl、wget、git 等）正常工作。

---

## 5. 模式说明

| | read-only | workspace-write |
|---|---|---|
| 读工作区内文件 | ✅ | ✅ |
| 读工作区外文件 | ✅（敏感路径除外） | ✅（敏感路径除外） |
| 写工作区内文件 | ❌ | ✅ |
| 写工作区外文件 | ❌ | ❌（需审批） |
| bash 运行命令 | ✅（不可写真实文件） | ✅（可写工作区 + /tmp） |
| bash 写工作区外 | ❌ | ❌ |
| 危险命令 | 拦截 + 审批 | 拦截 + 审批 |

### 敏感路径（不可读）

`~/.ssh`  `~/.aws`  `~/.gnupg`  `~/.git-credentials`
`~/.npmrc`  `~/.pypirc`  `~/.netrc`  `~/.env`  `~/.env.*`

### 不保护的对象

**用户手动 `!cmd` / `!!cmd` 不受 Guard 保护。** Guard 只保护 Agent 自发调用的工具。

---

## 6. 可选 DCG policy engine（仅 TUI）

Pi Guard 只在 `ctx.mode === "tui"` 工作。print、JSON、RPC 等非 TUI 模式不会初始化 Sandbox、调用 DCG、拦截工具或渲染 UI。

[Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) 是可选的外部 Bash policy engine，不是 Sandbox，也不是 npm 依赖。请自行安装、升级，并在启动 Pi 的环境中验证：

```bash
dcg --version
```

当 DCG 可用时，Pi Guard 自动调用 `dcg --robot test "<command>"`；不在 `PATH` 时可设置 `DCG_BIN=/path/to/dcg`。真正缺少 executable 时会静默回退到 `bashPolicy`；availability check 超时、被 signal 终止或其他异常会显示为 `DCG:error` 并按 `onError` 处理。DCG 子进程有一秒 timeout 和短暂终止宽限，避免可选组件无限卡住；超时、无效 JSON 或启动失败不会对同一命令再运行内置 policy，而是按 `onError` 处理。

DCG 只检查标准 `bash` 工具的 Agent 调用；不会检查 `!cmd`、`!!cmd`、自定义 shell tool，也不会扫描任意 `bash script.sh` 的脚本内容。OS Sandbox 仍是文件系统和网络的硬边界。

## 7. 故障排查

| 状态 | 原因 | 处理 |
|------|------|------|
| `Guard: uninitialized` | 未初始化 | 执行 `/guard i` |
| `Guard: invalid-config` | JSON 格式错误 | 检查 `.pi/pi-guard.json` 语法，修复后 `/reload` |
| `Guard: sandbox-unavailable` | 系统依赖缺失或 npm 未安装 | 执行第 1 节安装步骤，检查 `bwrap`、`socat`、`rg` |

---

## 8. 配置文件 `.pi/pi-guard.json`

`/guard init` 会在项目根目录生成这个文件，你也可以手动编辑（修改后需 `/reload` 生效）。

### 完整示例

```json
{
  "enabled": true,
  "sandbox": { "enabled": true },
  "mode": "workspace-write",
  "network": "open",
  "dcg": {
    "enabled": true,
    "onDeny": "confirm",
    "onIndeterminate": "notify",
    "onError": "notify"
  },

  "sensitiveReadDeny": [
    "~/.ssh",
    "~/.aws",
    "~/.npmrc"
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
      "dd"
    ],
    "requireApproval": [
      "rm-rf",
      "git-reset-hard",
      "git-clean-fd"
    ]
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `enabled` | Guard 总开关的项目启动默认值 |
| `sandbox.enabled` | OS Sandbox 的项目启动默认值 |
| `mode` | `"readonly"` 或 `"workspace-write"`。`/guard r` / `/guard w` 可直接切换 |
| `network` | `"open"`（允许外网）或 `"blocked"`（阻断全部外网）。`/guard non` / `/guard noff` 切换 |
| `dcg.enabled` | DCG binary 可用时自动使用 DCG |
| `dcg.onDeny`、`dcg.onIndeterminate`、`dcg.onError` | 可选 `"allow"`、`"notify"`、`"confirm"`、`"block"`；默认依次为 `confirm`、`notify`、`notify` |
| `sensitiveReadDeny` | 禁止读取的路径，支持 `~` 和 glob。对所有 Agent 读操作生效 |
| `protectedPaths.block` | `write` / `edit` 直接拒绝的路径 |
| `protectedPaths.approval` | `write` / `edit` 弹审批的路径 |
| `bashPolicy.directBlock` | bash 直接拒绝的命令 |
| `bashPolicy.requireApproval` | bash 需审批的命令 |

### 添加你自己的敏感路径

```json
"sensitiveReadDeny": [
  "~/.ssh",
  "~/.aws",
  "~/my-project/secrets.yml"
]
```

### 添加你要拦截的危险命令

```json
"bashPolicy": {
  "directBlock": [
    "sudo",
    "docker-host-root-bind"
  ],
  "requireApproval": [
    "rm-rf",
    "bash-c"
  ]
}
```

> `bashPolicy` 里的是**策略 ID**，不是正则。完整可用的 ID 列表见 `init` 生成的默认配置。

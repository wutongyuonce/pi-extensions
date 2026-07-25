# pi-weixinbot

微信机器人 extension for pi，支持扫码登录和消息收发。

参考项目：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)

## 功能特性

- 🔐 **扫码登录** - 使用微信扫码授权，无需手动输入 token
- 💬 **消息接收** - 自动接收微信消息并转发给 AI 处理
- 📤 **消息发送** - AI 回复自动发送回微信
- 👤 **多账户支持** - 支持管理多个微信账户
- 🔄 **缓存恢复** - 重启后执行 /weixin-login 即可从缓存快速恢复，无需重复扫码
- 🔒 **排他锁** - 同一时间只有一个 pi session 可以连接微信，防止消息重复处理
- 🛡️ **异常恢复** - 自动检测并抢占已崩溃 session 的失效锁

## 安装

### 方式一：通过 pi install 安装（推荐）

```bash
# 从 npm 安装（如果已发布）
pi install npm:pi-weixinbot

# 从 GitHub 安装
pi install git:github.com/huang-x-h/pi-weixinbot
```

### 方式二：手动安装到扩展目录

1. 克隆仓库到本地：
```bash
git clone https://github.com/huang-x-h/pi-weixinbot.git
```

2. 安装依赖：
```bash
cd pi-weixinbot
npm install
```

3. 将扩展链接到 pi 扩展目录：
```bash
# 全局安装（所有项目可用）
ln -s $(pwd) ~/.pi/agent/extensions/pi-weixinbot

# 或项目本地安装（仅当前项目可用）
mkdir -p .pi/extensions
ln -s $(pwd) .pi/extensions/pi-weixinbot
```

4. 重新加载 pi 以识别扩展：
```
/reload
```

### 方式三：临时测试（不安装）

```bash
# 克隆并进入目录
git clone https://github.com/huang-x-h/pi-weixinbot.git
cd pi-weixinbot
npm install

# 临时加载扩展进行测试
pi -e ./src/weixin.ts
```

### 方式四：通过 settings.json 配置

在 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目本地）中添加：

```json
{
  "packages": [
    "git:github.com/huang-x-h/pi-weixinbot"
  ]
}
```

## 使用方法

### 1. 登录微信

启动 pi 后**不会自动连接微信**，需要手动执行登录命令：

**命令方式：**
```
/weixin-login
```

**或工具方式：**
```
使用 weixin_login 工具登录微信
```

登录逻辑：
1. **优先检查缓存**：如果已有保存的 token，直接加载并连接（无需扫码）
2. **无缓存时扫码**：系统显示二维码 → 微信扫描 → 手机确认 → 连接成功

> 💡 **提示**：首次登录需要扫码，后续重启后执行 `/weixin-login` 即可从缓存快速恢复。

### 2. 接收和发送消息

当收到微信消息时，消息会自动转发给 AI 处理，AI 的回复会自动发送回微信。

也可以手动发送消息：

```
使用 weixin_send 工具发送消息
参数：text="你好，这是一条测试消息"
```

### 3. 查看状态

```
/weixin-status
```

或：

```
使用 weixin_status 工具
```

### 4. 退出登录

```
使用 weixin_logout 工具
```

## 工具列表

| 工具名 | 说明 | 参数 |
|--------|------|------|
| 工具名 | 说明 | 参数 |
|--------|------|------|
| `weixin_login` | 登录微信（优先缓存，无缓存则扫码） | 无 |
| `weixin_logout` | 退出微信登录并释放锁 | `accountId` (可选) |
| `weixin_send` | 发送文本消息给微信用户 | `text`, `to` (可选) |
| `weixin_status` | 查看连接状态和锁状态 | 无 |
| `weixin_force_unlock` | ⚠️ 强制释放 session 锁（会中断其他 session） | 无 |

## 命令列表

| 命令 | 说明 |
|------|------|
| `/weixin-login` | 扫码登录微信 |
| `/weixin-status` | 查看连接状态 |

## 工作原理

本 extension 参考了 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 项目，实现以下功能：

1. **扫码登录**：通过微信开放平台的 ilink API 获取二维码并轮询登录状态
2. **消息接收**：使用长轮询（long-polling）方式从微信服务器获取新消息
3. **消息发送**：通过 sendMessage API 发送文本消息到微信

### API 端点

- 二维码获取: `GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode`
- 登录状态: `GET https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status`
- 消息获取: `POST https://ilinkai.weixin.qq.com/ilink/bot/getupdates`
- 消息发送: `POST https://ilinkai.weixin.qq.com/ilink/bot/sendmessage`

## 数据存储

登录信息存储在 pi 数据目录：

- 全局安装：`~/.pi/agent/weixin/`
- 项目本地：`.pi/weixin/`

```
~/.pi/agent/weixin/
├── accounts.json      # 账户索引
├── accounts/          # 各账户数据
│   ├── xxx.json       # 具体账户信息（token 等）
├── config.json        # 全局配置（最后登录的账户）
└── session.lock       # 当前持有锁的 session 信息（PID、心跳时间等）
```

## 扩展结构

```
pi-weixinbot/
├── package.json       # 包含 pi 配置入口
├── src/
│   └── weixin.ts      # 扩展主入口
└── README.md
```

`package.json` 中的 `pi.extensions` 定义了扩展入口文件：

```json
{
  "pi": {
    "extensions": ["./src/weixin.ts"]
  }
}
```

## 注意事项

1. **安全提示**：存储的 token 文件权限为 600，请确保系统安全
2. **会话过期**：微信登录会话可能过期，如果出现错误请重新登录
3. **多 session 限制**：同一时间只有一个 pi session 可以连接微信，切换 session 需先在前一个 session 执行 `/weixin-login` 或等待其关闭
4. **锁自动释放**：session 正常关闭时会自动释放锁；异常崩溃时，其他 session 可在 30 秒后自动抢占
5. **强制释放锁**：如果锁被已不存在的进程持有，可使用 `weixin_force_unlock` 工具强制释放（谨慎使用）
6. **pi 版本要求**：需要 pi 支持扩展功能的版本

## 故障排除

### 扩展未加载

- 确认扩展已正确安装到 `~/.pi/agent/extensions/` 或 `.pi/extensions/`
- 运行 `/reload` 命令重新加载扩展
- 检查 pi 启动日志中的加载错误信息

### 登录失败

- 检查网络连接
- 确认微信账号状态正常
- 尝试重新生成二维码（重新执行 `/weixin-login`）

### 消息接收不到

- 检查是否已登录成功（运行 `/weixin-status`）
- 确认 pi 正在运行中
- 查看 pi 日志中的错误信息

### Session 过期

- 使用 `/weixin-login` 重新登录（有缓存时会自动加载，无需重复扫码）

### 提示"微信已被其他 session 占用"

- 检查是否有其他 pi 窗口/终端正在运行
- 在其他 session 中执行登出或关闭该 session
- 如果确认无其他 session 在运行，可使用 `weixin_force_unlock` 工具强制释放锁

## License

MIT

# DCG-only 默认模式改造记录

## 当前决定

Pi Guard 的默认 Bash 保护改为纯 DCG 模式：

- Bash 命令交给 DCG 判断；
- DCG 允许就继续执行；
- DCG 拒绝就按配置确认或拦截；
- DCG 缺失时直接拦截，并提示安装；
- DCG 出错时不回退到 Pi Guard 的内置 Bash 规则。

Pi Guard 的 Workspace Sandbox 保留为后续可选模式。它不属于默认 DCG-only 链路。

## 本次已完成

- 使用真实 DCG 二进制验证 macOS arm64 调用；
- 增加真实 DCG 集成测试；
- 增加 DCG 缺失状态和安装提示；
- 增加 `/guard dcg` 与 `/guard sandbox` 两个模式命令；
- 更新命令补全；
- 更新中英文安装和使用说明；
- 说明 Pi 只使用 DCG 时不需要执行 `dcg install`，只需安装 DCG 二进制。

## 后续修复项

以下问题已确认，但本次提交暂不处理：

1. 默认配置仍将 Sandbox 标记为开启。需要改为真正的 DCG-only 默认状态。
2. 旧测试会受本机是否安装 DCG 影响。需要让测试显式注入 mock，避免依赖开发机环境。
3. 两个 macOS 路径测试存在 `/var` 与 `/private/var` 符号链接差异。需要统一路径规范或调整断言。
4. Workspace Sandbox 的 macOS 真实端到端测试尚未完成。
5. 真实 Pi TUI 的交互验证尚未完成。

## 当前验证结果

在 macOS 15.7.9 arm64 上，Homebrew 安装的 DCG 0.14.0 可以运行：

- `ls`、`git status`、`npm test` 等普通命令允许；
- `git reset --hard`、`rm -rf src`、`curl | sh`、设备级 `dd` 被拒绝；
- `dcg --robot test` 的允许退出码为 `0`，拒绝退出码为 `1`。

完整测试当前为 `50 passed, 3 failed`。这 3 个失败属于上述待修复问题。

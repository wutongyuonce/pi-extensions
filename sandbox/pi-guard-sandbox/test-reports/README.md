# Pi Guard v0.1 测试文档索引

`test-reports/` 目录下有三份文件，记录了 v0.1 的测试过程和结果。

---

## 1. `Pi Guard v0.1 真实环境测试清单.md`

**用途**：给 AI agent 逐条执行的测试清单，覆盖 readonly 和 workspace-write 两种模式。

**当前状态**：✅ 全部通过。两轮真实测试已验证：
- readonly：bash 基础命令正常、写真实文件全部被拒、临时目录可写、文件工具拒绝 write/edit、敏感读取被拦截
- workspace-write：工作区内读写正常、工作区外写入被拒、Guard 配置受保护、dangerous command 拦截正常
- 所有 side-effect 检查通过，未再产生垃圾文件

**是否过时**：未过时，可直接复用。

---

## 2. `Pi Guard 红队突破测试提示词.md`

**用途**：给 AI agent 的红队提示词，引导它尝试突破 Guard 限制。

**当前状态**：已执行。可直接复用。

---

## 3. `Pi Guard 红队测试报告.md`

**用途**：红队测试的执行结果报告。发现了三个 bypass。

**发现汇总**：

| # | 问题 | 严重度 | 处理结果 |
|---|------|--------|----------|
| 1 | 命令模式匹配绕过（base64/变量拼接） | 低 | **未修复**。被 OS sandbox 兜底，实际危害有限。v0.2 考虑。 |
| 2 | bash 绕过 protected paths（python 直接写 .env/.git/） | 中 | **未修复**。设计文档已声明"protected paths 只作用于 write/edit"，属于 v0.1 已知边界。v0.2 考虑在 sandbox denyWrite 层补。 |
| 3 | bash 绕过 sensitive read deny（python 读 ~/.npmrc 等） | 中 | **✅ 已修复**。commit `7f37fb1`：在 bwrap 命令中注入 `--tmpfs` / `--ro-bind /dev/null` 遮蔽敏感路径。 |

**注意**：报告原文中关于 #3 的结论（"python 可读取敏感文件"）已不再成立。阅读报告时请知悉 #3 已修复。

---

**最后更新**：2026-04-30

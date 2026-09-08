# 看懂 @narumiruna 一组 Pi 扩展

这组文档面向第一次接触这些扩展的人：读完应能讲出「它解决什么问题、怎么活在 Pi 进程里、一条真实输入怎么流、改哪里能深入」。

npm 作用域是 `@narumitw`，本仓库目录是 `@narumiruna/`。正文以当前源码为准；命令参数、UI 文案和版本号易变，稳定认知放在职责边界、运行形态和数据流上。

同目录下另有 [`docs/@narumitw/`](../@narumitw/README.md) 源码地图系列，颗粒度更偏文件行段，且部分文档可能落后于当前大版本（尤其是 `pi-subagents` v3）。要先建立全局心智，读本系列。

## 共同前提

七个包都是 **Pi 扩展**，不是独立 CLI、也不是常驻服务：

```text
pi install npm:@narumitw/<包名>
→ package.json 的 pi.extensions 指向 dist/index.ts
→ 宿主 Pi 进程加载默认导出的初始化函数
→ 注册 command / tool / 生命周期监听
→ 随 Pi 会话启动和关闭
```

`src/index.ts` 几乎都是一行转发。真正入口是各包的同名文件（`goal.ts`、`plan-mode.ts`、`subagents.ts` 等）。Pi 加载的是构建产物 `dist/`（Jiti 入口，由各包 `scripts/build-runtime.mjs` 从 `src/index.ts` 打出），不要把 `src/` 当成运行时入口。本仓库作为源码归档时，工作树里可能没有 `dist/`——要实际装进 Pi，先在该包里 build。

| 文档 | 它解决什么 | 会不会拉起额外进程 |
|---|---|---|
| [看懂 pi-goal](./看懂-pi-goal.md) | 给当前会话一个目标，在宿主真正空闲后再续跑 | 否（只有进程内定时器） |
| [看懂 pi-plan-mode](./看懂-pi-plan-mode.md) | 先只读规划、批准后再改代码 | 否 |
| [看懂 pi-subagents](./看懂-pi-subagents.md) | 把任务丢给隔离的子 Pi 进程 | 是：子 Pi + 本机 TCP broker |
| [看懂 pi-todo](./看懂-pi-todo.md) | 把多步工作钉在编辑器上方 | 否 |
| [看懂 pi-lsp](./看懂-pi-lsp.md) | 按需跑 LSP 诊断和修复 | 是：每次工具调用拉起语言服务器，用完即关 |
| [看懂 pi-chrome-devtools](./看懂-pi-chrome-devtools.md) | 用 CDP 检查和控制浏览器 | 可选：本扩展启动的 Chromium |
| [看懂 pi-chat](./看懂-pi-chat.md) | 不进模型上下文的点对点聊天 | 是：Hyperswarm / DHT 网络 I/O |

## 阅读顺序建议

1. 先读 [pi-todo](./看懂-pi-todo.md)：最小扩展长什么样（一个工具 + 一个 widget + session 恢复）。
2. 再读 [pi-lsp](./看懂-pi-lsp.md) 或 [pi-chrome-devtools](./看懂-pi-chrome-devtools.md)：看「工具调用如何短暂拥有外部进程」。
3. 然后读 [pi-plan-mode](./看懂-pi-plan-mode.md) 和 [pi-goal](./看懂-pi-goal.md)：同一类工作流状态机，一个管「先规划」，一个管「接着干」。
4. [pi-subagents](./看懂-pi-subagents.md) 是进程隔离的委托模型，不要和 goal/plan 的「同一会话续跑」混在一起。
5. [pi-chat](./看懂-pi-chat.md) 几乎不参与模型循环，适合最后用来对照「扩展也可以完全不给模型工具」。

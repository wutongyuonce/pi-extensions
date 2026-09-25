# 看懂 pi-transcribe：快捷键听写进编辑器，工具转录进上下文

> 本文面向第一次接触 `pi-transcribe`、但已经知道「Pi 是终端里的编码 Agent」的读者。重点不是罗列模型名，而是讲清：语音从哪进、在哪个进程里变成字、听写和 `transcribe_file` 为什么要抢同一把模型锁、没装 FFmpeg 时听写为什么还能用。
>
> **本文定位：小项目、二次开发深度。** 稳定认知放在职责边界、队列与内存上限上；快捷键默认值、目录里的具体模型、提示文案属于易变细节。包版本仍是 `0.0.1`，模型目录会变，但「本地推理、单模型、听写优先」这条主线应当稳住。
>
> 源码基线：本仓库 `pi-transcribe`，包 `@earendil-works/pi-transcribe` 版本 `0.0.1`；工作区 HEAD `6f1c21c`（2026-09-08），该目录最近一次提交 `262c13e`（2026-09-03）。上游：[earendil-works/pi-transcribe](https://github.com/earendil-works/pi-transcribe)。本地引擎：[transcribe-cpp](https://www.npmjs.com/package/transcribe-cpp)。

## 1. TLDR：它做的事情可以压缩成两条链路

一条给人用，一条给模型用，共用**同一个已加载的本地模型**。

```text
快捷键听写（人 → 编辑器）
  按快捷键 → 麦克风 PCM → （能流式就边录边喂）→ 本地模型出字
  → pasteToEditor 插到光标处。不自动发送。

文件转录（Agent → 上下文）
  模型调 transcribe_file → FFmpeg 解出 PCM → 同一把模型锁排队
  → 文本进工具结果；超长则截断并把全文另存临时文件
```

所以它不是：

- **不是** 系统级全局热键。快捷键是 Pi 终端绑定，Pi 没焦点时按了不会录。
- **不是** 云端 ASR。模型文件在本机 Hugging Face 缓存里，推理走 `transcribe-cpp` 原生绑定。
- **不是** 常驻语音 daemon。扩展跟着 Pi 进程；会话关了就 `shutdown`。
- **不是** 自动把听写内容发给模型。插入编辑器之后，发不发由用户决定。

正面定义：它是挂在 Pi TUI 上的 **本地语音输入通道**，外加一个让 Agent 转录本地音视频的工具。

权威数据源：

- **配置权威**：`getAgentDir()/pi-transcribe.json`（通常是 `~/.pi/agent/pi-transcribe.json`）。没这个文件，工具会拒绝工作，听写会先走 onboarding。
- **模型字节权威**：Hugging Face 缓存里、目录登记过的那份文件；设置里的 `model.path` 必须还能对上大小。
- **转录文本**是派生结果，不写进配置。

## 2. 为什么不能「让模型去调云端语音 API」

编码 Agent 的输入框是键盘。听写要解决的是：手不离开终端、话筒一开一关、字出现在光标处。如果走云端，会多出网络、密钥、隐私三条线；这个包选择把推理留在进程内。

正反例：

| 该走 pi-transcribe | 不该走它 |
|---|---|
| 对着 Pi 说需求，字进编辑器 | 想在 Slack / 浏览器里全局听写 |
| Agent 要读一段本地会议录音 / 视频音轨 | 想做实时字幕流、说话人分离 |
| 机器没网也能用已下载的模型 | 还没在 TUI 里选过模型，却指望 headless 里直接 `transcribe_file` |

职责分工：

- **人**决定何时按快捷键、何时 Esc 丢弃、听写结果发不发送。
- **扩展**管采集、队列、模型加载、把字贴进编辑器或工具结果。
- **transcribe-cpp** 管本地推理；扩展不自己实现声学模型。
- **FFmpeg** 只为文件解码服务。麦克风听写不经过它。

不要把「本地模型」理解成「扩展自带一份 gguf」。模型要用户在 `/transcribe` 里选过、确认后下载；目录（`catalog/`）只是清单。

## 3. 先看整体架构，不急着看类名

文档视角：

```text
接入层     快捷键 / /transcribe / transcribe_file 工具 / 调试用 onboarding
   ↓
运行时层   懒加载；听写互斥；设置菜单；关机回收
   ↓
队列层     同一时刻一把模型锁；听写优先于文件任务
   ↓
采集/解码  麦克风（pvrecorder）或 FFmpeg（文件）
   ↓
推理层     transcribe-cpp：能流式就流，否则整段 PCM 再跑
   ↓
输出层     听写 → 编辑器；文件 → 工具文本（可截断）
```

进程真相：这六层都在 **Pi 宿主进程**里（外加一块原生 addon）。没有转录服务器。

| 节点 | 载体 | 触发 |
|---|---|---|
| 快捷键 handler | Pi 进程，扩展回调 | 终端按键，Pi 要有焦点 |
| 麦克风 | 同进程，pvrecorder 原生 | 第一次按快捷键 |
| FFmpeg | **子进程**，一次一个 | `transcribe_file` |
| 模型 | 同进程，transcribe-cpp 绑定 | 队列调度到空闲时加载 |
| 设置文件 | 磁盘 JSON | `/transcribe` 选模型时写入 |

图纸与进程的差异：文档会说「TranscriptionService」。它是代码职责，不是监听端口的服务。每次 Pi 启动，入口先只注册快捷键和工具；真正的 runtime 在**第一次使用**时才 `import("./runtime.js")`。这是有意的：Pi 会 await 扩展模块求值，入口必须保持「只注册」。

## 4. 实际怎样运行：寄生在 Pi 里，第一次用才加载

安装产物：

- `package.json` 的 `pi.extensions` 指向 `./src/index.ts`（源码直接给 Pi 跑，没有单独 `dist` 发布物作为扩展入口）。
- 依赖里有 `@picovoice/pvrecorder-node`（麦）和 `transcribe-cpp`（推理）。
- 没有 `bin`。你不能 `pi-transcribe start`。

跑起来是什么：

```text
pi install .../pi-transcribe
  → Pi 加载 src/index.ts
  → 注册快捷键、/transcribe、transcribe_file
  → 此时模型尚未加载，麦尚未打开
  → 第一次按快捷键或调工具 → 创建 runtime + TranscriptionService
```

有没有常驻进程：**没有第二进程。** 模型加载后会留在 Pi 进程里，直到队列空闲就 `unloadModel`，或 `session_shutdown` 时整段拆掉。崩溃语义跟 Pi 本身走：Pi 没了，麦和模型一起没。

懒加载细节值得讲实：第一次按快捷键，handler 还在 `await import` 时就会先画一行 `Starting microphone…`，避免「按了没反应」。后续按键走已经 memoize 的 runtime。

和宿主的关系：

```text
Pi 宿主进程
  ├─ TUI 编辑器（pasteToEditor 的目标）
  ├─ 扩展入口（永远很轻）
  ├─ runtime（第一次用才有）
  ├─ 原生录音 / 原生模型
  └─ 偶发的 ffmpeg 子进程（仅文件任务）
```

调试：`PI_TRANSCRIBE_DEBUG=1` 才会注册 `/transcribe-onboarding`。普通安装看不见这条命令。取消 onboarding 且还没选模型 → 配置不变；一旦选了模型，写入是立刻发生的。

## 5. 纵向链路一：按一下快捷键，字出现在光标处

```text
快捷键 → 确认配置 → 打开麦 → 边录边喂（或录完再跑）→ 贴进编辑器
```

### 5.1 接入层：收到按键 → 决定开始还是停止 → 产出一次 toggle

载体：Pi 进程快捷键回调。默认 `Ctrl+Alt+Z`，可在 `/transcribe` 改。这是终端 binding，不是 OS 热键。第二次按是 stop；录制中 `Esc` 是丢弃，不走模型。

同一时刻只允许一个听写操作（`runExclusive`）。设置菜单打开时不能录；录着时不能开设置。

### 5.2 配置层：收到「要录了」→ 读 JSON / 必要时 onboarding → 产出带模型路径的 settings

没有合法设置就进 TUI 选择。`/transcribe` 和首次听写共用这条路。headless / 非 TUI 模式会直接告诉你「configuration requires the interactive TUI」——所以 CI 里没法靠这个包「自动下一份模型」。

模型下载走 Hugging Face 官方缓存布局（`blobs/` + `snapshots/<revision>/`）。目录里的 `size` 必须和远端一致，否则拒绝。`HF_TOKEN` 可选。

### 5.3 采集层：收到 start → pvrecorder 出 Int16 帧 → 聚成约 500 ms 的 Float32 PCM

16 kHz 单声道。`PcmChunker` 不用定时器，靠样本数凑块（`CAPTURE_SAMPLE_RATE / 2` = 8000 samples ≈ 500 ms）。TUI 上方有电平条；那是人看的，不是模型输入的权威。

macOS 没麦克风权限时，采集会失败，扩展会尝试提供权限帮助，而不是假装录到了静音。

### 5.4 预约层：收到「开始录」→ 向服务占住模型通道 → 产出一条 dictation reservation

这里是队列设计的关键：**模型工作不可抢占**。但调度边界上，已提交的听写和正在录的 reservation，永远排在文件任务前面。正在录音等于占着模型车道，直到 submit 或 cancel。

所以：Agent 正在 `transcribe_file` 一个 30 分钟视频时，你按快捷键，不会把文件任务杀掉；文件任务结束后听写先跑。反之，听写进行中，新的文件任务只能排队。

### 5.5 推理层：PCM 进模型 → 文本出模型

能流式的模型：录音过程中就把 500 ms 块 `feed` 进去，stop 时 `finalize`。不能流式的：把整段 PCM 留下，stop 之后一次性跑。流式中途失败会 reset，再尝试整段 fallback。

中文会在收尾做简繁转换（`opencc-js`），依据设置里的 `chineseOutput`，而且只在检测/配置语言是中文时动手。不要把这个理解成「翻译」。

### 5.6 输出层：收到文本 → `ctx.ui.pasteToEditor(text)` → 光标处多了一段字

空文本会提示 No speech detected，不贴。贴进去 ≠ 发送给模型。用户还要自己回车。

**完成 ≠ 模型已经看到这句话。** 完成只证明编辑器缓冲区变了。

## 6. 纵向链路二：Agent 调用 `transcribe_file`

```text
工具参数 → 限流（最多 2 个文件操作）→ FFmpeg 解 PCM（同时只 1 个解码器，128 MiB 封顶）
  → 同一模型队列（听写优先）→ 文本回上下文（过长截断）
```

### 6.1 工具层：收到路径 → 规范化 → 产出一次文件任务

没有配置好的模型，工具直接失败，并让 Agent 去请用户跑 `/transcribe`。不要在工具里偷偷下载模型——下载是 TUI 确认过的动作。

### 6.2 解码层：收到本地文件 → spawn ffmpeg → 产出 Float32 PCM

FFmpeg 可执行文件来自 `PATH` 或 `PI_TRANSCRIBE_FFMPEG_PATH`。参数白名单只允许 `file,pipe`，解第一条音轨，16 kHz 单声道 `f32le`。

解码上限 **128 MiB** 解码后 PCM（大约 35 分钟）。超了就失败，而不是默默截断音频让模型「听一半」。同时只跑 **1** 个 ffmpeg；文件操作准入最多 **2** 个——这是内存边界，不是性能调优口号。

麦克风听写**不需要** FFmpeg。缺 ffmpeg 时，听写仍可用；只有这条链路会报安装说明，并且提示 Agent：**先问用户再跑包管理器**。

### 6.3 排队层：PCM 进 fileQueue → 等模型锁 → 产出文本

和听写共用 `TranscriptionService`。队列空了会卸载模型，避免一份大模型永远占着 RSS。

### 6.4 回传层：文本可能超过 Pi 工具输出上限 → 截断 + 全文落到临时文件

截断用宿主的 `truncateHead`。Agent 看到的是头，完整稿在 `fullTranscriptPath`。**工具返回成功 ≠ Agent 看见了全文。**

关机：`session_shutdown` 会 abort 进行中的文件任务、停麦、卸模型。入口上的 `shuttingDown` 标志会让后续 `loadRuntime()` 直接拒绝，避免关一半又被快捷键拉起来。

## 7. 边界、误区

| 词 | 是 | 不是 |
|---|---|---|
| 快捷键 | Pi TUI 绑定 | 全局 OS hotkey |
| 本地模型 | 用户选过、下到 HF 缓存的文件 | 扩展 npm 包自带的权重 |
| TranscriptionService | 进程内调度器 | HTTP 转录服务 |
| 流式 | 边录边 feed 的模型能力 | 把字实时打进编辑器（编辑器只在 stop 后贴一次） |
| FFmpeg | 文件解码器 | 听写依赖 |
| pasteToEditor | 改编辑器缓冲 | 向模型提交用户消息 |

常见误区：

- **错。** 以为没装 FFmpeg 就不能用。**正。** 只有 `transcribe_file` 需要它。
- **错。** 以为快捷键在 Pi 放到后台时仍能录。**正。** 终端没焦点就没绑定。
- **错。** 以为可以并行跑两个模型。**正。** 一把锁，听写优先，不可抢占。
- **错。** 以为 onboarding 取消也会改配置。**正。** 没选模型就不动文件；选了就立刻写。
- **错。** 以为文件任务返回了，Agent 就拿到全文。**正。** 超长会截断，全文在临时文件。

## 8. 失败时先查哪条链路

**按了快捷键没电平条。** 先确认 Pi 有焦点、快捷键没被改掉、没有别的 transcribe 操作在跑。不要先重下模型。

**有电平条，stop 后 No speech / 空文本。** 采集成功、模型跑过。查语言设置、麦克风是不是系统默认那只、是不是太短。

**macOS 一录就失败。** 权限，不是模型。跟扩展走权限帮助。

**`transcribe_file` 报 FFmpeg。** 只说明文件链路缺解码器。听写应仍可用。Agent 应询问再安装。

**`transcribe_file` 报模型未配置。** 去 TUI 跑 `/transcribe`。不要在无头环境里指望工具自己弹出选择器。

**听写卡住，文件任务也排队。** 模型锁被 reservation 占着。Esc 取消录音，或等 stop 结束。不要开第二个 Pi 实例抢同一只麦——那是 OS 设备问题，不是这个队列能解决的。

**解码到一半失败、提示太大。** 碰到 128 MiB PCM 顶。缩短文件或先在壳里切音频，而不是调大某个「超时」。

## 9. 如果只记一条主线

稳定事实：

1. 形态是 **Pi 扩展**，入口只注册，runtime 懒加载；没有转录服务器。
2. 两条链路共用 **一个已加载模型**；听写优先，模型工作不可抢占。
3. 听写写入 **编辑器**，不自动发送；文件转录写入 **工具结果**。
4. FFmpeg 只服务文件链路；内存边界是 2 个文件操作 / 1 个解码器 / 128 MiB PCM。
5. 配置权威在 `pi-transcribe.json`，模型字节在 HF 缓存；两者对不上就当没配好。

```text
按快捷键（人）或 transcribe_file（模型）
  → 懒加载 runtime
  → 抢同一把本地模型锁（听写优先）
  → 字进编辑器 或 字进工具结果
  → 会话结束即卸模型、关麦
```

## 10. 想改代码时按这个顺序读

1. `src/index.ts`：为什么入口必须「只注册」、shutdown 如何挡住二次 load。
2. `src/runtime.ts`：toggle / 互斥 / pasteToEditor / Esc 丢弃。看了能懂听写生命周期。
3. `src/transcription-service.ts`：dictation vs file 两队列、不可抢占、空闲卸载。这是调度合同。
4. `src/transcription.ts`：transcribe-cpp 的流式与整段两条路径、中文收尾。
5. `src/file-transcription.ts` + `src/file-audio.ts`：工具合同、2/1/128MiB、FFmpeg 参数。
6. `src/settings.ts` + `src/onboarding.ts`：JSON 权威位置、选模型何时落盘。
7. `src/models.ts`：HF 缓存布局、size 校验。
8. `src/pcm-chunker.ts` + `src/audio-constants.ts`：500 ms 从哪来。
9. `src/shortcuts.ts` / `src/startup-shortcut.ts`：启动时读快捷键，避免 runtime 没起来就丢绑定。

本地冒烟：`npm install --ignore-scripts`，然后 `pi -e /abs/path/to/pi-transcribe`。交互式跑一次 `/transcribe` 选模型，按快捷键录一句，看编辑器；再让模型对一个短 wav 调 `transcribe_file`。

## 参考资料

- [pi-transcribe README](https://github.com/earendil-works/pi-transcribe)
- [transcribe-cpp](https://www.npmjs.com/package/transcribe-cpp)
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

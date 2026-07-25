# pi-statusline：事件采集与纯渲染分离的页脚扩展

## 主线

Pi lifecycle/tool/session 事件不断更新一个轻量状态快照；Git 查询被缓存并在渲染之外异步完成；footer render 时只读取快照和设置，把 segments 分行、着色、截断并输出 TUI 行。这样窄终端、频繁重绘和慢 Git 都不会阻塞输入。

| 文件（行） | 定位与逐段职责 | 关键函数/阅读锚点 |
| --- | --- | --- |
| `src/statusline.ts:1-292` | composition root 与生命周期控制：安装 footer、监听 session/tool/model 变化、调度 Git 刷新、清理订阅。 | default initializer、refresh scheduling |
| `src/render.ts:1-301` | 将状态和有效设置渲染为 powerline 行；处理 segment text、宽度、省略、颜色块和扩展状态换行。 | render entry、segment formatters |
| `src/settings.ts:1-573` | 默认配置、schema/语义验证、完整默认文件首次原子创建、legacy 迁移、编辑后的立即生效。 | settings loader/validator/save |
| `src/git-status.ts:1-125` | 只负责一次 Git/PR 状态快照；不要在 `render()` 内执行。 | repository status reader |
| `src/extension-status.ts:1-297` | 汇总其他扩展发布的状态，解析包别名到 icon，并安全包裹窄屏文本。 | status normalization/icon matching |
| `src/commands.ts:1-118` | `/statusline settings|status|help`；TUI 编辑失败不覆盖上次有效配置。 | command handler |
| `src/tokyo-night.ts:1-180` | palette tokens 与 separator 颜色规则；表现层常量，不含业务状态。 | palette resolver |
| `src/ansi.ts:1-26`、`src/types.ts:1-67` | 最小 ANSI 工具和跨模块类型合同。 | escaping/types |
| `test/renderer.test.ts`、`test/settings.test.ts`、`test/statusline.test.ts` | 分别锁定纯渲染、配置合法性和事件生命周期。 | 重点看窄宽度、legacy、stale Git。 |

## 从零实现

先写一个纯 `render(snapshot, width, config)` 并以字符串数组测试；再写事件层，让事件只更新 snapshot 并 `invalidate`。第三步接 Git 的防抖/版本戳；第四步做设置编辑。不能倒过来：直接在 footer callback 读取文件、执行 Git 或 fetch，会造成 UI 卡顿和过期结果覆盖新 session。

## 关键设计决策

- `segments` 是顺序化数据，而不是格式字符串：它能校验重复、处理 `line_break`，并保留渲染所有权。
- settings 既要“宽容读取”（缺字段用默认值），也要“严格写入”（控制字符、连续换行、重复数据段拒绝）。
- Git 异步结果需带 session/cwd 身份检查；否则从旧目录返回的结果会显示到新目录。

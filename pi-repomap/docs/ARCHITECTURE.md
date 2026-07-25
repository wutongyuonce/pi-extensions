# pi-scope 项目架构与双实现说明

## 1. 项目概览

**pi-scope** 是一个面向 AI 编码代理的代码库感知 CLI 工具。它通过 Tree-sitter 解析源码 AST，提取函数、类、方法等符号，再结合跨文件引用信号计算重要性，帮助 AI 或开发者快速理解陌生代码库。

当前仓库已经演进为**双实现结构**：

- **Python 实现**：原始主实现，负责核心产品逻辑定义与行为基线
- **TypeScript 实现**：并排迁移版本，保持相同的架构分层、CLI 模式和主要算法

项目的核心价值没有变化：

1. 用一条命令替代 3 到 4 条 bash 链式探索命令
2. 输出 bash 很难直接算出来的“跨文件重要性排名”
3. 为 AI Agent 提供更适合放进上下文的结构化摘要

---

## 2. 当前技术栈

### 2.1 Python 版本

- Python 3.11+
- `tree-sitter`
- `tree-sitter-language-pack`
- `uv`
- `hatchling`
- `pytest`

### 2.2 TypeScript 版本

- Node.js 20+
- TypeScript 5.x
- `commander`
- `execa`
- `tree-sitter`
- `tree-sitter-python`
- `tree-sitter-javascript`
- `tree-sitter-typescript`
- `tree-sitter-go`
- `tree-sitter-rust`
- `@iarna/toml`
- `vitest`
- `tsup`
- `tsx`

### 2.3 为什么保留双实现

- Python 版是当前稳定行为基线
- TypeScript 版用于在 Node.js/前端生态中分发与集成
- 双实现配合兼容性对照测试，方便迁移时持续验证行为一致性

---

## 3. 目录结构

```text
pi-scope/
├── pyproject.toml                  # Python 包配置与入口
├── package.json                    # TypeScript 包配置、脚本与依赖
├── src/scope/                      # Python 实现
│   ├── __init__.py                 # Python CLI 主入口
│   ├── __main__.py                 # python -m scope 入口
│   ├── models.py                   # Python 数据模型
│   ├── engine/
│   │   ├── discover.py
│   │   ├── symbols.py
│   │   ├── references.py
│   │   ├── rank.py
│   │   ├── frameworks.py
│   │   ├── cache.py
│   │   ├── git.py
│   │   └── _utils.py
│   └── modes/
│       ├── map.py
│       ├── overview.py
│       └── pairs.py
├── tests/                          # Python 单元测试
│   ├── test_discover.py
│   ├── test_rank.py
│   ├── test_references.py
│   └── test_cache.py
├── ts-src/                         # TypeScript 实现
│   ├── index.ts                    # TypeScript CLI 主入口
│   ├── models.ts                   # TS 数据模型
│   ├── compat/
│   │   └── compare.ts              # Python/TS 对照逻辑
│   ├── engine/
│   │   ├── discover.ts
│   │   ├── symbols.ts
│   │   ├── references.ts
│   │   ├── rank.ts
│   │   ├── frameworks.ts
│   │   ├── cache.ts
│   │   ├── git.ts
│   │   └── utils.ts
│   ├── modes/
│   │   ├── map.ts
│   │   ├── overview.ts
│   │   └── pairs.ts
│   └── scripts/
│       └── compare-python.ts       # 兼容性对照脚本
├── ts-tests/                       # TypeScript 测试与 fixture 仓库
│   ├── cli.test.ts
│   ├── compat.test.ts
│   ├── discover.test.ts
│   ├── frameworks-cache.test.ts
│   ├── references-rank.test.ts
│   ├── symbols.test.ts
│   └── fixtures/
│       ├── mini-python-repo/
│       ├── mini-ts-repo/
│       ├── mini-rust-repo/
│       ├── mini-mixed-repo/
│       └── edge-cases-repo/
└── docs/
    ├── ARCHITECTURE.md
    └── SKILL.md
```

---

## 4. 架构分层

无论是 Python 版还是 TypeScript 版，架构都保持同样的三层：

### 4.1 CLI 编排层

职责：

- 解析命令行参数
- 调用 engine 层完成分析
- 根据 mode 选择渲染器
- 控制错误降级与 JSON/text 输出

对应文件：

- Python：`src/scope/__init__.py`
- TypeScript：`ts-src/index.ts`

### 4.2 engine 核心分析层

职责：

- 文件发现与过滤
- Tree-sitter 符号提取
- import 解析与依赖图构建
- 重要性计算
- 框架检测
- 缓存

对应目录：

- Python：`src/scope/engine/`
- TypeScript：`ts-src/engine/`

### 4.3 modes 输出渲染层

职责：

- 只关心展示，不关心分析细节
- 根据 `map` / `overview` / `pairs` 生成 text 输出
- JSON 输出由 CLI 编排层直接组装

对应目录：

- Python：`src/scope/modes/`
- TypeScript：`ts-src/modes/`

---

## 5. 整体执行流程

`scope` 与 `scope-ts` 的主流程保持一致：

```text
CLI args
  │
  ▼
参数解析
  │
  ▼
discover_files / discoverFiles
  │
  ▼
prioritize_files / prioritizeFiles
  │
  ├── mode == pairs ──→ pair_tests / pairTests ──→ render pairs
  │
  ▼
load_cached_symbols / loadCachedSymbols
  │
  ├── cache hit ──→ all_symbols
  │
  └── cache miss
       │
       ▼
extract_symbols / extractSymbols
       │
       ▼
save_cached_symbols / saveCachedSymbols
       │
       ▼
dependency_graph / dependencyGraph
       │
       ▼
compute_importance / computeImportance
       │
       ▼
detect_frameworks / detectFrameworks
       │
       ▼
suggested_reads / suggestedReads
       │
       ▼
render map / overview
```

---

## 6. 两个版本的实现映射

| 能力 | Python | TypeScript |
|---|---|---|
| CLI 主入口 | `src/scope/__init__.py` | `ts-src/index.ts` |
| 数据模型 | `src/scope/models.py` | `ts-src/models.ts` |
| 文件发现 | `src/scope/engine/discover.py` | `ts-src/engine/discover.ts` |
| 符号提取 | `src/scope/engine/symbols.py` | `ts-src/engine/symbols.ts` |
| 依赖图 | `src/scope/engine/references.py` | `ts-src/engine/references.ts` |
| 排名 | `src/scope/engine/rank.py` | `ts-src/engine/rank.ts` |
| 框架检测 | `src/scope/engine/frameworks.py` | `ts-src/engine/frameworks.ts` |
| 缓存 | `src/scope/engine/cache.py` | `ts-src/engine/cache.ts` |
| git 工具 | `src/scope/engine/git.py` | `ts-src/engine/git.ts` |
| 读取工具 | `src/scope/engine/_utils.py` | `ts-src/engine/utils.ts` |
| map 渲染 | `src/scope/modes/map.py` | `ts-src/modes/map.ts` |
| overview 渲染 | `src/scope/modes/overview.py` | `ts-src/modes/overview.ts` |
| pairs 渲染 | `src/scope/modes/pairs.py` | `ts-src/modes/pairs.ts` |
| 兼容性对照 | 无 | `ts-src/compat/compare.ts` |

---

## 7. 核心模块说明

### 7.1 文件发现

两个版本都采用相同策略：

1. 优先 `git ls-files`
2. 如果失败，再遍历文件系统
3. 过滤 lock/minified/`.d.ts` 等无关文件
4. 保留配置文件与 README
5. 通过统一排序规则，把入口文件和核心源码提前

关键特性：

- 支持 `--scope` 限定子目录
- 支持 `--max-files` 截断大仓库扫描量
- 内建测试文件识别与测试配对
- 语言统计基于扩展名映射

### 7.2 符号提取

共同思路：

- 用 Tree-sitter 构建 AST
- 通过 handler 分发表识别函数、类、方法、接口、结构体等
- 使用作用域栈追踪 `Class.method`
- 跳过过大文件、疑似压缩文件、Python dunder 符号

Python 版特点：

- 借助 `tree-sitter-language-pack` 统一提供多语言 `get_language()`
- 语言装配更简单，支持范围更广

TypeScript 版特点：

- 采用方案 A：按语言单独安装 grammar 包
- 当前首批稳定支持：Python / JavaScript / TypeScript / Go / Rust
- 兼容的 grammar 版本矩阵固定在 `tree-sitter 0.21.x`
- 通过 `symbols.test.ts` 与跨版本 fixture 对照持续验证行为一致性

### 7.3 依赖图构建

两个版本都采用正则 + 启发式路径解析：

- Python：`import X` / `from X import Y`
- JS/TS：`import` / side-effect import / `require()`
- Rust：`use`
- Go：单行 `import` 与 grouped imports

内部依赖解析规则：

- 相对导入尝试从当前文件路径求解
- 点号命名空间尝试映射到目录路径
- 额外尝试 `src/` 前缀

该模块不是编译器级精确解析，而是服务于“仓库导览”这一目标的轻量启发式实现。

### 7.4 重要性计算

两个版本保持一致的评分模型：

- 基础分 = 跨文件引用计数
- class / interface × 1.5
- Terraform `resource/module/data` × 2.0
- 特定入口名加分
- 文件被导入数加分
- 测试文件中的符号惩罚为 0.05

`suggested_reads` 则按文件内 symbol importance 总分排序，输出前 5 个建议阅读文件。

### 7.5 框架检测

共同检测来源：

- `package.json`
- `pyproject.toml`
- `requirements.txt`
- `go.mod`
- `Cargo.toml`
- `.tf/.hcl`

输出内容：

- 框架名
- 疑似入口点
- package scripts

### 7.6 缓存

共同设计：

- 缓存文件名：`scope-cache-v2.json`
- 优先写入 `.git/`
- 否则写入 `XDG_CACHE_HOME` 或用户缓存目录
- 签名基于：

```text
SHA256(git HEAD + file path + mtime_ns + size)
```

缓存命中条件：

- HEAD 未变化
- 文件 mtime/size 未变化
- `scope` 未变化
- `max-files` 未变化

---

## 8. TypeScript 版本的额外说明

### 8.1 为什么 TS 版不能完全复用 Python 的 Tree-sitter 装配

Python 版使用 `tree-sitter-language-pack`，可以通过统一的 `get_language()` 加载多语言 grammar。

TypeScript 版没有同样省心的“一体化语言包”，因此当前采取的是：

- 每种语言单独安装 grammar 包
- 在 `ts-src/engine/symbols.ts` 中维护扩展名到 grammar 的映射
- 固定一组兼容的 `tree-sitter` 与 grammar 版本

这也是 TS 版最主要的工程差异。

### 8.2 为什么需要兼容性对照

TS 版不是独立重新设计，而是“以 Python 版为行为基线”的高保真迁移，因此增加了专门的兼容性层：

- `ts-src/compat/compare.ts`
- `ts-src/scripts/compare-python.ts`
- `ts-tests/compat.test.ts`

这些文件会在固定 fixture 仓库上同时运行 Python 版与 TS 版，再比较三种模式的 JSON 输出是否一致。

---

## 9. CLI 模式

### 9.1 `map`

输出按重要性排序的符号地图：

- 先按文件总 importance 排序
- 再按文件内符号 importance 排序
- 每个 symbol 展示 `kind / name / line / ref_count`
- 最后附加建议阅读文件

### 9.2 `overview`

输出仓库的第一眼概览：

- 框架
- 入口点
- 文件数 / 符号数
- 语言分布
- 建议阅读
- package scripts

### 9.3 `pairs`

输出源码到测试文件的启发式映射，帮助快速定位“改完该看哪些测试”。

---

## 10. 安装与使用

### 10.1 Python 版本

```bash
# 需要 Python 3.11+ 与 uv
uv tool install .

# 或在仓库里直接运行
uv run python -m scope --path /some/repo --mode overview
uv run python -m scope --path /some/repo --mode map
uv run python -m scope --path /some/repo --mode pairs
```

### 10.2 TypeScript 版本

```bash
# 需要 Node.js 20+
npm install

# 开发查看
npm run dev

# 构建 CLI
npm run build

# 运行 TypeScript 版
node dist/index.js --path /some/repo --mode overview
node dist/index.js --path /some/repo --mode map
node dist/index.js --path /some/repo --mode pairs
```

### 10.3 共用参数

```bash
--path /repo/path
--scope src/
--mode overview|map|pairs
--format text|json
--token-budget 800
--max-files 1000
--no-cache
```

---

## 11. 测试方式

### 11.1 Python 测试

```bash
uv run pytest -q
```

覆盖内容：

- `test_discover.py`
- `test_rank.py`
- `test_references.py`
- `test_cache.py`

### 11.2 TypeScript 测试

```bash
npm test
```

覆盖内容：

- `cli.test.ts`：CLI 端到端行为
- `discover.test.ts`：文件发现与配对
- `frameworks-cache.test.ts`：框架检测与缓存
- `references-rank.test.ts`：依赖与重要性计算
- `symbols.test.ts`：Tree-sitter 符号提取
- `compat.test.ts`：Python/TS 双实现一致性

### 11.3 兼容性对照测试

```bash
npm run compare:python
```

该脚本会：

1. 先构建 TypeScript 版本
2. 使用 `uv run python -m scope` 运行 Python 版本
3. 遍历 `ts-tests/fixtures/` 下的 fixture 仓库
4. 比较 `pairs`、`overview`、`map` 三种模式的 JSON 输出

当前 fixture 集合包括：

- `mini-python-repo`
- `mini-ts-repo`
- `mini-rust-repo`
- `mini-mixed-repo`
- `edge-cases-repo`

---

## 12. fixture 仓库的作用

`ts-tests/fixtures/` 不是普通测试文件集合，而是**用于回归和兼容性验证的小型真实仓库样本**。

用途：

- 验证 Python 与 TypeScript 两套实现输出一致
- 覆盖不同语言和不同框架信号
- 覆盖边界行为，例如入口文件、测试配对、混合语言项目

目前覆盖：

- 纯 Python 仓库
- 纯 TypeScript 仓库
- 纯 Rust 仓库
- Python + TypeScript 混合仓库
- 一组偏边界行为的 Python 仓库

---

## 13. 关键设计决策

### 13.1 为什么用 Tree-sitter 而不是正则

正则无法稳定识别嵌套作用域、类方法、trait/impl 关系。Tree-sitter 提供结构化 AST，是“代码库导览”能力成立的基础。

### 13.2 为什么用跨文件引用做排序

项目初次阅读最重要的问题不是“代码最长的文件是什么”，而是“其他文件最依赖什么”。跨文件引用更能反映真实核心度。

### 13.3 为什么优先 `git ls-files`

- 自动尊重 `.gitignore`
- 更少噪声
- 避免依赖目录、构建目录、缓存目录污染分析结果

### 13.4 为什么缓存用 `mtime + size`

比全量文件 hash 更便宜，同时对这个工具的精度需求来说足够可靠。

### 13.5 为什么保留 text 与 JSON 两种输出

- text 适合人读与直接粘贴给 AI
- JSON 适合做自动化验证、测试与跨实现对照

### 13.6 为什么要做双实现兼容性回归

因为 TS 版的目标不是“功能类似”，而是“行为尽量一致”。没有回归对照，迁移很容易逐步偏离 Python 基线。
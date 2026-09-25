# 看懂 rpiv-web-tools：模型怎么从 Pi 会话里联网

> 面向第一次接触这个扩展、准备二次开发的读者。不需要先会十家搜索 API，但需要知道 Pi Agent 会把扩展装进当前会话进程。
>
> 本文定位：**轻量扩展 + 二次开发深度**。稳定认知放在职责边界、进程真相和两条工具链路上。供应商名单、环境变量名、UI 文案会变。
>
> 源码基线：本仓库归档副本 `@rpiv/rpiv-web-tools`，包版本 **2.9.0**；归档仓库 HEAD `6f1c21c`（2026-09-08）。上游：[juicesharp/rpiv-mono `packages/rpiv-web-tools`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools)。
>
> 同仓库里已有一份偏「从零复刻」的源码地图：[rpiv-web-tools.md](./rpiv-web-tools.md)。本文回答「它是什么、怎么活在机器上、一次调用怎么走完」；那篇回答「每一块代码在主线的什么位置」。

## 1. TLDR：它把「模型要联网」收成两次工具调用

rpiv-web-tools 做的事情可以压缩成两条链路：

```text
web_search：
模型发出查询
→ 本进程选出一家搜索后端
→ 当前进程里发一次 HTTP
→ 把标题 / URL / 摘要还给模型

web_fetch：
模型给出一个 URL
→ 先挡私有地址
→ 可选的 GitHub 专家路径，或厂商抽取，或本地剥 HTML
→ 截断后把文本还给模型（全文可能落到临时文件）
```

所以它不是：

- **不是搜索引擎。** 自己不建索引，只把 query 转给 Brave / Tavily / SearXNG 这类后端。
- **不是代理服务。** 没有常驻端口，不转发任意流量。
- **不是浏览器。** 不跑 JS、不带登录态、不走 CDP。GitHub 路径是 `gh` / `git clone` 读文件，不是打开网页。
- **不是独立进程。** 没有 daemon、没有自己的 HTTP server、没有 cron。

正面定义：**它是 Pi Agent 宿主进程里的一个扩展回调。** 会话启动时注册两个工具和一个 `/web-tools` 命令；真正联网发生在模型调用工具的那一次 `execute` 里。

权威数据源尽早点名：

- 跨会话唯一持久化的是 `~/.config/rpiv-web-tools/config.json`（或 `$XDG_CONFIG_HOME/rpiv-web-tools/config.json`）。
- 搜索结果不落盘、不缓存。
- GitHub clone 缓存和拦截器单例活在**当前 Pi 进程**里，改配置后要重启会话才重建。

## 2. 为什么不能写死一家搜索 API

如果只接 Brave，扩展会更短。它没有这么做，是因为三件事情不该绑在一起：

| 该分开的东西 | 正例 | 反例 |
|---|---|---|
| 编排层只认统一结果 | 上层只处理 `SearchResult { title, url, snippet }` | 在 `web-tools.ts` 里直接解析 Brave 的 JSON |
| 凭证来源可替换 | 环境变量赢过配置文件，CI 和本机可以不同 | 把 key 写进工具参数让模型看见 |
| 抓取能力可缺席 | Brave / Serper / SearXNG / Perplexity 只有 search，fetch 走本地 HTML | 强迫每家都实现抽取接口 |

所以职责是这样切的：

- **模型**决定什么时候搜、搜什么、要不要打开某个 URL。
- **编排层**（`web-tools.ts`）决定用哪家、拦不拦私有地址、超长文本怎么截。
- **供应商文件**（`providers/*.ts`）只负责把自家 HTTP 翻译成统一类型。
- **配置命令**（`/web-tools`）只负责选后端和写 key，不参与一次搜索的热路径。

不要把「支持十家后端」理解成「运行时会自动换一家重试」。缺 key、拼错名字、SearXNG 没开 JSON，都是直接抛错。没有跨供应商回退。

## 3. 先看整体架构，不急着看类名

文档视角可以画成四层。每层只做一件事：

```text
┌──────────────────────────────────────────┐
│ 接入层                                    │
│ Pi 发现 package.json → 加载 index.ts      │
│ 注册 web_search / web_fetch / /web-tools  │
└──────────────────┬───────────────────────┘
                   │ 模型调用工具
┌──────────────────▼───────────────────────┐
│ 编排层 web-tools.ts                       │
│ 选供应商、host guard、截断、拼 envelope    │
└──────────────────┬───────────────────────┘
                   │ SearchProvider / FetchProvider
┌──────────────────▼───────────────────────┐
│ 供应商层 providers/                       │
│ 十家 HTTP 适配 + 可选 GitHub 拦截器        │
└──────────────────┬───────────────────────┘
                   │ Node fetch 或 gh/git 子进程
┌──────────────────▼───────────────────────┐
│ 外部世界                                  │
│ 云端搜索 API / 自建 SearXNG·Ollama / 目标页 │
└──────────────────────────────────────────┘
```

每层收到什么、做什么、产出什么：

| 层 | 收到 | 做 | 产出 |
|---|---|---|---|
| 接入 | Pi 的 `ExtensionAPI` | 建拦截器单例，注册工具和命令 | 模型能看见两个 tool |
| 编排 | 工具参数 | 解析 provider、校验 URL、截断 | 给模型的 envelope |
| 供应商 | query 或 url | 发 HTTP，把 JSON 收成统一类型 | `SearchResponse` / `FetchResponse` |
| 外部 | 请求 | 索引或抽取（不在本包） | JSON 或 HTML |

进程真相和这张图大部分一致，差异是精华：

- 「供应商层」是**代码职责**，不是一台持续监听的服务器。HTTP 发生在当前 Pi 进程的 `execute` 里。
- GitHub 拦截器看起来像 fetch 的一个分支，实现上却会 `execFile("gh"|"git")` 拉起**子进程**。这是包内唯一的外部二进制路径。
- `/web-tools` 保存配置**不会**重建拦截器单例。`interceptors.github` 的开关以注册那一刻为准。

## 4. 实际怎样运行：它是宿主进程里的扩展

判定句：rpiv-web-tools **主要是一个 Pi 扩展，不是一组 CLI，也不是服务。**

证据不在 README 的自我描述，而在安装产物：

```text
package.json
  "pi": { "extensions": ["./index.ts"] }

index.ts
  export default function registerWebTools(pi, opts?)
    → buildInterceptors
    → registerWebSearchTool
    → registerWebFetchTool
    → registerWebSearchConfigCommand
```

Pi 宿主发现这个包之后，在**当前会话进程**里调用 default export。装了它，不会多出一个常驻进程，也不会多监听一个端口。

装了什么、跑起来是什么：

| 产物 | 生命周期 |
|---|---|
| 两个 Pi 工具 | 随会话进程起止；每次调用才发 HTTP |
| `/web-tools` 命令 | 需要交互式 UI；无头模式会报错 |
| `~/.config/rpiv-web-tools/config.json` | 跨会话；mode `0o600` best-effort |
| 拦截器单例 | 进程内，注册时创建 |
| `$TMPDIR/rpiv-fetch-*/content.txt` | 截断溢出才写；**无人删除** |
| `$TMPDIR/pi-github-repos/...` | 仅 GitHub 拦截器开启且命中时 |

有没有常驻进程？**没有。** 「搜索服务」是代码职责，不等于一台持续监听端口的服务器。每次工具调用在当前进程内 `new` 一家 Provider、发一次 `fetch`，然后随这次 `execute` 结束。用户不需要另外启动 rpiv-web-tools。

和宿主的关系：

```text
Pi 会话进程
 ├─ 模型循环（宿主）
 ├─ rpiv-web-tools 回调（寄生）
 │    ├─ execute 内的 Node fetch
 │    └─ 可选：gh / git 子进程（GitHub 拦截器）
 └─ 会话结束 → 扩展一起消失
```

被谁拉起的进程就归谁：工具调用由 Pi 的工具运行时触发；GitHub clone 子进程由拦截器在命中 github.com 代码 URL 时拉起，随那次 fetch 结束。配置读写走 `@juicesharp/rpiv-config`，不是本包自己的服务。

## 5. 链路一：一次 web_search 怎么走完

层名连读就是整条链：

```text
宿主层 → 参数层 → 解析层 → HTTP 层 → 信封层 → TUI 预览层
```

### 5.1 宿主层：模型发出 `web_search`

Pi 工具运行时调用 `execute`。载体是当前会话进程，同步进入、内部 `await` HTTP。参数已到 ≠ 已经搜过。

### 5.2 参数层：把 `max_results` 夹到 1–10

默认 5。这一步纯本地，不碰网络。

### 5.3 解析层：四档里谁先赢，就用谁

```text
per-call provider
  → 环境变量 WEB_SEARCH_PROVIDER
    → config.provider
      → 默认 "brave"
```

override 或（当 env 是决胜档时）`WEB_SEARCH_PROVIDER` 拼错，会在这里直接 throw，文案是 `Unknown web_search provider`。配置文件里写错名字会再往下走到工厂，文案变成 `Unknown search provider`。两种错误看起来像一回事，排查时不要混。

key 的优先级是另一条轴，和「选哪家」分开：

```text
process.env[BRAVE_SEARCH_API_KEY 等]
  → config.apiKeys[provider]
    → 仅 Brave：遗留的顶层 config.apiKey
```

环境变量为空字符串当成没设。没有「这家没 key 就换下一家」。

### 5.4 HTTP 层：当前进程里 `provider.search()`

`createSearchProvider` 按名字 `new` 对应类，然后 `await search()`。十家的请求格式、认证头、JSON 路径都封在各自文件里。编排层从此只看见 `{ query, results[] }`。

这一步是整条链最容易失败的外部调用：缺 key、401、SearXNG 没开 JSON、Ollama 没在跑，都发生在这里。它先于任何「写入」——而本包本来也不写搜索结果，所以失败时配置文件和上次会话都不变。

### 5.5 信封层：把结果交给模型

成功时：

```text
content: 编号 markdown 列表（标题 / URL / 摘要）
details: { query, backend, resultCount, results }
```

空结果不是错误：正文是 `No results found for "…".`，`resultCount: 0`。

工具返回成功，只证明**这一次查询的文本已经交给模型**。它不证明用户看见了 TUI，也不证明下一轮还能搜到同一批结果——结果没有缓存。

### 5.6 TUI 预览层：给用户看前 5 条

`renderResult` 最多预览 5 条。模型拿到的 `content` 可以更长。不要用屏幕上的条数判断模型看见了多少。

`web_search` 的 per-call `provider` **只影响这一次搜索**。`web_fetch` 实例化供应商时不接收 override，抓取永远用会话当前活动后端。

## 6. 链路二：一次 web_fetch 怎么走完

```text
宿主层 → 地址守卫层 → 拦截器层 → 抽取层 → 截断层 → 信封层
```

### 6.1 宿主层：模型发出 `web_fetch({ url, raw? })`

同样在当前进程的 `execute` 里。`raw` 只对**本地剥 HTML**那条路有意义；厂商抽取普遍忽略它。

### 6.2 地址守卫层：先挡字面私有地址

只允许 `http:` / `https:`。hostname 按字面黑名单拒绝：

- `localhost`、`*.localhost`
- IPv6 `::1` / link-local / ULA
- IPv4 `127/8`、`10/8`、`192.168/16`、`172.16–31/12`、`169.254/16`（含云 metadata）、`0/8`

这一步在拦截器之前。不能靠「看起来像 github.com 的 path」绕过私有 host。

当前可靠性边界要写死：**它看字面 hostname，不解析 DNS，也不在 redirect 后再跑一遍。** 公网名指到内网、或 302 到内网，仍可能打到目标。自建 `SEARXNG_URL` / `OLLAMA_HOST` 指向 localhost 是故意可达的——守卫管的是模型要 fetch 的 URL，不管供应商自己的端点。

### 6.3 拦截器层：默认是空数组

```text
for interceptor in getInterceptors():
  命中 → 短路，跳过后面两路
  未命中 → 返回 null，继续
```

默认 GitHub 拦截器是关的。打开方式有两档，**用户配置赢**：

1. `config.interceptors.github`（`true` / `false` / 带选项的对象）
2. 编程接入：`registerWebTools(pi, { interceptors: { github: true } })`

`buildInterceptors` 只在扩展注册时跑一次。之后每次 fetch 读进程内单例，但单例不会因为你刚改了 `config.json` 而变。

命中条件很窄：host 必须是 `github.com` / `www.github.com`，path 必须是仓库根、`blob` 或 `tree`。`issues` / `pull` 返回 null，落到普通网页抓取。

命中之后（仍在这次 `execute` 里，但可能拉子进程）：

```text
内存 cloneCache
  → 40 位 SHA 的 ref 走 gh api，不 clone
    → 仓库过大（默认 350MB）走 API 视图
      → gh repo clone 或 git clone --depth 1
        → clone 失败再退回 API
```

返回的仍是 `{ text, title, contentType }`，后面和另外两路共用截断。

### 6.4 抽取层：有 `fetch` 方法就用厂商，否则本地剥 HTML

编排层**不读** `ProviderMeta.roles`，只看运行时 `"fetch" in provider`。

| 后端 | search | fetch 走哪条 |
|---|---|---|
| Brave、Serper、Perplexity、SearXNG | 有 | 本地 `fetch` + 剥 HTML |
| Tavily、Exa、You.com、Jina、Firecrawl、Ollama | 有 | 厂商 extract 端点 |

本地路径会拒绝 `image/` `video/` `audio/`，跟随 redirect，非 2xx 抛错。Firecrawl / Jina / Tavily 的「scrape」发生在**厂商云端**，不是本机浏览器。

### 6.5 截断层：模型只看到头

用 Pi 自带的 `truncateHead`（行数 + 字节）。超限就把全文写到 `$TMPDIR/rpiv-fetch-*/content.txt`，footer 告诉模型用 `read` 去读。

**完成 ≠ 就绪：** 工具已经成功返回，只证明模型上下文里有一份截断文本。全文在临时文件上，会话结束也不保证清理。GitHub clone 目录同理。

### 6.6 信封层

正文 = 可选标题头 + 截断文本 + 可选 truncation footer。TUI 预览最多 15 行。用户点开预览 ≠ 模型拿到了全文。

## 7. 概念区分和常见误区

| 词 | 它是 | 它不是 |
|---|---|---|
| Provider | 一次 `execute` 里 new 出来的适配器 | 常驻连接池 |
| 活动 provider | env / config / 默认 决出的会话后端 | fetch 的 per-call override（fetch 没有这个参数） |
| FullProvider | 运行时带 `fetch()` 方法的对象 | META 上写了 `"fetch"` 就够（分发不看 META） |
| 拦截器 | 注册时建好的 URL 专家 | `/web-tools` 保存后立刻生效的热更新 |
| host guard | 字面 hostname 黑名单 | SSRF 全集（不管 DNS / redirect） |
| SearXNG | 你自己的搜索实例 | 目标页面的抓取器（它的 fetch 仍走本地 HTML） |

常见误区：

- 「装了就能一直搜。」错。没配 key、没选后端，第一次 `web_search` 就会炸。正：配置是跨会话的，进程不是。
- 「fetch 失败会换下一家。」错。正：三岔口是能力分发，不是重试链。
- 「开了 GitHub 拦截器，github 上什么都能读。」错。正：只拦代码树 URL；Issue / PR 仍是普通 HTML。
- 「改了 config 里的 guidance，下一轮提示词就变。」错。正：guidance 在 `registerTool` 时冻结，要重启会话。
- 「`invalidateConfigCache` 说明有内存缓存。」错。正：它是 no-op，每次 `loadConfig()` 都读盘。

## 8. 失败了该查哪一层

有网络、有配置文件、有可选子进程，所以按**用户能看见的症状**查，不要先怀疑模型。

| 症状 | 先查 | 不要先怀疑 |
|---|---|---|
| `BRAVE_SEARCH_API_KEY is not set. Run /web-tools…` | env 和 `apiKeys` | 搜索算法 |
| `Unknown web_search provider` | 这一次的 `provider` 参数或 `WEB_SEARCH_PROVIDER` | 配置文件里的名字（那是另一种文案） |
| `Unknown search provider` | `config.provider` 拼写 | 工具 schema |
| SearXNG 403 并提示 JSON disabled | 实例的 `settings.yml` → `search.formats` 要有 `json` | 本包的 host guard |
| `Could not connect to Ollama at …` | `ollama serve` 和 `OLLAMA_HOST` | API key |
| `Refusing to fetch private/loopback address` | 模型给的 URL 是不是 localhost / 内网 | 供应商挂了 |
| 能搜但不能把页面读成正文 | 当前后端是不是 search-only；本地 HTML 是否被站点反爬 | 拦截器（默认是关的） |
| GitHub 仓库页仍是 HTML 噪音 | 拦截器有没有在**注册时**打开；改完 config 有没有重启会话 | clone 路径本身 |
| `/web-tools requires interactive mode` | 是不是无头跑 | 配置文件损坏（坏 JSON 会 fail-soft 成 `{}`） |

可靠性边界：本包没有包住「搜索 + 抓取 + 写配置」的总事务。一次工具调用失败，不影响配置文件，也不回滚另一次已经成功的调用。这是当前可靠性边界。

## 9. 如果只记一条主线

可独立验证的稳定事实：

1. 它寄生在 Pi 会话进程里，不另开服务。
2. 上层只认 `SearchResult` / `FetchResponse`；十家 HTTP 细节不许漏进编排层。
3. fetch 是三岔口：opt-in GitHub 专家 → 厂商 `fetch()` → 本地剥 HTML。不是重试。
4. 跨会话权威源是配置文件；搜索结果不是。
5. host guard 是字面黑名单，不是完整 SSRF 防护。

如果只记一条完整主线，可以记成：

```text
Pi 加载扩展
  → 模型调用 web_search / web_fetch
    → 本进程选一家（或拦截器）
      → 一次 HTTP 或一次 gh/git
        → 截断后的文本回到模型上下文
```

## 10. 想改代码时按这个顺序读

按调用链，不要按文件名散读。

1. `package.json` + `index.ts`  
   看了能懂：它为什么是扩展而不是服务；拦截器为什么在注册时就定死。
2. `web-tools.ts` 里两个 `execute`  
   看了能懂：四档 provider 解析、host guard、三岔口分发、截断和 spill。
3. `providers/types.ts` + `providers/factory.ts`  
   看了能懂：统一类型和「加一家后端」的扩展点。
4. 一家 FullProvider（`tavily.ts`）对照一家 search-only（`brave.ts`）  
   看了能懂：`fetch` 方法在或不在，决定走哪条抽取路。
5. `providers/fetch-helpers.ts`  
   看了能懂：没有厂商抽取时，本机究竟怎样把 HTML 变成文本。
6. `providers/interceptors/index.ts` → `github.ts` 的 `fetchGitHub`  
   看了能懂：默认关闭、用户配置赢、clone / API 的降级顺序。
7. `providers/config.ts`  
   看了能懂：XDG 路径、坏 JSON fail-soft、按字段 salvage。

测正在改的函数时，对着同名 `*.test.ts`，不要先加新的抽象。官方用法文档在包内 `docs/`：`tools.md`、`providers.md`、`configuration.md`、`self-hosted.md`、`github-interceptor.md`。

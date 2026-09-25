# 看懂 pi-web-access：搜、抽、核源三条工具，路由发生在宿主进程里

> 本文面向第一次接触 `pi-web-access`、但已经知道「Pi 扩展会注册工具、模型靠工具结果当上下文」的读者。重点不是背 20 个搜索供应商的 API 名，而是讲清：一次搜索/一次取页在哪个进程里完成、auto 路由信谁、页面正文进了模型 ≠ 进了磁盘、curator 浏览器是不是另一个爬虫。
>
> **本文定位：中项目、二次开发深度。** 稳定认知放在工具边界、路由层、SSRF、存储分层上；供应商名单、默认超时、快捷键、摘要提示词属于易变细节。包版本 `0.27.0`，供应商会继续加，但「扩展进程内路由 + 本机配置文件 + 取页先过 SSRF」这条主线应当稳住。
>
> 源码基线：本仓库 `@nicobailon/pi-web-access`，包版本 `0.27.0`；工作区 HEAD `879f918db9f7c50659ac1dd3938ccf11ebfa5cec`（2026-09-08），该目录最近一次提交 `262c13ed69a55f94889194018f652adf628ddc4b`（2026-09-03）。上游独立仓库：[nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)。

## 1. TLDR：它做的事情可以压缩成三条工具链

`pi-web-access` 给 Pi 增加「上网」能力，但自己不是浏览器 Agent，也不是搜索引擎。它是 **宿主进程里的路由器**：看配置和密钥，挑一个供应商，把结果裁成模型能读的文本；需要全文时再走取页管道。

```text
web_search     查询 → 路由供应商 → 标题/摘要/链接（可选人工 curator）
fetch_content  URL → SSRF 预检 → 专项抽取或 HTML 可读化 → markdown
source_check   声明的链接 → 拉证据 → 一段「核过源」的 artifact
get_search_content  凭上次的 responseId 把缓存/全文再取回来
```

所以它不是：

- 不是无头 Chrome 自动化框架。默认取页是 HTTP + 可读化，不是点击渲染后的 DOM（个别供应商在它们自己的云端渲染，那是供应商的事）。
- 不是全局代理。SSRF 层会拦内网 / 字面 IP / 危险跳转；信任环境代理只影响「主机名解析走哪」，不等于它帮你配好了传输代理。
- 不是「注册了就永远 web_search」。工具和 slash 命令都可以按配置关掉。
- 不是把每次全文永久写进 session。session jsonl 往往只留元数据和 id；大正文在内存 Map 和磁盘 cache 里。

正面定义：它是 **带策略的 Web 工具箱**。权威配置是 `web-search.json`（外加环境变量密钥）；权威结果是这一次工具调用返回给模型的文本；磁盘 cache 只为 `get_search_content` / 回看服务。

## 2. 为什么要做成路由器，而不是绑死一家搜索 API

正例：今天有 Exa 的 key，明天只想用无 key 的 DuckDuckGo / SearXNG，后天当前模型本身就能搜（OpenAI hosted search）。如果每个供应商都暴露成一个工具，模型会乱挑，用户也会在 key 失效时卡死。

反例：把「搜索」做成对单一 HTTP 接口的薄封装。换供应商就要改提示词、改工具名、改错误处理。核源、YouTube、GitHub 仓库、PDF 也会全部挤进同一个 `fetch(url)`。

所以切开：

| 谁 | 管什么 | 不管什么 |
|---|---|---|
| 模型 | 决定搜什么、要不要再 fetch 某条 URL | 不选具体 HTTP 客户端实现 |
| 路由层 | auto / 具名 / all / 用户配置的 routing 列表 | 不保证每家返回同样的字段质量 |
| 抽取层 | URL 类型分流（GitHub / YouTube / PDF / 普通 HTML） | 不把内网当合法目标 |
| 存储层 | 给模型一个短 id，全文可回取 | 不是用户的收藏夹产品 |
| curator | 人在浏览器里勾选、改写、摘要 | 不是第二套搜索引擎 |

## 3. 先看整体架构，不急着看供应商文件

文档视角：

```text
接入层     web_search / fetch_content / source_check / get_search_content
           /websearch /search /curator /google-account 以及快捷键
   ↓
配置层     ~/.pi/web-search.json（或 XDG / PI_CODING_AGENT_DIR）+ 环境变量密钥
   ↓
路由层     搜索：auto 回退链 / 具名 / all 并发；取页：fetchRouting
   ↓
安全层     SSRF：只允许 http(s)、拦环回和内网、跟随跳转时再次预检
   ↓
抽取层     专项（GitHub clone、YouTube、PDF、远程 reader）或 Readability/Defuddle
   ↓
呈现/存储  短摘要给模型；可选磁盘 cache；可选本地 HTTP curator 页
```

进程真相：这些层默认都在 **当前 Pi 宿主进程**里。没有 web-access daemon。

例外的「看起来像另一个服务」：

- **curator**：扩展在本机起一个短命 `http.Server`，把系统浏览器打开那一页。浏览器不是爬虫，是人用来勾选结果的 UI。搜本身仍在 Pi 进程里跑，结果用 SSE 推到那一页。
- **远程供应商**：Exa / Tavily / Firecrawl / Gemini 等是它们自己的云。扩展只是客户端。
- **GitHub 抽取**：可能在临时目录 clone。仍是当前进程 `spawn` 的 git，不是后台服务。

| 节点 | 载体 | 同步？ |
|---|---|---|
| 工具调用 | 当前 Pi 进程 | 同步等到这条工具结束（内部可并发多个 URL/查询） |
| auto 搜索回退 | 同进程顺序试下一家 | 同步；一家失败不等于整次失败 |
| curator | 本机 HTTP + 系统浏览器 | 工具调用阻塞，直到人提交 / 取消 / 超时 / 页签变陈旧 |
| 磁盘 cache | `web-search-cache/*.json` | 取页成功后写；进程退出后还能被 id 找回来（TTL 内） |
| 活动微件 | TUI widget | 异步订阅 `activityMonitor`，与工具结果无关 |

完成 ≠ 就绪：

1. `web_search` 返回了链接列表 ≠ 页面正文已在上下文里。默认常常只有 snippet。要全文再 `fetch_content`，或打开 `includeContent`。
2. curator 打开了浏览器 ≠ 人已经策展完。工具还在等 `onSubmit`。关掉页签会走 stale/cancel。
3. fetch 成功 ≠ 下次还能 `get_search_content`。关掉该工具、cache 超限或 TTL（1 小时量级）过后，id 会失效。
4. `provider: "all"` 跑完 ≠ auto。all 是可用供应商一起查；auto 是按名单 **顺序试到一家能用**。

## 4. 实际怎样运行：扩展，不是网关进程

`package.json` 的 `pi.extensions: ["./index.ts"]`。Pi 启动加载一次，按当时读到的配置决定注册哪些工具和命令。**改配置后要重新加载扩展**，否则新 key 不会出现在这次进程的工具表里。

配置目录解析（稳定语义，具体优先级以 `utils.ts` 为准）：

- `PI_CODING_AGENT_DIR` 若存在，配置就跟它走。
- 否则若设了 `XDG_CONFIG_HOME`，先看 `$XDG_CONFIG_HOME/pi/web-search.json`，没有再回退 `~/.pi/web-search.json`。
- 再否则 `~/.pi/web-search.json`。

注意：这是 `~/.pi/`，**不一定**是 `~/.pi/agent/`。和 pi-intercom 的 agent 目录不是同一约定。取页 cache 在同目录下的 `web-search-cache/`。

密钥：配置文件和环境变量双通道（`EXA_API_KEY`、`BRAVE_API_KEY` 这类）。解析失败会抛 `CredentialResolutionError`，auto 链把它当成「这家不能用」，不是静默当空结果。

`session_start` / `session_tree` 会尝试从当前会话已有的 `web-search-results` 自定义条目把内存 Map 重建出来。换树、resume 同一条 jsonl 时，模型还可能拿旧的 responseId 问 `get_search_content`。磁盘上的 cache 文件在 TTL 内才能把全文补回去；只有元数据、没有 cache 的条目，回取会失败或只剩标题。这是「会话痕迹 ≠ 缓存命中」的现场。

GitHub 仓库抽取会在临时目录 clone，并自己做一份 clone cache（`clearCloneCache` 在会话切换时清）。这和 `web-search-cache` 不是同一个目录。克隆失败应看成专项抽取失败，不要回到「当普通 HTML 抓 GitHub 网页」——那会丢掉树结构。

零配置能搜：取决于你机器上碰巧有什么。无 key 时常见是 DuckDuckGo / 自建 SearXNG / 某些 MCP。**不要把 README 营销句「Zero Config」理解成永远有高质量搜索**——没有可用供应商时，工具会失败，而不是假装搜过。

## 5. 供应商怎么分类（不要背名单）

源码里真正要分的是 **选择器语义**，不是 logo：

- **auto**：按内置回退顺序，碰到第一家「可用且能给出结果」就停。可用 = 有 key / 有本机端点 / 当前模型支持 hosted search。
- **具名**：`provider: "brave"` 只走那一家，失败就是失败。
- **all**：对 `ALL_SEARCH_PROVIDERS` 里当时可用的家并发（过滤掉不可用的），再拼结果。
- **explicit-only**：例如 Serper、Parallel MCP。它们 **不会** 进入 auto，也 **不会** 进入 all。必须写名字或放进你自己的 `searchRouting`。

`ALL_SEARCH_PROVIDERS` 是一张允许出现在 all/auto 解析里的名单；README 里出现的每一家不一定都在这张名单上。二次开发加供应商时，先问：它该进 auto 吗？还是必须显式？漏掉这问，用户会在 `provider: "all"` 里看到意外的计费调用，或永远轮不到新家。

取页另有 `fetchRouting`。默认本地 HTTP 抽取；把 Parallel MCP 这类远程 hosted fetch 加进去还要显式 `allowRemoteHostedProviders`。搜索能走 MCP ≠ 取页自动走 MCP。

Gemini 在搜索侧还分：API key、ADC、以及「用浏览器 cookie 的 Gemini Web」。后者是可选、带隐私含义的路径，不是 auto 默认。`/google-account` 管的是这类账号绑定，不是通用 OAuth 网关。

## 6. 纵向链路一：一次 `web_search`

```text
1. 接入     模型给 query（可多条）和可选 provider
2. 改写     可选 query-rewrite，把口语变成检索串
3. 路由     解析 auto / 具名 / all / 用户 routing
4. 调用     对应 *-search.ts 模块发 HTTP
5. 裁剪     每条结果 snippet 有上限；多 query 拼成一块文本
6. 可选策展  curate=true 或用户按快捷键 → 阻塞在本机 curator
7. 落痕迹   appendEntry("web-search-results")；内存 Map 记下 id
8. 返回     短文本给模型；details 带 responseId
```

第 5 步完成 ≠ 第 6 步完成。未策展时，模型拿到的是扩展格式化后的摘要，可能含供应商自己的 answer 字段。策展时，返回值可以变成「用户勾过的子集 + 用户接受的摘要」；提示词会写明 *Use them as-is*。

活动面板（快捷键切换）只是 `activityMonitor` 的派生视图，改文案不必改搜索。

`/search`、`/websearch` 是给人手动跑同一条链，不是另一套实现。命令也可以按配置关掉。

## 7. 纵向链路二：一次 `fetch_content`

```text
1. 规范化   fetch-params：URL 列表、mode raw/answer、超时
2. 分流     YouTube / GitHub 仓库 / GitHub issue·PR / 图片 / PDF / 普通 URL
3. 安全     远程 HTTP 先 SSRF：解析主机、比对 allowRanges、跟随跳转再查一次
4. 远程抽取  若配置了 Firecrawl / Jina / TinyFish / Kagi 等 reader，按路由试
5. 本地可读化 linkedom + Readability / Defuddle + Turndown → markdown
6. 可选问答  mode=answer 时用页面正文回答 prompt，不让模型再去网上找
7. 存储     内存 + 可选磁盘 cache（带条目数/字节上限、原子改名写入）
8. 返回     单 URL 失败则这条 error；多 URL 是部分成功模型
```

SSRF 的稳定规则（细节数值易变，规则本身该稳住）：

- 只接受 http/https。
- 字面环回、内网、链路本地默认拒绝。
- 跳转后的目标再预检；次数有上限。
- `allowLoopback` 是给 **供应商本地端点**（例如本机 SearXNG）开的，不是给 `fetch_content("http://127.0.0.1/admin")` 开的。
- 认证取页拒绝跨源跳转，避免 cookie 被带到别人的域。

专项抽取是「URL 像什么」而不是「供应商叫什么」：YouTube 走字幕/帧；GitHub 仓库可 clone 再抽；PDF 可走本地 unpdf 或 Gemini/Datalab。图片 URL 走缩放后的图内容，并可被 `image.enabled` 关掉。

`source_check` 走同一套取证思想，但产品语义是「核对这些声明链接」，输出 artifact（sources + passages），不是一篇可读文章。不要用它替代搜索。

`fetch_content` 的 `mode` 值得单独记：

- 默认可读化：HTML → markdown，给模型「这页在说什么」。
- `raw`：尽量保留 HTTP 正文，适合 API JSON、纯文本，不走 Readability。
- `answer` + `prompt`：先抽页，再在扩展进程里用选定模型 **只根据这些正文** 回答。这是为了少把整页塞进主会话上下文，不是又一次联网搜索。

`get_search_content` 是第四件工具，经常被当成可选项忽略。它拿的是上次 `responseId`：按 query / queryIndex 取回完整搜索列表，或对已存正文做 `findText`。没有它，模型只能看见第一次裁过的 snippet。关掉这件工具时，取页工具的描述会改成「内容已取回但不会存成可回看 id」——同一条链路，存储合同变了。

`findText` 的模式是 `exact` / `case-insensitive` / `fuzzy`（编辑距离），命中处带前后约 400 字，整次输出有上限。它是「在已经取回的正文里找」，不是新的搜索供应商。把 fuzzy 理解成又去网上搜一遍，会白白耗额度。

磁盘 cache 写入走临时文件 + rename，并尽量 `fsync`；读的时候拒绝 symlink（`O_NOFOLLOW`）。这是把 cache 目录当不可信文件系统来处理，不是表演性加固。上限默认大约 128 个文件 / 128 MiB，超出淘汰最旧的。TTL 约 1 小时。数字易变，合同是：**id 不是永久 URI**。

## 8. 纵向链路三：curator 为什么看起来像服务器，却不是搜索后端

当需要人挑结果时：

```text
Pi 进程起 http.Server（loopback，带 sessionToken）
  → 打开系统浏览器
  → 搜索仍在 Pi 里跑，结果 SSE 推进页面
  → 人勾选 / 加搜 / 选摘要模型 / 提交
  → 工具 promise resolve，浏览器使命结束
  → close()：没有常驻端口
```

页签 30 秒无心跳会当 stale。这是为了避免工具调用永远挂在「人已经把窗口关了」。取消原因分 `user` / `timeout` / `stale`，排错时别都写成 timeout。

本机 curator 页不是第二个 Google。它不能在扩展进程崩溃后继续搜。`sessionToken` 是防本机其它页乱提交，不是互联网鉴权。

策展页上的「用某个模型写摘要」走 `summary-review.ts` + `summary-model-scope.ts`：只列出当前会话 **enabled models** 里允许的那些，并把 thinking 后缀剥掉再匹配。下拉是空的，通常不是 curator 坏了，是模型名单把摘要模型滤掉了。人提交的摘要一旦被工具返回，提示词会要求模型当权威，不要再搜一遍——这是产品语义，路由层不会强制。

HTTP 代理：配置里的 proxy / 环境代理只在 SSRF 预检时决定「主机名解析是本地做还是交给代理」。字面 IP 和 localhost 仍然拦。`NO_PROXY` 的主机走本地预检。配了代理 ≠ fetch 已经走代理传输；那是另一段客户端实现。沙箱里若不允许任意 DNS，`trustEnvProxy` 才变得有意义。

## 9. 边界、概念区分、常见误区

**搜索工具 ≠ 取页工具。** 模型只搜到链接就下结论，是提示词用法问题，不是路由 bug。

**auto ≠ all。** auto 停在第一家成功；all 把能用的家都问一遍，更贵、更吵。

**explicit-only 不是坏了。** 在 auto 里看不到 Serper，是源码故意的。

**配置文件位置 ≠ agent 目录。** 在 `~/.pi/agent/` 里找 `web-search.json` 会以为没配置。

**磁盘 cache ≠ session 记忆。** 换会话、过 TTL、超 maxEntries/maxBytes，id 作废。`web-search-results` 自定义条目只是索引。

**curator 浏览器 ≠ 用你的登录态去爬任意站。** 默认爬取不复用你的 Chrome 配置文件。Gemini Web cookie 是单独、显式的功能。

**「当前模型能搜」≠ 总能搜。** OpenAI hosted search 还要看当前模型是否 eligible；换模型后同一句 web_search 会改道。

**部分成功是正常结果。** 十条 URL 死了两条，工具仍可能 `successful: 8`。把任意 error 字段当成整次失败会误导重试。

## 10. 失败形态与排错

| 现象 | 先查哪一层 | 常见原因 |
|---|---|---|
| 没有 web_search 工具 | 接入/配置 | 工具被 feature flag 关掉；扩展没 reload |
| auto 报没有可用供应商 | 配置/密钥 | 无 key、SearXNG 没配、当前模型不支持 hosted search |
| 指定 serper 才行、auto 从不走 | 选择器 | explicit-only，不是密钥没读到 |
| fetch 报 Blocked internal / hostname | SSRF | 目标是内网或字面 IP；不要关保护来「先试试」 |
| GitHub 仓库抽取很慢 | 专项抽取 | 正在 clone；看临时目录而不是 SSRF |
| YouTube 没字幕 | 专项抽取 | 视频无轨 / 功能关闭，不是通用 HTML 可读化失败 |
| curator 打开后工具一直转 | curator | 浏览器没连上（heartbeat）；或人没按提交 |
| get_search_content 找不到 id | 存储 | 没开该工具；cache 被上限淘汰；进程间 id 本就不可分享到另一台机器 |
| 摘要模型下拉是空的 | 模型范围 | `summary-model-scope` 按 enabled models 过滤，当前会话模型不在名单里 |

错误呈现走 `render-search-error.ts`：TUI 里那份「下一步建议」是给人看的计划，不是又一次自动搜索。改文案不要改路由。

## 11. 总结：可验证的稳定事实

1. 这是宿主进程里的 Web 工具箱：搜、取页、核源、回取。没有常驻网关。
2. 权威配置是 `web-search.json` + 环境变量；权威返回值是这一次工具文本。供应商名单会变。
3. auto / 具名 / all / explicit-only 是四种选择器，不是四家公司。
4. 远程取页先过 SSRF；curator 的本机 HTTP 和 Gemini cookie 是显式例外，不是默认爬取模型。
5. 全文默认不把整个正文永久写进 session；要回看靠 responseId 和 cache。

主线：

```text
模型点名工具
  → 配置决定「能不能、走哪家」
  → 搜索：路由到供应商，得到链接/摘要
  → 取页：SSRF → 专项或可读化 → markdown
  → 可选：人在本机 curator 勾一遍
  → 短结果回模型；长正文放 cache
```

## 12. 源码阅读顺序

不要按供应商文件字母序读，会淹没在几乎相同的 HTTP 封装里。

1. `package.json` + `index.ts` 开头的工具开关：看了能懂「这次进程到底注册了什么」。
2. `utils.ts` 的配置目录 / `web-search.json`：权威文件在哪。
3. `gemini-search.ts` 的 `search()`、`ALL_SEARCH_PROVIDERS`、auto 回退：选择器真相。具名供应商文件（`brave.ts`、`exa.ts`…）只在改某一家时打开。
4. `ssrf-protection.ts`：取页能碰哪些主机。这是安全合同。
5. `extract.ts`：URL 分流和本地可读化。看了能懂为什么 YouTube 不走 Readability。
6. `fetch-params.ts` + `index.ts` 里 `fetchContent` 工具：mode raw/answer、多 URL 部分成功。
7. `storage.ts`：内存 Map、磁盘 cache、TTL 与上限。看了能懂 id 能活多久。
8. `curator-server.ts` + `curator-page.ts`：短命 HTTP 和浏览器 UI。
9. `source-check.ts`、`declared-web-links.ts`：核源和普通搜索的差别。
10. `auth-fetch.ts`、`chrome-cookies.ts`、`gemini-web.ts`：显式登录态路径，默认别混进普通 fetch。
11. `activity.ts`、`render-search-error.ts`：派生 UI。
12. `test/`：行为合同。改 SSRF 或 auto 顺序先改测试，再改供应商。

本地冒烟：`pi install` 后 `/reload`，先 `web_search` 一个无争议的公开问题，确认 details 里有 provider 名和 responseId。再对其中一条 URL `fetch_content`。若配置了 curator，按快捷键应打开本机页而不是新的搜索后端。内网地址的 fetch 应当被 SSRF 拒绝。

## 参考资料

- [pi-web-access README](https://github.com/nicobailon/pi-web-access)
- 同包 `SECURITY.md`（SSRF 与缓存写入的威胁模型以源码为准，文档会滞后）
- [pi-coding-agent 扩展 API](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

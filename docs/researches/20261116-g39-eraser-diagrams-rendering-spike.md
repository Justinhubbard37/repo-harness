# G39 spike：可选 Chromium 边界内的 Eraser Diagrams 渲染

日期：2026-11-16。来源：#2822（父 issue #2810，PRD 改动 #2832）。仓库基线：main `cc7cf86`，operator 的 CSP 取自 `src/effects/operator/server.ts`。
库版本：npm `@eraserlabs/diagrams` 0.5.2 及同版本的 `protocol`、`resolve`、`layout`、`render`、`diagram-templates`、`diagrams-cli`（2026-11-11 发布，上游提交 `6bde284`）。

spike 代码在 `/tmp/rh-spike-2822`，不提交，不改 `package.json`。下文的命令都在该目录运行。

## 结论

| 问题 | 结论 | 关键证据 |
|---|---|---|
| 1 安装、启动、清理 | 三个平台都能启动。Windows 11 自带 Edge，不需要安装。macOS 需要 Chrome 或 192 MB 的 headless shell，Linux 需要发行版的 chromium（355 MB）。父进程被 SIGKILL 后，macOS 上的完整 Chrome 留下孤儿进程；三个平台都留下 profile 目录 | 清理表；supervisor 按进程组终止后进程为 0 |
| 2 断网 | 用本地图标和自带字体时，断网输出与联网输出逐字节相同。托管图标断网时变成占位图或 `E_UNKNOWN_ICON`。自带字体没有中文：Linux 上中文显示成方块，且没有任何警告 | PNG sha256 相同；Linux 方块截图 |
| 3 耗时与内存 | 典型图 0.13–0.68 s，峰值 0.6–1.0 GB（整棵进程树）。密集的 54 实体图 8–19 s。106 实体的密集图 63 s，209 实体超过 150 s。原因是渲染端把走线修复的时间预算写死为 `Infinity`，公开 API 不能改 | 规模表；预算探针把 209 实体降到 1.4–1.6 s |
| 4 失败行为 | 坏输入 0–1 ms 返回 `ok:false`、错误码和 JSON Pointer。缺浏览器 475 ms 明确报错。库没有超时；Chromium 崩溃后 `render()` 抛异常，之后每次调用都失败。worker 进程加 deadline 能明确失败，文档服务的事件循环最大延迟 2.7–13 ms | Q4 表 |
| 5 静态 HTML 与边界 | 输出不含脚本、事件属性、`javascript:` 链接和外部资源。放在不带 `allow-scripts` 的 iframe 里，要用独立路由和独立响应头；`srcdoc` 继承 operator CSP，内嵌字型被拦截。点链接会把图换成错误页。Firefox 里标签换行与 Chromium 不同 | Q5 表 |
| 6 导出 SVG | 把同一份 HTML 包进 SVG `<foreignObject>` 可行。以 `<img>` 显示时与 PNG 相差 0.006–0.017% 像素（Chromium）；WebKit 正常；Firefox 有同样的换行偏差。它不是纯矢量文件，非浏览器工具未验证 | Q6 表 |

三个失败条件都没有触发：渲染只在作者一侧需要浏览器，图标可完全本地，渲染不需要常驻服务。结尾的建议是接入，但附带约束。

## 环境

| 代号 | 机器 | 运行时 | 浏览器 |
|---|---|---|---|
| M | macOS 26.5（25F71），Apple M3 Max，16 核，64 GB | Node 24.22.1，Bun 1.4.4 | Google Chrome 157.0.8103.51；Chrome for Testing headless shell 149.0.7827.55（Playwright 缓存 1228） |
| L | M 上的 Docker 29.4.0 容器，linux/aarch64，16 vCPU，7.9 GB，`node:24-bookworm-slim` | Node 24.21.0（低于库的 `engines` 下限 24.22.1，运行无报错） | Debian chromium 156.0.8078.79，系统只有 6 个字体，没有中文字体 |
| W | Windows 11（NT 10.0.26100），i7-11390H，15.8 GB，hc 机器 `win-ci` | Node 26.13.0 | Microsoft Edge 157.0.4341.60（系统自带）；Chrome 也已安装但未使用 |

显示引擎对比另用 Playwright 的 WebKit 27.2 和 Firefox 157.0，装在 `/tmp/rh-spike-2822/pw-browsers`。

固定输入在 `diagrams/`：

| 输入 | 实体 | 连线 | 场景尺寸 | 说明 |
|---|---|---|---|---|
| `typical` | 12（2 个组、6 个图标、中文标签） | 8 | 812×544 | 代表 agent 写的解释图 |
| `grid-50` | 54（4 个组） | 80 | 1852×1852 | 本文按「最大预期图」处理：再大的图在文档宽度里读不清 |
| `grid-100` / `grid-200` / `grid-400` | 106 / 209 / 416 | 164 / 346 / 704 | 最大 4532×4532 | 上限测试；网格排布，组件间距 80 px（横）和 144 px（纵） |
| `v-*` | 25–106 | 0–164 | — | 把实体数、连线数、容器和密度分开测 |
| `hostile` | 5 | 1 | 552×491 | 标签里放脚本、事件属性、`javascript:`、外部图片、原始 `<style>` |

图标：从 Eraser 托管目录预取 12 个 SVG 到 `icons/`，用自写的 `iconLoader` 从磁盘读取，`onUnknownIcon: 'error'`。中文字体：Noto Sans SC 可变字体（OFL，17.7 MB），作为三个字体角色的后备。

## 问题 1：安装、启动和清理

库不自带浏览器，只接受 `chromiumPath` 或一个返回 Playwright `Browser` 的 provider。`diagrams-cli` 的自动探测只找 Chrome 和 Chromium：macOS 两个 `.app`，Linux 五个路径，Windows 三个根目录下的 `chrome.exe`，不找 Edge。

| 环境 | 可用浏览器 | 安装成本 |
|---|---|---|
| W | Edge 157，系统组件 | 无 |
| M | Chrome 157（本机已装，2.1 GB）；headless shell 149 也能用 | 没有 Chrome 的用户要装 Chrome，或下载 headless shell（解压后 192 MB） |
| L | `apt-get install chromium` | 镜像增加 355 MB，`docker build` 92 s |

清理测试：`cleanup.sh <浏览器> <模式>` 用独立的 `TMPDIR` 启动一个长渲染循环，按模式停止，3 s 后数残留进程和 profile 目录。

| 浏览器 | 正常 `close()` | SIGTERM / SIGINT | SIGKILL 父进程 |
|---|---|---|---|
| M Chrome 157 | 0 进程，0 目录 | 0，0 | **4 个进程残留**，父进程变成 launchd（ppid 1），共约 320 MB RSS，37 s 后仍在；2 个目录 |
| M headless shell 149 | 0，0 | — | 0 进程，2 个目录 |
| L chromium 156 | 0，0 | 0，0（TERM） | 0 进程，2 个目录 |
| W Edge 157（`Stop-Process -Force`） | 0，0 | — | 0 进程，2 个目录 |

机制：Playwright 在 POSIX 上以 `detached` 启动浏览器，浏览器是自己进程组的组长（实测 Chrome pid = pgid）。杀父进程或父进程组都到不了 Chrome。Linux 和 Windows 上浏览器在管道关闭后退出，macOS 的完整 Chrome 不退出。

有效的清理方式（`worker.mjs` + `supervisor.mjs`）：worker 用 `chromium.launchServer` 拿到浏览器 pid，再 `chromium.connect`，把这个 provider 交给 `createRenderer`。supervisor 到期时执行 `process.kill(-browserPid, 'SIGKILL')` 再杀 worker，最后删除该 worker 专用的 `TMPDIR`。结果：M Chrome 157 上 0 进程残留，2 个 profile 目录随 `TMPDIR` 一起删除。

`close()` 的耗时：M Chrome 157 在 106 实体图之后用了 5.0–9.5 s，L 是 44–98 ms，headless shell 是 20–25 ms。

## 问题 2：断网后的图标、中文字体和布局

断网方法：L 用 `docker run --network none`（Node `fetch` 返回 `EAI_AGAIN`）；M 用 `sandbox-exec -f nonet.sb`，规则是 `(deny network-outbound (remote ip))`（Node `fetch` 返回 `EPERM`）。

```bash
node render.mjs diagrams/typical.json --chrome <浏览器> --cjk file --cjk-path fonts/all-subset.ttf --inline --out <目录>
```

| 情况 | 结果 |
|---|---|
| 本地图标 + 自带字体，M 断网对联网 | PNG sha256 相同（`512b20dd…`） |
| 本地图标 + 自带字体，L 断网对联网 | PNG sha256 相同（`21fc7c6d…`） |
| 托管图标，`onUnknownIcon: 'placeholder'`，L 断网 | 成功，5 个 `W_UNKNOWN_ICON`，图标画成占位图 |
| 托管图标，`onUnknownIcon: 'error'`，L 断网 | 失败，5 个 `E_UNKNOWN_ICON`，消息是 `Unknown icon "user"`：取图失败被报成名字错误 |
| 实测几何，M、L、W 两两比较（`typical`、`grid-100`） | 0 个字段不同，场景尺寸相同 |

中文字体：

- 库自带 Inter、Shantell Sans、JetBrains Mono，三个都没有中文字形。每个角色的后备是通用族 `sans-serif`。
- M 上中文由系统字体补上。L 上没有中文字体时中文全是方块，`warnings` 和 `degradedFonts` 都是空的。
- 加上 Noto Sans SC 作为后备（`fallbacks.clean = '"SpikeCJK",sans-serif'`）后，L 的中文正确。
- `buildFontsHead` 把后备字符串原样写进 CSS 变量，所以这种写法可行。它依赖未写进文档的行为。

HTML 的字体默认按 `file:///<绝对路径>` 引用，输出里有本机路径，换一台机器就失效。要设 `inline: true`。内嵌后的大小：

| 字体内容 | `typical` HTML |
|---|---|
| 不内嵌（默认） | 105 KB，含 3 个 `file:///private/tmp/...` 路径 |
| 内嵌 3 个拉丁字体 | 760 KB |
| 再内嵌完整 Noto Sans SC | 24.5 MB |
| 再内嵌按本图 93 个字符裁剪的子集（63 KB，`pyftsubset`） | 845 KB |

## 问题 3：耗时和峰值内存

`bench.sh` 对每张图启动一次渲染器，连续渲染 3 次，同时用 `memtree.mjs` 每 50 ms 采样整棵进程树。M 记 RSS 之和（共享页重复计算，是上限）；L 记 PSS 之和；W 用 PowerShell 记 WorkingSet 之和。输出都是 PNG + 内嵌字体的 HTML + JSON。

| 图 | 环境 | 启动 | 3 次渲染 | 峰值内存 |
|---|---|---|---|---|
| typical | M Chrome | 1.30 s | 0.35 / 0.18 / 0.17 s | 968 MB RSS |
| typical | M headless shell | 0.57 s | 0.30 / 0.14 / 0.13 s | 596 MB RSS |
| typical | L | 0.40 s | 0.38 / 0.20 / 0.18 s | 623 MB PSS |
| typical | W Edge | 0.85 s | 0.68 / 0.22 / 0.21 s | 694 MB WorkingSet（另一次运行，带问题 3 的预算探针 0） |
| grid-50 | M Chrome | 1.26 s | 9.4 / 10.2 / 10.1 s | 981 MB RSS |
| grid-50 | L | 0.36 s | 9.8 / 9.8 / 9.3 s | 850 MB PSS |
| grid-50 | W Edge | 0.62 s | 16.5 / 17.5 / 19.2 s | — |
| grid-100 | M Chrome | 1.40 s | 63.1 s | — |
| grid-200 | M Chrome | — | 150 s 时仍未完成，被终止 | — |

库自己的计时显示，慢的部分是浏览器内的 `browserRun`；校验、净化和取图标合计在 75 ms 内。为了找原因，在 M Chrome 上单独改变一个因素（默认设置，`render` 为单次）：

| 变体 | 渲染 |
|---|---|
| grid-100，去掉全部连线 | 0.37 s |
| grid-100，去掉组和容器 | 60.6 s |
| grid-100，连线改 `connectorStyle: 'straight'` | 0.57 s |
| 稀疏排布（间距 260 px），100 实体，0 / 10 / 20 / 40 / 99 条连线 | 0.34 / 0.46 / 0.37 / 0.50 / 1.12 s |

成本来自密集布局里的 elbow 走线。`@eraserlabs/render` 的 `route.js` 写死 `REPAIR_TIME_BUDGET_MS = Number.POSITIVE_INFINITY`，`routeScene` 每次渲染最多调用 4 次。`diagrams.js` 传进页面的只有 `theme`、`entities`、`connections`、`icons`，没有 `repair`。

探针：`render.mjs --repair <ms>` 用 context 级 init script 包住 `window.__eraser.run`，给它加上 `repair: { timeBudgetMs }`。这是库的内部接口，只用于测量。

| 图 | 预算 100 ms | 预算 0 |
|---|---|---|
| grid-50 | 0.55 s | 0.51 s |
| grid-100 | 1.12 s | 0.70 s |
| grid-200 | 1.64 s | 1.35 s |

预算为 0 的 grid-50 走线比默认更直，没有可见的退化。预算为 0 的结果不依赖机器速度：M、L、W 的 grid-100 实测几何完全相同。预算为 0 时的上限测试：

| 图 | M Chrome | L | W Edge |
|---|---|---|---|
| grid-100 | 0.50–0.94 s，918 MB RSS | 0.65–0.85 s，914 MB PSS | 0.82–1.09 s |
| grid-200 | 0.96–1.58 s，782 MB RSS | 1.58–1.75 s，1088 MB PSS | — |
| grid-400 | 2.3–2.9 s，1631 MB RSS | 4.2–4.9 s，1361 MB PSS | 失败：`Page.captureScreenshot: Unable to capture screenshot`（20.5 Mpx），`render()` 抛异常 |

产物大小：PNG 50 KB（typical）到 1.0 MB（grid-400）；内嵌字体的 HTML 0.87 MB 到 3.6 MB，其中 3 个拉丁字体固定占约 656 KB（base64）。

## 问题 4：超时、坏输入、缺浏览器

`supervisor.mjs` 代表文档服务：它开一个 HTTP server，用 `monitorEventLoopDelay` 记录自己的事件循环延迟，渲染交给 `fork` 出来的 worker。M Chrome，Node 24.22.1：

| 情况 | 结果 |
|---|---|
| `"diagram"`（不是对象） | 0 ms，`ok:false`，`E_ENVELOPE /` |
| 未知标签 `Script` | 0 ms，`E_UNKNOWN_TAG /entities/0` |
| 缺 `connections` 键 | 0 ms，`E_ENVELOPE /` |
| 未知图标（error 模式） | 0 ms，`E_UNKNOWN_ICON /entities/0/icon` |
| 连线指向不存在的实体 | 0 ms，`E_MISSING_REF /connections/0/to` |
| 颜色里写 `url(...)` 或 `;background:` | `E_INVALID_COLOR`（`validate.mjs`，不启动浏览器） |
| 负坐标 | `E_SCHEMA` |
| 缺浏览器（`/nonexistent/chromium`） | 475 ms，`browserType.launch: Failed to launch chromium because executable doesn't exist at /nonexistent/chromium` |
| grid-50，deadline 2 s | 2.02 s 内终止 worker 和 Chromium 进程组；1 s 后 0 进程；事件循环最大 13.2 ms |
| 渲染中 SIGKILL Chromium | 当次 `render()` 抛 `page.evaluate: Browser closed`；下一次也抛同样的异常，渲染器不会恢复 |
| 同进程渲染 grid-50（8 s） | 事件循环最大 21.2 ms；页池默认 1 页，其他渲染排队，没有超时 |

同一个 supervisor 在 Bun 1.4.4 下运行结果相同（事件循环最大 2.7 ms）。repo-harness 的 CLI 用 Bun 运行，`package.json` 要求 Node `>=24 <26`；库要求 `^24.22.1`，24.0–24.22.0 不在库的范围内。

库本身没有渲染超时，`page.evaluate` 也没有。没有 worker 的话，一次慢渲染会一直占住唯一的页面。

## 问题 5：静态 HTML 是否符合「不开放任意 HTML」

输出扫描（`typical` 和 `hostile`）：`<body>` 里只有布局元素（`div`、`section`、`header`、`figure`、`figcaption`、`p`、`span`、`ul`、`li`、`strong`、`a`）和内联 SVG 图形元素；没有 `<script>`、`on*` 属性、`javascript:` 链接、`<img>`、`<iframe>` 或 `<style>`。内嵌字体时文档自带的 CSP 是 `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`。

标签净化在 `@eraserlabs/resolve` 的 `sanitize.js`：允许 `p br b i em strong del code pre ul ol li blockquote hr a span h1 h2 h3`；`a` 只留 `href`；协议只允许 `http`、`https`、`mailto`。Markdown 里的原始 HTML 显示成字面文字，Markdown 图片整个丢弃，`javascript:` 链接去掉 `href`。被改动的字段给出 `W_CONTENT_SANITIZED`。相对路径 `docs/a.md` 和 `mailto:` 会保留，PRD 的文档页链接规则只放行 http、https 和 `docs/` 内路径。图标名不在 `validate()` 里检查，`icon: "https://..."` 校验通过；拦截在 `iconLoader` 里，库自带的 loader 和 spike 的 loader 都用 `/^[a-z0-9][a-z0-9-]*$/`。

嵌入测试（`frame.mjs`）：宿主页带 operator 现在的 CSP 和 `X-Frame-Options: DENY`，记录全部请求、console 消息和对话框。

| 方式 | 字体 | 额外请求 | 脚本或对话框 | 点 https 链接 |
|---|---|---|---|---|
| `<iframe sandbox srcdoc=…>` | Inter、SpikeCJK 加载失败：继承的 operator CSP 是 `font-src 'self'`，拦截 `data:` 字体 | 无 | 无 | 父页 CSP 拦截导航，图被替换成 `chrome-error://chromewebdata/` |
| `<iframe sandbox src="/diagram.html">`，该路由的 CSP 为 `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` | 全部加载 | 无 | 无 | 同上 |
| `<img src="/diagram.svg">`（问题 6 的 SVG） | 由 SVG 内嵌 | 无 | 无 | 链接不可点 |

operator 现在给所有静态响应发 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`。iframe 方案需要一个响应头不同的新路由，这就是 PRD 写的那条例外。

跨引擎：HTML 的框宽在 Chromium 里测量。同一份 HTML 在 Firefox 157 里，三个连线标签换了行（`打开文档`、`validate()`、`render`）；WebKit 与 Chromium 一致。只有 PNG 在各引擎里一样。

结论：静态 HTML 满足「无脚本、无外部资源」。要成立为例外，还需要三个条件：独立路由及其响应头；字体内嵌；禁用 iframe 内的点击（例如 `pointer-events: none`）或在渲染前去掉 `href`。

## 问题 6：导出 SVG

库只导出 `png`、`html` 和 `json`。场景是 HTML 加 CSS 布局，连线和图标是内联 SVG，所以没有现成的纯矢量 SVG。

`tosvg.mjs` 在 Chromium 里打开内嵌字体的 HTML，克隆 `#eraser-scene`，删除 HTML 注释（注释里有 `--`，XML 不允许；第一次不删时解析失败），用 `XMLSerializer` 序列化，包进同尺寸的 `<svg><foreignObject>`。耗时 30–68 ms，大小与 HTML 相近（typical 866 KB）。

| 显示方式 | 与库 PNG 不同的像素（单通道差 > 16） |
|---|---|
| Chromium 157，`<img>`，typical / hostile / grid-100 | 0.012% / 0.006% / 0.017% |
| WebKit 27.2，`<img>`，typical | 3.27%（抗锯齿差异，布局一致） |
| Firefox 157，`<img>`，typical | 2.96%，三个标签换行不同，与 Firefox 打开原 HTML 的结果相同 |
| macOS Quick Look（`qlmanage -t`） | 正常显示 |

这个 SVG 里是 HTML，只有浏览器引擎能正确显示。librsvg、Inkscape、Figma 等工具没有测试。生成它要一次浏览器渲染：要么渲染时一起生成并保存，要么导出时再启动 Chromium。

它也是问题 5 的另一条路：显示路径与现有 Mermaid 图相同（SVG 作为 `<img>`，不执行脚本，不加载资源），不需要新路由，也不需要「不开原始 HTML」的例外。

## 其他观察

- HTML 字节在同一页面的多次渲染之间不稳定：遮罩 id 是页面级计数器（`eraser-connection-label-mask-0` 对 `-12`）。漂移检查和缓存键要用输入的哈希（图 JSON、库版本、字体、图标集），不能用输出的哈希。
- HTML 里的元素 id 就是作者写的实体 id；只在隔离的 iframe 或 `<img>` 里显示时不会冲突。
- 依赖：`@eraserlabs/diagrams` 带来 34 个包、25 MB，其中 `playwright-core` 13 MB，`ajv` 2.3 MB。
- 托管图标目录的 SVG 没有随包附带许可说明；目录里有第三方品牌图标。正式功能要换成许可明确的图标集。

## 建议：接入，附带约束

三个失败条件都不成立：只有渲染的一方需要浏览器，图标可完全本地，每次渲染用一个短命 worker 即可。下面的约束由 #2823–#2826 落实；做不到其中任何一条时，对应能力不进正式功能。

1. 只在图内容变化时渲染，用一次性 worker 进程，deadline 60 s。到期或失败时终止 Chromium 进程组，删除 worker 专用的 `TMPDIR`。浏览器崩溃后丢弃渲染器，不复用。不设常驻渲染服务。
2. 浏览器探测：用户配置的路径，其次 Windows 的 Edge、macOS 的 Chrome、Linux 的 chromium；都没有时显示「未安装渲染能力」和安装命令。可选安装项是 headless shell：比 Chrome 省一半内存，关闭快，SIGKILL 后不留孤儿进程。
3. 只用本地图标：选一个许可明确的图标集，loader 保留名字正则，`onUnknownIcon: 'error'`。
4. 字体随可选能力一起安装：OFL 中文字体，`throwOnFontFail: true`，HTML 和 SVG 产物内嵌字体。按图裁剪字体需要一个新的子集化依赖，要单独批准；不批准时，中文图只给 PNG。
5. 显示方式二选一，由 owner 决定：(a) 静态 HTML 放在沙箱 iframe 里，满足问题 5 的三个条件；(b) foreignObject SVG 作为 `<img>`，沿用 Mermaid 路径，不需要例外，同时就是导出格式。两种方式在 Firefox 里都有换行偏差，PNG 没有。
6. 产物是 JSON 代码块的投影，缓存键用输入哈希；Eraser JSON 仍不是架构来源。产物提交进仓库还是只放本机缓存，由 #2823 决定：只放缓存时，每台打开文档的机器都要渲染一次，等于每个读者都要装浏览器。
7. 锁定 0.5.2。密集图的耗时问题向上游提 issue，请求公开 `repair` 预算；在此之前不用内部接口绕过，超过 deadline 的图明确失败，提示改用 `straight` 连线或拆图。

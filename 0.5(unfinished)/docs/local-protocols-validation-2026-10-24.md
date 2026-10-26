# 用户自备协议端接入与图标独立设置

2026-10-24。实现不附带或下载 NapCat、SnowLuma、QQ 客户端；本次也没有执行这些第三方程序、登录真实 QQ 或代表用户接受任何协议。

## 用户流程

- 将完整发行版 ZIP 或完整解压目录放入项目的 `protocols/`；目录变化通过文件事件自动检测，不需要手工刷新页面。
- 「设置 → QQ 连接」显示包型、缺少的运行文件及账号配置。多个已有账号须选择其中一个；一次只托管一个协议端/账号。
- 明确点击“启动并连接”后，才解压 ZIP、备份并合并所选账号的 OneBot 服务、分配两个不同的本机端口及随机令牌，并写入 QQ-Agent 的连接设置。
- 原 ZIP 保留；解压缓存位于 QQ-Agent 数据目录的 `protocols/packages/`。不迁移 QQ 账号目录和登录态，不接管用户已运行的进程。
- 登录入口采用运行日志实际报告的本机地址；公开状态和 SSE 不含登录 URL 的 token。初始登录输出只保存在有大小上限的内存中，用户显式打开“启动输出”后才能读取。
- 自动启动默认关闭。启用后，下次启动 QQ-Agent 才自动运行已选择的包和账号。
- 完整包依赖、源码包/Lite/Shell 的限制见 [`protocols/README.md`](../protocols/README.md)。安装版目录位于可执行文件旁，可用 `QQ_AGENT_PROTOCOL_DIR` 自定义。

## 上游合同

以 2026-10-24 读到的上游源码及正式发行物结构为依据：

- [NapCat v4.18.41](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)：完整 Windows.Node 包直接使用包内 `node.exe index.js`；根据 [Node 入口](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-develop/index.js)与[发行组装](https://github.com/NapNeko/NapCatQQ/blob/main/.github/workflows/release-publish.yml)，验证 `wrapper.node`、`QQNT.dll`、`napcat/napcat.mjs` 等文件。已选账号通过上游的 `-q` 参数传入。配置为 `napcat/config/onebot11.json` 或账号文件，字段使用 `network/httpServers/websocketServers/enable/token`。
- [SnowLuma v2.1.1](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.1.1)：完整包使用包内 `node index.mjs`，校验发行元数据、当前系统的 native、SQLite、客户端资源等结构；[当前配置合同](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/config.ts)使用 `networks/httpServers/wsServers/enabled/accessToken`。保留账号 `mode:"snapshot"`，不覆盖其它连接。用户在其原生页面完成[协议/隐私确认](https://github.com/SnowLuma/SnowLuma/blob/main/packages/core/src/webui/consent.ts)、初始改密与 QQ 接入，不设置 `SNOWLUMA_ACCEPT_*` 或修改同意记录。

以上是结构与配置适配，不是对任意同名 ZIP 来源的认证，也不是上游提供的授权。源码 ZIP 需自行构建；不完整或不匹配的平台包不会被直接启动。

## 实现与边界

`runtime.localProtocols` 和 `console.localProtocols` 是可替换的启动组合组件。手动 OneBot 解析器仍只消费显式地址与令牌；本地管理器通过标准配置更新接入它，不改写协议模块的方法。

ZIP 使用流式解压与中央/本地目录一致性、CRC、路径、文件类型、数量和展开大小检查。解压目录与缓存每层都拒绝链接和路径逃逸。包内有实例租约，防止另一个 QQ-Agent 在运行中重写同一包的端口及令牌。停止只针对本应用持有的进程树；终止失败会保留占用状态，不能伪装停止后再启动另一进程。

若启动器自行退出，不能据此确认工作进程全部退出。此时保留 `uncertainTree` 标记并阻止再次启动，也不使用已经退出的旧 PID 执行终止命令。页面提示用户查看输出、确认并关闭遗留进程，再移开包内标记并重启 QQ-Agent；不会宣称已完整清理。

目录事件合并处理；日志、缓存、临时文件及锁事件不会触发包扫描。普通 GET 只读取快照；ZIP 检查按大小和修改时间缓存，运行中新建账号的配置事件会补充账号列表。

## 图标

「设置 → 外观 → 左上角图标」单独提供大小（20–64px，默认 36px）与速度（0.25–2×，默认 1×）。1× 的八阶段循环恰好一秒，每 125ms 变化一次。品牌尺寸与速度不再随其它图标的大小、动作幅度或速度变化。仍服从总动效开关、系统减少动态效果和后台暂停。设置使用原有自动保存与保存反馈。

## 验证

- `protocol-adapters-test.mjs`：两家目录/平台识别、账号选择、配置字段、保留原配置、备份、原子更新与互斥、坏 JSON 和链接拒绝通过。当前 Windows 没有创建文件符号链接的权限，该单项明确跳过；目录 junction 拒绝已实测。
- `local-protocol-manager-test.mjs`：26/26，通过目录/ZIP完整流程、缓存复用、来源 ZIP 保留、独立端口与令牌、启动/终止失败、启动中与运行中父进程先退出、停止期间父先退出但工作进程终止失败、共享包互斥、缓存祖先 junction、新账号发现及 ZIP 检查缓存等合成测试。
- `local-protocol-process-tree-test.mjs`：真实启动本项目自行生成的 launcher 和监听 worker；停止后两个进程均退出，端口释放。没有执行第三方运行时。
- `local-protocol-sse-test.mjs`：真实 `fs.watch → manager → bus → HTTP SSE → shell → iframe` 贯通；合成发行包约 1 秒在页面出现。NapCat 与 SnowLuma 均走真实新 API 配置流程，进程与终止器严格注入合成实现。输出通知未增加 ZIP 检查次数，空闲期间无周期 GET；SSE、公开快照和页面通知不含连接令牌或初始口令。
- 同一真实 HTTP 集成验证了未知包返回明确的 404、无效自启动值与损坏账号配置返回明确的 400；未知底层错误仍走原有 500 处理。
- `local-protocols-ui-test.mjs`、`local-protocol-pages-test.mjs`：账号选择、启动/停止、自动保存失败重试、输出窗口稳定、窄屏、离开清理，以及固定发行版入口、运行实例校验、拒绝任意 URL 和非设置页开页请求通过。
- `brand-emblem-personalization-test.mjs`：精确检查 0/124/125/249/250/875/999/1000ms 的实际 SVG 状态；独立大小/速度、自动保存、重开恢复、单项重置和最大尺寸布局通过。相关 `138`、`263`、`296`、`298` 回归通过。
- `291` 组合生命周期、`275` OneBot 重连、`293` 手动连接边界，以及 UI 相关 `52`、`151`、`294` 回归通过。

已有 `141` 布局测试仍在导航行高处报告 `48 !== 46`；上一轮已在隔离副本恢复旧立方体图标复现同样失败，未为本次功能修改该断言。本次是定向验证，未宣称整个历史测试集全部通过。

本机证据：`.qa-local/local-protocol-runtime-20261024/`、`.qa-local/local-protocol-sse-20261024/`、`.qa-local/local-protocols-ui-20261024/`。真实账号登录、上游首次确认和真实 QQ 收发没有在本次测试中完成。

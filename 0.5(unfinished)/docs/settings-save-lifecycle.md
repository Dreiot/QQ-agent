# 设置保存与离开窗口

## 2026-10-23 默认界面自动保存

默认设置界面采用整卡开关，以选中底色和勾选标记呈现状态，不显示“开启／关闭”状态文字。保留原生复选框或 `role=switch` 的键盘与辅助技术状态。外观、隐私与安全为独立分区；具体设置搜索可展开目标分组，外观配色使用色块预览。

普通字段继续使用下述 `FormState` 与宿主保存合同。回复频率、峰谷、已有搜索源、人设、模型名称、名单和凭据编辑通过 `ui/panels/settings/auto-save.js` 的有序队列自动提交各自现有事务。新增实体、导入和删除保留明确操作入口。队列不改变接口、CAS 比较、逐字段回执、权限或持久化策略。

只有写入得到确认且没有更新的待保存输入时，浮窗才显示“已保存”。失败保留输入并提供重试。切换面板先排空队列；有编辑的弹窗关闭时等待其队列，保存失败保留窗口。没有异步保存工作的旧弹窗仍保持同步清理语义。宿主令牌仍在宿主文档管理，自动写入后验证新凭据再更新连接，明文不会交给设置 iframe。

`test/293-settings-intuitive-autosave-test.mjs` 使用隔离内核、磁盘和浏览器验证实际写入、连续修改、拒绝与重试、关闭/切页、百分比换算、名单、人设、模型、主题撤销和宿主令牌。浏览器关页、进程退出和异常掉电仍遵循下文的保护及限制。

默认设置面板继续使用 700 ms 防抖和 `FormState` 字段版本队列。普通保存、切出设置面板、浏览器刷新/关页、Electron 显式退出各有不同的生命周期，不能把收到 `panel.flushed` 当成已经落盘。

## 默认能力与替换边界

`src/console/panel-metadata.js` 只为实际选中的默认设置入口、设置文件和共享资源均来自默认来源的界面签发 `saveLifecycle: {kind: 'settings-v1'}`，并用实际来源和内容生成 `stateOwner` / `stateGeneration`。替换任一默认设置或共享文件会撤销此合同；新增无关资源不会授予新权限，停用替换层后重新启动可恢复默认合同。用户 iframe 永远不能获得此合同。文件仍可通过组合层追加或替换。

`ui/panels/settings/save-lifecycle.js` 把最新合法普通设置 patch、递增版本、校验失败状态和手动原始名单的离开保护状态镜像到宿主。宿主把草稿保存在当前文档内存中，不把草稿或令牌写入浏览器存储，也不把令牌发给 iframe。`settings.saveState` / `settings.save` 是来源受限的固定合同，不接受 API 路径或认证参数。宿主与服务端均拒绝顶层 `__replace__` 和 `server` 的非对象、`token`、`__replace__` 形态；宿主令牌管理继续使用独立入口。

`POST /api/config/lifecycle` 与 `/api/config/lifecycle/open` 由宿主使用。普通 iframe 的 `api.request` 即使声明这两条白名单也会被硬拒绝。写入沿用普通 `POST /api/config` 的认证、字段/密钥守卫和写后副作用。独立默认 leaf `console.settingsSaveLifecycle` 检查当前来源代际和有界 lease/revision：同版同内容幂等，旧版不覆盖新版，同版异内容拒绝；不同 lease 的已接收异步写也按到达顺序串行，失败不推进版本。当前默认最多 64 个 lease、30 分钟空闲 TTL、单 patch 最多 1 MiB。未知、退休、过期、服务器重启后失效的旧票均拒绝写入，不会凭旧票重新建租约。

宿主先通过固定 `open` 端点领取服务端随机票。`sessionStorage` 的 `qq-agent.settings-save-lease.v1` 只含非敏感 `{lease, retired}`，不包含草稿、密钥或令牌。成功卸载面板或真实 `pagehide`（非 bfcache）同步标记旧票退休；取消 `beforeunload` 不退休。下一文档/面板开票时原子退休该旧票，因此在客户端门前被延迟、晚于新文档保存才到服务器的旧 keepalive 也会被拒绝。初次开票读取到 `retired:false` 时保留其它活窗口/复制标签页的票；自身续租始终退休自身旧票，不会错误退休另一活文档的票。迟到到已关闭实例的开票回执通过 `retireOnly` 退票，不覆盖其它新实例的存储记录。

## 普通切页与 Electron

默认 panel client 先执行 `onBeforeLeave`。设置的写入或原始名单保护失败时返回明确失败，宿主保留原 iframe、输入和请求；超时不再按旧的固定 1 秒视为成功。保存成功后才执行普通离开清理并发送带本次 `flushId` 的成功回执。来源替换/撤销仍可强制卸载旧权限范围，并提示未完成保存。

默认界面隐藏旧的原始 JSON 编辑器，以成员选择器管理屏蔽名单并自动保存。旧编辑器控制器仍保留独立的手动应用与离开保护合同，普通自动保存不会应用它的原始 JSON。

重置准备期会把宿主镜像标记为暂停写入，避免退出兜底重放备份前的草稿；失败后恢复原草稿保护。用户明确接受完整重置后，普通草稿被丢弃并立即清除宿主镜像，原始名单也不再阻止退出，且不会被自动应用。该边界另有真实临时服务器备份/accepted 回执与有头、无头 native 取消/退出验证。

默认单元因重置而取消后，只有宿主 `canRecoverDraft` 明确确认 failed 阶段，保存 controller 才允许继续处理普通配置草稿；来源、票据、令牌和字段守卫仍逐项执行。preparing/accepted 不恢复，`close` 或生命周期 `onStop` 后即使处于 failed 也永久拒绝，不能借此放活其它已取消的默认任务。

Electron 的托盘关闭仅隐藏窗口，保存可继续。显式退出、关闭且不进托盘、宿主刷新快捷键经窄 IPC 握手等待当前主窗口主文档完成 flush。回执绑定当前 WebContents、主 frame 和随机请求 ID；失败或超时保留窗口和内核。只有成功后才销毁窗口、停止内核并退出。握手不向 iframe 暴露通用 IPC。

## 浏览器刷新和关页

`beforeunload` 不能等待异步 iframe RPC。宿主使用已经镜像的最新版本，向固定端点发送带认证请求头的 `fetch(..., {keepalive:true})`；正常保存和兜底请求共享版本，避免迟到旧写覆盖新值。按 UTF-8 计算整个请求体，默认不超过 60 KiB，给浏览器约 64 KiB 的共享 keepalive 限额留出余量。不使用 URL token 或未鉴权 `sendBeacon`。

任何普通脏数据、校验失败或手动原始编辑都会请求浏览器原生离开确认。只有来源证明通过的默认设置 iframe 获得 `allow-scripts allow-modals`，其它 iframe 保持 `allow-scripts`；所有 iframe 仍是 opaque origin，没有 `allow-same-origin`。设置 iframe 自己的同步 dirty 检查因此可以在最后一次 postMessage 尚未抵达宿主时显示原生确认。这遵循 [WHATWG 的文档离开算法](https://html.spec.whatwg.org/multipage/browsing-the-web.html#prompt-to-unload-a-document)：必须没有 sandboxed modals 限制，并满足 sticky activation 等条件。浏览器要求用户先真实点击/操作页面才可能显示确认。

超限、已知失败、租约尚未就绪，或 `sessionStorage` 不可用时会明确提示先保存；存储不可用时禁用 keepalive，避免无法关联新旧文档的迟到写。取消离开后不销毁面板、SSE 或宿主状态，真正的清理在 `pagehide` 执行。

用户选择“仍然离开”后，keepalive 只提供尽力完成的机会。请求尚未被宿主看到、浏览器配额耗尽、操作系统杀进程、断电、网络或磁盘失败都不保证落盘；未收到成功回执不应显示为已保存。也不提供关页后秘密持久保存敏感草稿的行为。

## 验证

`node test/244-settings-save-lifecycle-test.mjs --http-only` 检查真实临时应用、认证 HTTP、磁盘原子写失败/恢复、来源组合和纯协议行为；去掉选项运行无头浏览器，`--headed` 运行有头浏览器。所有实例使用独立临时 UI/数据和随机 loopback 端口，禁用真实 QQ、模型、账号、已安装插件与外部请求。

浏览器基线是仅回退本次生命周期片的重构基线，保留当前默认 UI，恢复直接 RPC / `allSettled` 成功回执 / 1 秒退出等待 / 无同步离开保护；它不是完整原始版本快照。一次实际基线中，快速关页后的末尾输入未落盘，刷新则恰好保存成功，因此不能把所有旧离开路径都声称为已证明丢盘。基线和修复后的实际关闭、刷新、重开输入和 `config.json` 结果保存在独立 QA evidence 目录。最初缺少 `allow-modals` 的真实失败证据也单独保留。

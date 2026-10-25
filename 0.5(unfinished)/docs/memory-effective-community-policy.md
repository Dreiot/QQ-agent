# 记忆发现、提炼与写回的名单合同

2026-10-17。此文说明默认实现的处理边界；定向证据在 `.qa-local/v04-parity-20261016/memory243/`，不代表新一次全量验收。

## 来源与过滤

自动发现使用当前选中的 `community.client.getBlocklist()`，实际等待 Promise。合法空名单具有权威性，不再叠加本地 global 或重新扣豁免；缺能力、异常或无效结果才按 `globalBlocklist − communityExemptions` 回退。每次都叠加当前聊天的局部 blocklist。不会直接读取固定默认社区缓存或触发远程同步。

旧 develop 的 discovery 与新印象采样均未做 global 过滤。因此本修正既修复 v0.5 raw global 错排豁免成员的不一致，也主动补足旧扫描路径已存在的云端禁用后仍消费归档的缺口，不能统称为旧版已有而新版丢失的功能。

扫描继续保留 2000 条窗口、每成员最新 40 条模型采样、最低发言数、每轮上限、最近出现排序、唯一身份消歧、专用模型，以及 discoverMaxMembers=0 关闭发现的现有约束。

## 模型提案与宿主提交

自动与控制台手动请求共用 `createMemoryConsolidationAdapter`。宿主先读取本轮有效名单，过滤成员和归档，向当前 `memory.consolidate` 提供 `members` 与 `history` 数据副本。`history` 只含 senderId、senderName、text、ts；默认提炼器收到该 DTO 后不会重新读原始 store。

默认能力和可替换能力都只返回提案。适配器检查身份映射、条数、内容、发言依据及并发本地修改后，才写回 memory。每一项实际写入前重新读取同一来源的有效名单；刚被排除的成员保留原档，并报告本项失败。被排除的旧档不会被删掉，名称档也不会因过滤被隐式合并或删除。新追加的记忆不会被旧提案覆盖。持久化失败不会推进整理冷却。

`memory.consolidate` 公开 SDK 直调仍是提案接口，不执行适配器提交；未提供宿主 history 时默认提炼器仅使用其被声明允许读取的配置 fallback。完整的 selected-community 与写入保证属于共享宿主适配器路径。向 SDK 直接传入 history 不构成宿主已经执行名单验证的证明。

## 在途有效性与组合

宿主通过 `serviceLeaseOf(name, {signal})` 提供私有租约，返回 provider、signal、isValid 和 dispose；函数及带 consolidate 方法的对象均可使用。租约固定最初的所选 registration、服务 token 和权限 receipt，监听第一次失效后锁存取消，不能通过权限恢复、同对象重注册或 A→B→A 选中变化复活旧结果。来源被撤销后，旧任务不能重新领取权限或改走 fallback 提交。

自动发现使用独立生命周期 signal；等待期间会重新核对启用、模型、冷却和暂停状态。暂停或停止会取消尚未完成的发现，也会继续取消已交给共享适配器的本代任务。后台故障不把已完成的聊天会话改成失败。

运行期替换仍使用 capability 选择与服务生命周期；整体策略可以通过 `overrides/<layer>/composition.json` replace/wrap `core.orchestrator`，移除层或 enabled:false 后在新应用代恢复默认实现。`core.memory.consolidate` 是宿主共享请求入口；默认插件继续拥有可替换的 `memory.consolidate` 模型工作流。宿主租约、原始注册表和权限 receipt 不属于插件 SDK。

# QQ Agent 0.5：默认实现与追加式组合规格 v2.1

修订日期：2026-10-16。用户明确要求：前端、后端和核心业务均为默认项，用户追加文件即可替换。这一要求取代旧 DSH 架构中“内核页不可插件化”和“固定核心机制不可替换”的限制。未安装覆盖层时，产品继续满足既有行为规格。

设计参考：[DeepSeek Harness 官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。采用其启动组合、默认实现可替换、资源随实例撤销的原则；本项目不依赖 Cordis，也不声称实现相同 SDK。

## 1. 组合模型

正式启动入口 `src/server.js` 和 `electron/main.js` 均调用 `createApplication()`。启动顺序：

1. 扫描 `APP_ROOT/overrides/<层目录>/composition.json`；不会扫描市场下载的 `plugins/` 或 `skills/` 中的组合声明。
2. 校验全部层的版本、路径、依赖、UI 声明和包装链；在此之前不执行追加模块。
3. 默认组件 → 按 `order` 升序的覆盖层 → 调用方显式组件。相同 order 以目录名按字符序排序。逐目标解析替换或包装，保留每层其余独立贡献；不把整层判定为“输家”而停用。
4. 创建所选运行时、存储和业务对象，然后注册默认路由与追加路由，最后监听端口并启动业务。
5. 退出、启动失败和数据重置时，回收本代资源。删除覆盖层或将其 `enabled` 设为 false，下一次完整启动恢复下层或出厂默认。

状态仓、权限、会话循环和启动界面等属于**启动时绑定**：修改后应退出并重新启动程序。它们不会在运行中无协议地交换内存状态。现有普通插件/服务的热更新、权限撤销和代际检查继续有效。

每个应用实例对应一个组合代，停止后须创建新实例；修改模块及其依赖源码时应完整退出并重启进程，普通对象重建不承担 Node 依赖缓存的热更新。桌面会在 Chromium 打开缓存前解析同一启动计划，使用选中的人设读取、默认配置和待执行重置实现，并把原计划及生命周期交给正式应用，不能先调用固定默认项再加载覆盖层。

`createKernel()` 是使用同一组件表的同步底层装配函数，保留给测试或已解析组合的嵌入宿主；正式启动不得绕过 `createApplication()`。组件是否可替换取决于生产消费路径是否使用所选实现，而非仅在注册表中存在名称。

## 2. 文件格式

```text
overrides/
  20-my-setup/
    composition.json
    implementation.mjs
    routes.mjs
    ui/index.html
    ui/icons.js
```

```json
{
  "version": 1,
  "id": "my-setup",
  "order": 20,
  "enabled": true,
  "components": {
    "core.prompt.system": {
      "module": "./implementation.mjs",
      "export": "systemPrompt"
    }
  },
  "routes": [{ "id": "example", "module": "./routes.mjs" }],
  "ui": {
    "panels": [{
      "id": "sessions",
      "title": "我的会话页",
      "entry": "index.html",
      "assetRoot": "./ui",
      "permissions": [],
      "api": [{ "method": "GET", "path": "/api/sessions" }]
    }],
    "assets": { "panels/icons.js": "./ui/icons.js" }
  }
}
```

模块声明也可以简写为 `"./implementation.mjs"`，表示默认导出，组件 `mode` 默认为 `replace`。组件导出必须是函数，并遵守被替换实现的参数、返回值和生命周期约定。原 `version:1` 清单继续支持完整替换；需要 `mode:"wrap"` 的清单必须声明 `version:2`，使旧版程序明确拒绝新语义，避免将包装器误当成普通工厂。`host`、`defaults` 为保留层 id。清单版本与诊断 API 返回格式版本是独立契约。

`requires` 为此前已挂载层的 id 数组；缺失、禁用或排序在后面的依赖使启动失败。未知 schema 版本、重复层 id、非法路径和不可调用导出均报告错误，不静默降级。

最多 64 个启用层，单清单最多 64KiB。路径必须为本层目录内的普通文件/目录，不接受绝对路径、目录穿越、编码路径、符号链接或 junction。模块为 `.js/.mjs/.cjs`；建议 `.mjs` 避免包类型歧义。追加模块顶层只声明实现，副作用应在工厂或路由注册函数内创建并登记清理。

`node scripts/inspect-composition.mjs` 静态预检并显示实际选择、完整来源链、冲突决议和同优先级提示，不执行追加模块、不启动机器人。它不能代替启动时的导出/返回值校验。已启动的控制台可通过受鉴权的 `GET /api/composition` 读取相同逻辑归属；不返回模块路径、原生函数或路由配置。

CLI 显示磁盘上的下一次启动计划；HTTP 返回当前进程实际绑定的组合。修改文件后两者可以暂时不同，不能把尚未重启的磁盘计划标为已经生效。

## 2.1 重叠贡献的明确语义

例如 A 提供 X、Y，B 提供 X、Z：冲突只发生在 X；Y 继续由 A 提供，Z 继续由 B 提供。更高层覆盖 X 不会停用 A 的 Y。

- `replace`：只保留该目标最后一次完整替换及其后的包装；此前该目标的包装不再调用。其他目标不受影响。
- `wrap`：导出 `(previousFactory, {key, ownerId, previousOwnerId}) => nextFactory`。按层次逐个包装，结果必须为函数；不能包装一个没有下层实现的目标。包装阶段可以异步，但返回的构造器仍遵守原同步构造合同。
- 共同增强时由作者显式调用 previous；两个不兼容的完整函数或整页实现不能自动推断并融合其业务意图。
- 同层多个选中导出共用同一模块时，该模块会加载；被遮蔽的包装函数不会调用，但不能声称此模块完全不执行。模块顶层仍须无业务副作用。
- 禁用或移除一层后，新代重新计算每个目标；无需修改剩余层。若剩余层声明了已缺失的强依赖，则明确报错，不能伪装为独立可用。

包装服务的多个方法时，可使用 `src/kernel/composition-methods.js` 的 `wrapMethods(service, methods)`，保留下层的私有字段接收者、只读属性和未修改方法：

```js
import { wrapMethods } from '../../src/kernel/composition-methods.js';
export default previousFactory => options => wrapMethods(previousFactory(options), {
  recent(next, ...args) { return next(...args); }, // 可在调用前后增强，或有意不调用 next
  customFeature() { return '独立能力'; },        // 新增方法的 next 为 undefined
});
```

第二层只包装 `recent` 时，第一层的 `customFeature` 仍在；同一方法中是否继续调用下层，由包装器明确决定。辅助方法不会把两个完整替换自动合并。

## 3. 默认业务与基础服务

默认组件表为 `bundled/runtime-defaults/components.js` 的 `defaultComponents`。文件位于 `src/kernel/` 不意味着实现不可替换。所有下列组件都从同一张选择表获取：

| 类别 | 组件名 |
|---|---|
| 完整应用 | `runtime.kernel` |
| 配置与日志 | `runtime.config.defaults`、`runtime.config`、`runtime.logger`、`runtime.bus`、`runtime.persona.text` |
| 扩展机制 | `runtime.capability`、`runtime.permissions`、`runtime.tools`、`runtime.plugins`、`runtime.sdk`、`runtime.services`、`runtime.serviceFacade` |
| 基础服务 | `runtime.scheduler`、`runtime.storage`、`runtime.http`、`runtime.fetch`、`runtime.priceUpdates`、`runtime.instanceLock` |
| 重置和迁移 | `runtime.reset.complete`、`runtime.reset`、`runtime.migration.detect`、`runtime.migration.run` |
| 数据仓 | `data.messages`、`data.memory`、`data.sessions`、`data.usage`、`data.reminders`、`data.stickers` |
| 主业务链 | `core.ingest`、`core.send`、`core.orchestrator`、`core.agentRunner`、`llm.complete`、`llm.target` |
| 提示词 | `core.prompt.system`、`core.prompt.user`、`core.prompt.pastState`、`core.prompt.anchor`、`core.prompt.persona` |
| 业务策略 | `core.tools.bundle`、`core.media.forward`、`core.events`、`core.wake.resolve`、`core.memory.consolidate`、`core.text.plain`、`core.text.split`、`core.reply.rescue`、`core.tools.parseInline`、`core.session.retryable` |
| 控制台 | `console.routes`、`console.panels`、`console.panelRoutes`、`console.sse`、`console.usageCost`、`console.modelPrices`、`console.peakSchedule` |

每项函数签名与组件表所导出的具名默认函数一致。构造型组件的选项包含 `lifecycle`：`signal` 在本代关闭时中止，`onStop(fn)` 登记清理并返回撤销登记函数；清理按逆序执行，重复关闭只执行一次，一项失败仍继续清理其余项并报告错误。原实现已经拥有的 stop/close 方法仍按原合同执行；追加的独立资源应通过生命周期登记，避免重复释放。

默认装配在取得带有既定 `stop/close/stopAll` 合同的基础服务时，立即登记一次性清理，后续构造失败也会等待这些资源回收。数据重置保留 HTTP 与 SSE 以交付响应和诊断，最终退出时才释放。服务宿主停止时撤销自己订阅的配置、能力与总线监听，单独重启该宿主会重新绑定一次。配置、仓库和编排器的重置保护由宿主自己的 facade 承载，不改写所选实现；只读对象和带私有字段的实现均可使用相同接口。

协议事件交给所选 `core.events` 时附带提供者的 `signal` 与 `current()`。默认业务在名单查询之前捕获账号/提供者代际，异步返回后再核验；消息、拍一拍和自动媒体转发都保留该取消关系。提供者切换或停止后，旧事件不得写入或借新提供者发送。替换业务实现应沿用这两个上下文字段检查异步工作。

提示词、运行器及 LLM 的替换必须进入实际消息处理链及 SDK 调用；禁止保留对旧导入的生产旁路。默认仓替换必须同时服务消息入站、会话编排和控制台。出厂行为不要求第三方实现照搬，但实现必须保持其声明的接口合同。

`runtime.kernel` 可替换完整装配，最小接口是 `start()` 与 `stop()`；若使用原桌面外壳，还需提供其消费的版本、配置和管理接口。通常优先覆盖细粒度组件，避免为替换一个算法复制整套应用。

### 3.1 模型目标解析 `llm.target`

默认完成器在主调用上执行选中的`llm.target({messages, cfg, api, signal})`，支持同步或异步返回；显式overrides（例如记忆整理）及备选降级不调用它。返回`null`/`undefined`表示不改变目标，或返回部分API对象（`model`、`provider`、`baseUrl`、`apiKey`等）。带`pinned:true`的完整目标跳过账号池，防止已明确绑定的渠道被其他账号覆盖；该控制字段不进入最终API对象。自定义解析器若改变完整端点，应自行返回一致的provider/地址/Key并设置pinned，避免错误的池反馈归属。

出厂解析器保留旧的`api.visionModel`/`videoModel`字符串用法，未配渠道时沿用主端点/账号池。新增`api.visionProvider`、`api.videoProvider`可明确绑定专用渠道，同时选择该渠道的地址与密钥；同名模型不凭目录顺序猜渠道。空白视频模型回退到图片模型，视频模型有效时优先。指定的渠道不存在/地址非法会停止调用，不偷偷尝试其它备选端点；专用渠道无Key时也不会借用全局主Key。

解析器失败标为`MODEL_TARGET_INVALID`并停止候选重试。取消在进入异步解析器前生效，或在解析器等待期间立即结束上层等待，迟到结果不得继续发模型请求。追加实现仍是受信任原生代码，应尊重传入signal取消自身I/O；这不构成对其任意副作用的沙箱。替换方法与其他组件相同：追加文件并声明`components: {"llm.target": {"module":"./target.mjs","export":"target"}}`，无需修改默认完成器。188实际生产工厂、HTTP端点和停用后恢复验证该消费路径。

## 4. 后端接口与控制器

默认 `console.routes` 安装既有接口后，再依次运行 `composition.routes`。路由模块导出：

```js
export default function register(http, dependencies, config) {
  http.route('GET', '/api/example', () => ({ ok: true }));
  http.route('GET', '/api/sessions', () => ({ sessions: [] }), { replace: true });
  http.onDispose(() => { /* 清理订阅、连接等 */ });
  return () => { /* 可选清理 */ };
}
```

每条路由、每个注册作用域均有所有者与 disposer。默认不允许重复路径和可证明的匹配冲突；无法证明互斥的同方法正则路由也要求显式 `replace:true`。显式覆盖按最新注册优先，撤销后恢复前一处理器。部分注册失败时回滚该次组合并清理已登记资源；异步注册完成前不监听端口。

每个路由注册器拥有独立的子生命周期；`dependencies.lifecycle` 和 `http.onDispose` 的资源都归属该注册器。撤销、失败回滚或重置仅清理对应子作用域，不遗留到整台应用退出，也不提前清理其它注册器。父级取消传播给子级；撤销时移除父级监听与清理登记。

停止前先中止生命周期信号，避免等待取消的异步注册造成死锁。默认路由组合器的 disposer 提供 `quiesce()`：数据重置时撤销追加路由与其资源，恢复并保留默认状态/诊断接口，直到最终退出再释放。替换整个 `console.routes` 的模块可以实现同名 quiesce 阶段，并用共享生命周期登记独立业务资源。提示词预览与实际运行必须使用同一所选提示词构建器。

路由扩展继续经过默认 HTTP 的 token、Origin、请求体上限和重置状态检查。注册业务路由不等于替换 HTTP 安全层；有意替换 `runtime.http` 或 `runtime.permissions` 属于明确的原生可信启动组合。

## 5. 前端、页面与组件

`ui.panels` 按页面 id 替换或追加默认页。覆盖原会话、聊天、记忆、用量、技能、插件、设置、应用日志、社区页均无需修改宿主文件。默认清单仅为未覆盖时的回退。

页面由 `assetRoot` 整体提供，缺文件返回 404，不与默认页面资产拼接成半新半旧的实现。可信替换页使用显式 API 白名单；原 iframe、token 与 RPC 约束继续执行。可信设置页等保留相应页面角色，但普通 `ui.panel` 插件不能借相同 id、title 或 kind 冒充它们。

UI 根目录与显式单文件覆盖共同按层次裁决：新层完整页面/外壳会压住旧层针对该根的显式文件；同层或更新层的显式文件可以有意覆盖根内文件。所选文件缺失时返回 404，不能取出被压住的旧文件拼接。`shell/panels/x.js` 与 `panels/x.js` 是同一目标，规范化后冲突；同层重复别名拒绝。共享图标与另一个页面等独立目标仍保留。

`ui.shell` 替换整个外壳目录；`ui.assets` 替换单个外壳或共享组件文件：`shell/app.js` 对应 `/app.js`，`panels/icons.js` 对应 `/panels/icons.js`，`shell/index.html` 对应 `/` 与 `/index.html`。可替换图标、样式、动效和公共组件实现。`/api`、`/events` 和普通插件的 `/panels/u/` 命名空间不属于静态覆盖范围。

统一删除与重置的默认视觉通过 `panels/destructive-motion.js` 消费；仅追加
`ui.assets` 声明即可更换各页面、插件公共组件及宿主重置效果，不需替换
业务请求或确认状态。接口、资源上限、安全快照和实际追加验收见
[删除与重置动效](destructive-motion.md)。

服务资产时再次检查真实路径及符号链接，防止启动后换目录绕过范围。普通插件仍通过隔离 iframe 和自身工具 RPC 追加面板；追加式替换不要求向这些插件开放全局 DOM 或管理密钥。

## 6. 信任与数据连续性

启动组合能够替换权限引擎、存储乃至整个应用，因此与编辑程序代码具有相同信任等级。`overrides/` 是管理员主动部署原生模块的入口，不由在线市场安装器写入，也不从普通插件清单自动升级出权限。Node 插件和启动模块均不能被描述为原生代码沙箱。

更换存储实现应兼容既有数据或在模块中提供明确迁移；组合加载器不自动转换、删除或重置用户数据。测试只能使用独立临时目录、合成账号和被动传输，不应为验证可替换性启动真实 QQ、远端模型或公开投稿。

## 7. 验收条件

- 空覆盖层：既有功能与安全回归通过。
- 追加层：实际消息从所选入站、存储、编排、提示词、运行器、LLM、发送实现流过，能观察替换效果。
- 追加控制器：新增接口、显式接管默认接口、撤销恢复及失败回滚经过真实 HTTP 验证；未授权请求继续被拒绝。
- 追加 UI：内置页面、共享图标和外壳可替换；真实浏览器渲染；普通插件冒充失败；移除后恢复默认。
- 启动完整性：桌面与 headless 共用组合入口；依赖/路径/版本错误清晰失败；未选中的模块不执行。
- 生命周期：正常停止、启动失败、重置均撤销资源；旧代结果不得进入新代。
- 每个阶段保留真实测试输出，模拟验证不得宣称为真实账号联调或安装包验收。

相关回归：`170-composition-loader`、`171-core-composition`、`172-ui-composition`、`173-backend-composition`、`174-composed-application`、`175-desktop-composition`，以及完整 `npm test` 与 `npm run smoke`。`node test/172-ui-composition-test.mjs --browser --headed` 使用已安装浏览器验证有头页面替换，不下载浏览器。

重叠覆盖验收：`176-composition-conflicts`（48 种排列/子集、局部替换、包装、诊断）、`177-composition-ui-conflicts`（9 代 UI、文件缺失、实际浏览器）、`178-composition-route-conflicts`（全部移除顺序、资源归属、取消重入及安全闸）、`179-composition-overlap-runtime`（6 代真实核心消费和失败清理）。规则与实测记录见 `composition-overlap-evidence.md`。

## 8. 默认更新通知的替换与生命周期

2026-10-16起，版本检查沿用认证GET/api/update-check和所选runtime.priceUpdates，工厂接收实际应用version。自动启动/小时检查、单飞、关闭抑制与提示由默认shell/update-notice.js统一负责，Electron主进程不再另行请求固定版本站；无宿主页面不新建UI检查任务。设置默认settings/update-status.js只消费宿主状态和窄console.update动作，不另起轮询，不接收令牌或任意导航地址。

两份UI文件均可各自通过ui.assets追加替换；后台沿用runtime.priceUpdates或现有控制器替换机制。关闭、断网失败、恢复、迟到响应和释放义务属于所选默认实现合同，不要求普通市场插件获得宿主DOM权限。具体接口、F-014/R-62映射、验证范围及限制见[更新迁移记录](update-notice-migration.md)。

## 9. 默认刷新策略与事件读取

宿主与会话通过所选`panels/refresh-policy.js`消费`ui.refreshMs`，握手补发当前策略，动态配置不会重载页面或扩大面板配置权限。精确倒计时、记忆任务和日志流各自保持调度职责。`sessions/session-events.js`是可独立追加替换的默认只读事件合批策略；它合并列表校正、保留末次跟随ID，并清理隐藏/卸载时的调度。详情读取与旧请求隔离，不得阻塞列表和新选择。规范化边界、接口和真实覆盖证据见[刷新策略迁移](refresh-policy-migration.md)。

## 10. 核心择优迁移与字段事务

默认编排器恢复机械前缀归档、活跃开关、统一峰谷作用域及主动禁言闸；捆绑提醒恢复时刻边界。真实组件消费和追加覆盖验证见[核心迁移](core-behavior-parity.md)。记忆存储/视图继续使用data.memory和ui.assets，新增备注控制器由默认console.routes装配，可按原路由组合覆盖单一GET/PUT并保留其余处理器。普通市场面板不获得额外宿主权限，HTTP守卫仍逐请求执行。按UID同步事务、冲突、部分成功及尚未关闭的跨文件问题见[记忆迁移](memory-view-migration.md)。

`console.memberEditor({memory,config,memberNotes,publish})`返回get/put控制器，实际成员GET/PUT消费它；分步保存、双CAS及207部分回执属于默认合同，而非跨文件原子性承诺。`console.personaTemplates({config,personaText,publish})`返回list/create/remove控制器，实际模板路由消费它；personaText是所选工厂快照，删除使用稳定ID与目标revision。两者分别追加替换不改变其它默认控制器，仍经过同一HTTP安全守卫。人设策略与UI独立默认文件见[人设迁移](persona-template-migration.md)。

`console.personaByChat({config,store,resolvePersona,publish})`实际负责分会话人设list/get/put，逐字段版本和明确来源支持不相交变更合并。`llm.thinking({api,context,signal})`独立解析用户意图，所选方言负责输出请求参数，见[思考策略](thinking-policy-migration.md)。默认`web.images`能力由图搜工具实际消费，保留Baidu先、Bing失败或为空时后备的顺序，仍受权限与取消检查约束。

## 11. 首启策略和窄视图状态

`shell/startup-navigation.js`与`shell/panel-view-state.js`分别是可单文件替换的实际默认项。首启只在可信默认首页和有效配置快照下引导models/access；内存状态仅按可信UI来源/内容代际保存声明的窄键。后台元数据生成不提供客户端任意文件或存储访问，普通市场面板不能继承受信任UI的声明。来源变化撤销旧状态和默认能力；失败保留普通面板加载。具体合同与真实浏览器验证见[首启导航](startup-navigation.md)和[记忆视图](memory-view-migration.md)。

`shell/pause-controls.js`是可独立追加替换的暂停/恢复默认交互；`panels/selection-state.js`恢复会话/聊天的窄ID及follow状态，纳入共享资产来源摘要。所选`data.messages`提供宿主有界capture/strict标读合同，partial仅重试原失败范围，不增普通SDK权限。切换页面重读并校验所选ID，不保存正文或密钥；见[暂停和导航状态](pause-navigation-migration.md)。

默认关键词与名单控件的独立资产、分群离线候选见[设置迁移](settings-controls-migration.md)；共享提供者选择的响应提交时草稿保护见[选择刷新](capability-picker-refresh.md)。遥测继续作为telemetry.service所选生命周期服务，客户端wire合同、200项和保留的新累计语义见[遥测迁移](telemetry-parity-migration.md)。

## 12. 固定资源反馈草稿

`console.feedbackDraft({dataDir,lifecycle,publish})`返回同步get/put/remove，默认路由实际消费所选控制器。前端`community/feedback-draft-state.js`和`feedback-form.js`可分别追加替换；只有固定三项API，普通市场面板不获得任意宿主存储。版本化本机文件、墓碑、失败/冲突保留、确切发布版本清除及实际有头/无头证据见[反馈草稿](feedback-draft-migration.md)。

## 13. 文本物理计划、可选回复和表情同步

`core.text.plain(text)`及`core.text.split(text,limit)`是同步策略，默认发送队列和提醒实际消费所选实现。split须返回逐项字符串且拼接无损，不拆UTF-16代理对；0表示不拆分，1允许完整双单元码点。提醒先持久化prepared物理计划，失败只重试未发送后缀，不二次运行非幂等转换器。默认保留URL、标识符、CQ和字面量，不能把Markdown清理变成任意文本改写。回归227覆盖实际追加策略、一次准备、持久化失败、部分发送与取消；不承诺完整字素簇切分。

`core.reply.rescue({text,trigger,sent,api,capabilities,signal,timeoutMs,state,log})`为异步可替换默认项。默认无主动reply提供者时保持沉默；可选提供者只提出原句的`send_message`调用，仍走正常工具、权限、SDK、发送队列和归档。API引用只含非密钥字段。返回`{calls,valid,signal,dispose}`：valid检查来源owner/provider/version；signal须覆盖提供者失效与调用取消，dispose由runner在工具完成、拦截、异常或退出时调用，取消残留排队并释放监听。只有已经确认的物理发送保留记录，不假称能撤回开始执行的外部副作用。旧替换仅有calls/valid仍兼容，但追加实现应遵守此生命周期合同。真实无type的发送receipt与旧typed text均参与排重；队列短期去重不能代替整轮已发送排重。详细迁移及复现见[回复迁移](reply-provider-migration.md)。

`data.stickers`保留异步`syncFromQQ({force,signal})`接口，工具list与实际prompt均调用，构造应用自身不联网；原同步all/get/list保留。默认不再提供 QQ 收藏表情同步；相关能力可由用户安装的独立扩展提供，支持情况由扩展决定。默认合并受提供者版本、账号代、权限receipt和生命周期约束，不完整远端快照不能删掉缓存条目。降级返回缓存及明确状态，不因未连接阻断所有回复。追加data.stickers或qq.emoji-favorites仍通过真实消费者生效，见[表情迁移](sticker-sync-migration.md)。

默认inline策略按每次模型回复重选；现代`reply.local-policy`维持preflight，旧兼容声明映射到独立`reply.after-tool-batch`。租约包含owner/函数/注册版本及同步selection变更通知，覆盖等待、工具守卫和发送队列，pin A→B→A不复活旧提案。默认`runtime.capability`接受`subscribeSelection`宿主参数，实际kernel绑定config同步通知；无关配置保存不无条件撤销。批后只接收实际触发DTO与已确认回执，模型引用脱敏，见[回复阶段合同](reply-provider-lifecycle.md)。

## 14. 模型价格与峰谷窄事务

`console.modelPrices({config,publish})`负责认证GET/PUT `/api/model-price-overrides`，返回逐字段revision及行revision；PUT只改显式字段，删除使用行CAS。`console.peakSchedule({config,publish})`负责认证GET/PUT `/api/peak-schedule`，active和custom预设分别操作，保存custom不会隐式激活。两者是所选默认控制器，不旁路HTTP来源或令牌校验。价格参考沿用所选runtime.priceUpdates及实际console.usageCost resolver，不能把官方参考报价误写为自定义值。默认UI的model-prices、model-price-data、peak-presets和transaction-draft均可通过ui.assets追加替换；窄RAM快照是跨页恢复优化，不构成当前页面编辑数量限制。具体原子判定、64项分批部分成功、overflow失效和有头验证见[价格与峰谷迁移](model-price-peak-migration.md)。

## 15. 搜索默认协议与名单成员事务

`web.search`默认协议和宿主诊断共用`bundled/web-tools/search-policy.js`，只传递请求描述，不自带网络权限。`runtime.config.defaults`可追加替换各渠道默认值；工具继续消费所选`web.search`，停用恢复默认。完整网关endpoint、渠道请求宽度及最终输出预算分别处理，诊断的私网边界不因共享协议而扩大。具体保留/迁移裁决与远端验证限制见[搜索迁移](search-defaults-migration.md)。

`console.blocklistMembers({config,communityClient,resolveCommunity,selfId,publish})`实际处理GET/PUT `/api/blocklist-members`，按明确目标membership及来源版本提交。全局操作await前后检查实际选中客户端，不能把动态facade身份当稳定实例。默认community.client按当前云/本机/豁免计算有效集合，本机解除与重新屏蔽只修改明确目标；群成员窗口/UI资产仍可独立追加替换。15位UID、超预算明确拒绝和保留未选旧条目属于默认数据连续性合同。高级原始编辑现在使用独立三字段CAS，见下一节。

## 16. 原始名单、所选服务租约与最后保存

`console.blocklistRaw({config,publish})`实际处理认证GET/PUT `/api/blocklist-raw`。三个原始字段各自携带来源/revision，整批验证后一次原子写；普通POST `/api/config`拒绝这三个字段。默认UI仅在明确点击原始名单保存时应用，普通自动保存和离开前flush不会隐式改写整张名单。脏稿或冲突保留原输入与原版本；本机原始数组不等于云端replace。宿主专用`config.updateRawFields`保留未选择的历史元数据，SDK仍只提供原有、经绑定和权限检查的update方法。详见[原始名单事务](blocklist-raw-transaction.md)。

`runtime.serviceLease({services,capability,providerLease,bus,lifecycle})`返回宿主内部`serviceLeaseOf(name,{signal})`。租约绑定所选owner/定义/注册代际、实际实例、service token及原权限receipt，首次失效即取消，随后pin或权限A→B→A不得复活旧结果；get/provider和dispose不通过SDK公开。默认自动记忆发现、人工整理、筛选后的模型DTO与每次落档共用此边界。暂停/停止撤销发现代际，同一聊天的在途发现合并，忽略取消的提供者迟到结果不生效。具体合同与限制见[有效社区记忆策略](memory-effective-community-policy.md)。

`console.settingsSaveLifecycle({applyPatch,getIdentity,readConfig,lifecycle})`消费可信默认设置的来源摘要，负责固定认证POST `/api/config/lifecycle`的保存顺序和版本回执；实际落盘复用普通配置写入闭包及副作用。只有经过实际资源来源校验的默认设置获得宿主镜像，普通插件或替换UI不能凭同名元数据继承。宿主与服务端均保留原令牌管理限制。默认shell/settings-save-lifecycle、settings/save-lifecycle、panel-client及Electron退出握手均可由追加层替换，替换须自行负责保存生命周期。严格flush失败保留面板；真实unload受浏览器传输上限和用户离开选择约束，不承诺未确认写入已经持久化。见[设置保存生命周期](settings-save-lifecycle.md)。

本机自动认证仍由所选HTTP组件与宿主认证模块完成，普通API/SSE逐请求校验、来源守卫和opaque插件隔离不变；自动恢复不授予插件宿主令牌。见[本机认证](local-console-auth.md)。

## 17. 日志磁盘策略与会话展示叶子

`runtime.log.policy({dataDir,...})`是同步可选策略工厂，默认返回`diskLine(entry)`及`prepare({logsDir,now})`。kernel先选择该策略，再传入所选`runtime.logger({dataDir,policy,...})`，没有第二份固定logger。`null`明确关闭默认磁盘预算/启动整理；整体logger替换仍可不消费该策略。默认同步重入护栏、64KiB UTF-8新写JSONL预算、启动近期巨型文件尾部整理及失败/链接边界见[日志合同](logger-resilience-migration.md)。ring/bus继续保留原全文，普通SDK不获得策略对象。所选`runtime.config`损坏备份成功/失败的诚实诊断沿原load入口，见[配置诊断](config-corrupt-diagnostic-migration.md)。

`console.sessionNames({resolveSource,serviceLeaseOf,capability,bus,lifecycle,...})`返回`getNames(keys,{signal}):Promise<Map>`和`dispose()`，实际会话list/detail DTO消费它并增加`chatName`字符串。默认只读当前所选transport的目录/名称动作，来源包含service token、账号和可选opaque配置代；不落会话档案、不扩会话页读取聊天正文的权限。目录单飞、缓存、离线/失败退避与旧单名动作兼容见[群名展示](session-name-presentation-migration.md)。

`panels/sessions/chat-title.js`与`scroll-policy.js`分别导出名称格式化与同步capture/restore策略，实际默认会话页调用所选资产。追加文件可独立替换任一叶子，无需复制整页；删除或禁层后新实例恢复默认。滚动策略保留贴底条件与阅读锚点，不改变follow选择或JSON模式，见[滚动合同](session-detail-scroll-migration.md)。这些是新默认项，不是固定到外壳的新特权。

## 18. 用户自备协议端

`runtime.localProtocols({appRoot,dataDir,config,bus,env,...})` 同步返回本地协议端管理器，拥有 `start()`、`close()`、`scan()`、`snapshot()`、`launch(id,account?)`、`stop()`、`saveSettings(body)` 与只读 `output()`。默认实现见 `src/protocols/manager.js`，上游包识别和配置适配位于独立的 `src/protocols/adapters.js`。kernel 将它纳入所选组合的启动和一次性清理，不修改已经创建的传输模块。

`console.localProtocols(http,{localProtocols,...})` 注册对应设置 API；默认由所选 `console.routes` 调用，可独立替换。设置面板的声明只授予配置角色访问这些接口。普通扩展不会获得本地任意命令、路径或 PID 执行接口；启动目标只能是扫描到并重新核验的包 ID，停止目标只能是本应用持有的进程树。

协议端只来自用户自行放入的目录或 ZIP，QQ-Agent 不附带或下载第三方程序。手动 OneBot 地址/令牌合同保持独立，本地管理器在明确启动操作后通过配置仓更新连接。目录事件、进程状态和输出版本以 `local-protocols` 通知界面，公开通知不含启动明文、登录凭据或连接令牌。详见[接入与验收边界](local-protocols-validation-2026-10-24.md)。

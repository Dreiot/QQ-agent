# QQ Agent 0.5：给 AI 的扩展开发参考

本文是原生 0.5 普通扩展的自足合同，核对日期为 2026-10-21。先读本文，再复制 [完整范例](../examples/extensions/README.md)。旧版差异与尚未补齐的功能见 [0.4 能力对照](v04-extension-parity.md)。UI 的主题、图标和动效合同继续见 [公共 SDK](plugin-sdk.md#面板设计系统与动效2026-10-13)。

本手册覆盖新增文本工具、HTTP 查询、文生图并发送、事件观察、定时任务、自有面板，以及离线自检和打包。声明某个能力名不会让宿主自动执行它；没有消费者的新能力只供扩展之间主动调用。修改默认页面、原生窗口、核心执行器或整个应用，请使用独立的 [可信启动组合](architecture-composition.md)，普通社区包不含 `overrides/`。

## 1. 先选入口

| 用户需求 | 实现 | 触发方式 |
|---|---|---|
| 用户说一句话后查询、计算、生成 | `skills/<id>/skill.json`，`setup(ctx)` 注册工具 | 模型决定是否调用；description 要写清用途和场景 |
| 收到指定事件后统计、定时运行、适配能力 | `plugins/<id>/plugin.json`，同一套 SDK | 事件/定时器/能力消费者触发 |
| 给扩展增加界面 | 上述扩展的 `ui/` 和 `ctx.ui.panel.register()` | 用户打开面板，通过本扩展工具读写自己的数据 |

目录与 `kind` 表达用途，不是两套 API；两者都能注册工具、能力、钩子和面板。仅把代码放进 `plugins/` 不会使工具变成自动任务。

开发时在扫描目录以外生成完整目录，完成自检后再复制到对应位置。不要编辑出厂 `src/`、`bundled/`、`ui/`，不要读写用户真实 `data/` 或其它扩展。模块顶层只声明函数、常量和导出；联网、发送、定时、监听等由 SDK 管理。Node 插件是受信任原生代码，权限限制的是宿主 API，不是进程级沙箱。

实际安装目录必须为 `skills/<清单id>/` 或 `plugins/<清单id>/`，这样社区发布才能按 ID 找到本机源码。不要因为加载器允许其它目录名，就让制作结果只能加载却不能发布。

## 2. 最小完整技能

`skills/text-count/skill.json`：

```json
{
  "id": "text-count",
  "name": "文本字数",
  "version": "1.0.0",
  "kind": "skill",
  "apiVersion": 1,
  "entry": "index.js",
  "category": "utility",
  "description": "统计给定文本的 Unicode 字符数",
  "enabledByDefault": false,
  "permissions": [],
  "settings": { "includeWhitespace": false },
  "configSchema": {
    "includeWhitespace": { "type": "boolean", "label": "包含空白字符" }
  }
}
```

`skills/text-count/index.js`：

```js
export default {
  setup(ctx) {
    ctx.registerTool({
      id: 'count',
      name: '统计文本字数',
      description: '当用户要求统计给定文本的字数时使用；不会读取聊天历史。',
      category: 'query',
      params: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 20000, description: '需要统计的文本' } },
        required: ['text'], additionalProperties: false,
      },
      handler({ text }, execution) {
        execution.signal?.throwIfAborted();
        const input = ctx.config.get('includeWhitespace') ? text : text.replace(/\s/gu, '');
        return { content: `字符数：${Array.from(input).length}`, count: Array.from(input).length };
      },
    });
    ctx.log.info('文本字数技能已注册');
  },
};
```

工具最终 ID 是 `text-count__count`。`registerTool` 返回最终 ID；不要自己加前缀。设置通过控制台修改，在每次执行时读取，因此修改后不必重装。

## 3. 清单和入口

每个扩展只有一个清单。读取顺序是 `skill.json` 优先于 `plugin.json`，不要同时放两份。加载器只扫描 `skills/`、`plugins/` 的直接子目录；共享代码放自己目录内的 `lib/`，不要创建 `skills/shared/`。

| 字段 | 类型和默认值 | 合同 |
|---|---|---|
| `id` | string，建议必写 | 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`；为避免工具前缀截断冲突，使用独立小写 ID，尽量不超过 24 字符 |
| `name/version/description/author` | string；name 默认 id，version 默认 `0.0.0` | 面向用户的元信息，不是执行入口 |
| `kind` | `skill` 或 `plugin`，默认 skill | 与目录用途保持一致 |
| `apiVersion` | number，原生使用 `1` | 0.4 也用过 1，**它不能单独识别旧 API**；新代码不要加 compat 标记 |
| `entry` | string，默认 `index.js` | ESM 入口；必须在自身目录内，不能符号链接穿越 |
| `update` | object 或省略 | 在线更新来源：`{"type":"github","repo":"owner/repo","asset":"扩展名.zip"}`；按[在线更新发布说明](extension-online-updates.md)上传完整 Release 附件。无来源时保留本地重新加载 |
| `enabledByDefault` | boolean，默认 true | 范例设为 false，安装后由用户启用；已有用户开关优先 |
| `category` | `model/message/knowledge/media/utility`，默认 utility | 这是扩展分类；不是工具分类 |
| `permissions` | string[]，默认 `[]` | 所需宿主权限，见第 5 节；清单声明不是管理员授权 |
| `settings` | object，默认 `{}` | 自身配置默认值；**configSchema 中的 default 不会自动填充 settings** |
| `configSchema` | object，默认 `{}` | 配置字段、类型与 UI 元数据；每个设置键都应声明 |
| `requires` | string[]，默认 `[]` | 硬依赖的能力名；缺失时不激活。不要写扩展目录名代替能力名 |
| `capabilities` | string[]，默认 `[]` | 对外能力的说明元数据；还必须实际 registerCapability |
| `prompt` | `{sections:[...]}` 或 null | 静态提示片段，见第 10 节；不要使用旧 `{when,instruction,examples}` 形状 |
| `panels` | array，默认 `[]` | 可以声明面板；建议普通作者使用 setup 中的 ui.panel.register，避免重复注册 |
| `tools` | array，默认 `[]` | 说明元数据，不自动注册工具 |
| `deprecated` | boolean，默认 false | 弃用标记 |

支持 `export default { setup(ctx) { ... } }` 或具名 `export function setup(ctx) { ... }`。推荐前者。可以使用异步 setup，并等待面板等注册完成，但不要在 setup 阶段做模型调用、外部请求或向 QQ 发送消息。

原生 `setup` 分支不会自动读取同一对象/模块上的 `providers`、`hooks`，也不会在成功后自动调用 `activate` 或 `available`。在 setup 中显式 `ctx.registerCapability()`、`ctx.hooks.on()`、`ctx.scheduler.*()`，在工具中检查缺少的配置。`deactivate()`、`dispose()` 是可选清理入口，但推荐将清理登记到 `ctx.lifecycle.onStop()`；不要让清理依赖仍可用的旧 SDK。完整重载会建立新实例，旧闭包不能继续执行操作。

配置表单的当前合同如下，不要照搬 0.4 的 `type:'enum'/options` 或 `min/max`：

| schema 字段 | 类型与语义 |
|---|---|
| type | string/boolean/number/integer/object/array；对象和数组在设置页以 JSON 编辑 |
| label/description/placeholder | 面向用户的说明，不是默认值 |
| enum | JSON 值数组，生成下拉菜单且保存时校验；例如 `{"type":"string","enum":["small","large"]}` |
| minimum/maximum | 数字范围，UI 和后台均检查；整数使用 type:integer |
| secret:true | 自身 SDK 可读明文，面板/HTTP 返回掩码；密钥设置保存为空或******表示保留，清除需由宿主明确clearSecrets操作 |

后台基础验证不等于远端协议验证；地址格式、合法时间、业务范围仍在 handler 校验。用户修改设置会写入宿主自己的 skills[id].settings，AI 不直接改用户配置文件。

## 4. setup(ctx) 的完整公共表

| 成员 | 参数和结果 |
|---|---|
| `id/kind/bundled` | 当前扩展身份；普通用户扩展 bundled 为 false，不能自行变成默认插件 |
| `log.info/warn/error/debug(...values)` | 日志对象方法。**ctx.log(...) 是错误写法**，不要记录 API Key、配置全集或响应认证头 |
| `config.get(key)` | 同步返回 settings 默认值与已保存值合并后的自身字段；未在 schema 声明的键返回 undefined |
| `config.all()` | 自身设置快照；不要依赖 schema 外的键，配置可能包含自身密钥，不能直接返回给面板/模型 |
| `config.onChange(fn)` | 接收自身 schema 字段的快照；返回取消订阅函数；卸载时自动撤销 |
| `storage.get(key)/set(key,value)/delete(key)` | 同步 JSON KV；get 无值返回 undefined，set 返回 value，delete 返回 true。用于自身状态，不适合二进制大文件 |
| `storage.dir` | 本扩展持久化目录，首次使用 KV 时创建；不要从入口 import.meta.url 推导运行数据位置 |
| `registerTool(def)` | 返回已加前缀的工具 ID，见第 6 节 |
| `unregisterTool(finalId)` | 仅撤销自身工具，返回 boolean |
| `registerCapability(name, provider, options={})` | 注册函数或对象提供者；options 可用 `{default:true}` 标记回退。自定义接口由双方约定 |
| `unregisterCapability(name)` | 撤销自己在此名字下的注册 |
| `capability(name,...args)` | 函数提供者被调用，对象能力返回受控方法；公共宿主方法应 await；见第 9 节 |
| `hasCapability(name)` | 是否有活跃非空提供者；不代表已经获得方法权限或连接已可用 |
| `requireCapability(name)` | 缺失则抛错，可在 setup 中明确拒绝激活 |
| `isSkillActive(id)` | 当前扩展是否 active；不表示其所有外部服务已经就绪 |
| `hooks.on(name,fn)` | 登记本扩展钩子，见第 10 节 |
| `prompt.add(section)` | 登记静态片段，priority 最大 99 |
| `scheduler.every(ms,fn,{name})` | 定期执行，返回 `{stop()}`；不会等待前一次 Promise，需自行防重入 |
| `scheduler.at(Date 或 'HH:MM',fn,{name})` | Date 是一次性，字符串按宿主本地时区每天执行；返回 `{stop()}` |
| `events.on(name,fn)` | 订阅第 11 节白名单事件，返回 disposer；载荷是脱敏副本 |
| `events.emit(name,payload)` | 普通自定义事件不是公共总线入口；仅允许现有 `blocklist-sync` 特定业务，经其宿主权限处理。扩展间通信使用自定义 capability |
| `http.fetch(url,options={})` | await Fetch 风格 Response，需 net.outbound，见第 7 节 |
| `send(chatKey,segments,options={})` | await 受控发送队列回执，需 qq.send；这是**函数**，不是执行上下文中的 send 对象 |
| `lifecycle.signal` | 扩展实例停止时中止的 AbortSignal |
| `lifecycle.onStop(fn)` | 登记清理函数，返回可手动执行的幂等 disposer；不要依赖异步清理已经被宿主完整等待 |
| `permissions.status(scope)` | 查看宿主决定；状态不是授权凭据 |
| `permissions.request(scope,detail?)` | await `{decision:'allow'|'deny'|'ask',reason?}`；调用 API 时仍会重新检查 |
| `ui.panel.register({id?,title,entry?,size?})` | await `{id,dispose}`，需 ui.panel；entry 默认 index.html，相对于自己的 ui/，见第 12 节 |
| `registerTransport(def)` | 登记 managed transport.provider，原生传输实现合同见公共 SDK；不是调用现有 OneBot 的捷径 |

没有 `ctx.kernel`、`ctx.registry`、`ctx.loader`、`ctx.onebot`、`ctx.fetch`、`ctx.call` 或 `ctx.utils`。面板客户端另有 `ctx.call`，不要混淆。

## 5. 权限、错误与取消

| 权限 | 常见用途 |
|---|---|
| `net.outbound` | ctx.http、搜索、模型、媒体读取等网络操作；旧 web_fetch 被映射到它，新代码写 net.outbound |
| `qq.send` | ctx.send、execution.send、拍一拍、撤回及收藏表情写入 |
| `ui.panel` | 注册和访问自己的控制台面板 |
| `data.sessions.read` | 消息、会话、提醒、表情及部分传输查询 |
| `data.memory.read` | 读取长期记忆 |
| `fs.outsideNamespace` | 写公共业务数据仓、部分媒体文件读取等；不是读取其它用户秘密的许可 |
| `proc.exec`、`mcp.connect` | 外部 MCP 子进程和连接；按方法可能同时需要 |
| `fs.namespace`、`scheduler` | 自身 KV 与调度，普通扩展默认允许 |
| `net.raw` | 受控宿主 API 不开放授权；不能用来取得原始 socket |

工具的 `scopes` 是调用前的权限闸，清单的 permissions 是请求范围；需要联网/发送的工具应两处声明。实际 API 调用还会验证当前目录、代码指纹、实例和管理员决定，不能借提供者的授权。用户更新代码后可能需要重新授权。

执行时将 `execution.signal` 传给每一次 HTTP/发送调用；后台任务使用 `ctx.lifecycle.signal`。在读取大响应、等待和发送之间检查中止。配置、停用、撤权、热更等会使旧结果失效。普通 Promise 竞争超时不能强制停止任意 JavaScript；工具执行器当前 30 秒超时不保证中止所有扩展自建工作，因此扩展自己的较短超时和 signal 处理仍然必要。

运行错误可以抛 Error（宿主工具层返回 `{ok:false,error}`），或者返回可序列化业务失败 `{content:'可读错误',isError:true}`。不要向用户返回完整远端响应、堆栈、认证头或请求配置。可以把可恢复业务错误作为结果，取消应继续抛出：

```js
try {
  // await ctx.http.fetch(..., { signal: execution.signal })
} catch (error) {
  if (execution.signal?.aborted || ctx.lifecycle.signal.aborted) throw error;
  ctx.log.warn('查询失败');
  return { content: '查询服务暂时不可用，请稍后再试。', isError: true };
}
```

## 6. 工具定义与执行上下文

```js
ctx.registerTool({
  id: 'lookup', name: '查询条目', description: '当用户要查某条目的资料时使用。',
  category: 'query', scopes: ['net.outbound'],
  params: {
    type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['query'], additionalProperties: false,
  },
  async handler(args, execution) { return { content: args.query }; },
});
```

`id` 可省略，此时 `name` 同时用作本地标识；推荐显式给短英文 id，name 给中文显示名。工具 ID 的前缀 sanitize 后最长 24 字符，本地 ID 最长 38 字符，总长最长 64；不要靠截断区别两个工具。`description` 决定模型何时调用；`params` 是 JSON Schema。`execute(args,execution)` 可作为 handler 的同义写法，**不是 0.4 的 execute(ctx,args)**。两者同时存在时 execute 优先，不要同时写。

支持的参数检查：required、type（含 integer/array/object/null、类型数组）、enum、minimum/maximum、minLength/maxLength、minItems/maxItems、嵌套 properties/items、additionalProperties:false，最大深度 12；不是完整 JSON Schema 引擎，正则等其它约束由 handler 校验。另有工具级 `requires` 能力数组、`defaultEnabled`、`requiresVision`、`requiresSearch`，不要把能生成图片误写成 requiresVision（后者表示输入视觉能力）。

| `execution` 字段 | 合同 |
|---|---|
| `chatKey` | 聊天触发时 `group:群号` 或 `private:QQ号`；面板或合成调用可能为空，发送前检查。`group_群号` 是部分控制台路径/磁盘文件名，不是这里的键 |
| `signal` | 本次调用 AbortSignal，传给受控副作用；允许不存在 |
| `botName` | 配置的人设名字，可能不存在，不是 QQ 登录昵称 |
| `session` | 脱敏会话副本，可能没有；不能通过修改它控制宿主运行 |
| `cfg` | 自身设置的脱敏快照，敏感值可能被移除；读取自己的密钥请使用 setup 闭包中的 ctx.config.get |
| `send` | core.send 方法对象：sendTextBatch/sendImage/sendSticker/sendSegments/poke |
| `store/memory/stickers/reminders` | 对应受控数据能力，公共方法见第 9 节；普通扩展方法均应 await |
| `mediaReader` | media.reader 的 image/imageParts/probe/framesAvailable |
| `transport.actions` | 第 9 节中的归一化动作；没有 call、client、selfId、任意 OneBot 操作 |

执行上下文没有 `log`、`sender`、`kind`、`chatId`、`selfId`、`onebot`、`emit`、`videoReader`；日志和配置用 setup 闭包中的 ctx。需要群/私聊信息时解析 chatKey，但不要对未知平台键作 QQ 假设。

handler 返回字符串或可 JSON 序列化对象；推荐 `{content:'给模型的结果', ...结构化字段}`。返回值不会自动发给 QQ。要发图片等媒体，必须显式发送并核对回执，文本结果由模型决定是否复述。不要返回 Buffer、循环对象、密钥或完整图片 base64 给模型。

自检/面板工具调用看到的是两层结果：成功执行返回 `{ok:true,result:handler返回值}`；校验、权限、异常、超时失败返回 `{ok:false,error}`。handler 的 `{ok:false}` 或 `{isError:true}` 仍在 result 层，不会自动把外层 ok 改成 false。

## 7. HTTP：完整请求合同

`await ctx.http.fetch(url, {method='GET',headers,body,signal,maxBytes,timeoutMs,redirect})`。使用标准字符串 URL、headers 对象和 JSON.stringify(body)。默认 maxBytes 5 MiB、timeoutMs 15000，redirect:'manual' 禁止自动跟随。返回标准风格 `ok/status/headers` 与 `text()/json()/arrayBuffer()`，额外 `url/redirected/truncated`；响应体只能消费一次。HTTP 4xx/5xx 不是成功结果，先检查 response.ok；截断响应也应拒绝。超时、网络、DNS、安全策略或取消会抛错。默认限制回环/私网、非 HTTP(S) 和危险重定向；不要换用全局 fetch 绕过。localhost 桩由离线自检注入，不能据此宣称生产允许内网地址。

完整示例：[http-query](../examples/extensions/http-query/README.md)。关键逻辑：

```js
// 清单 permissions、工具 scopes 都包含 net.outbound；schema 声明 endpoint/apiKey。
async function lookup(ctx, execution, query) {
  const endpoint = String(ctx.config.get('endpoint') || '').trim();
  if (!endpoint) return { content: '请先在技能设置中填写接口地址。', isError: true };
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  const response = await ctx.http.fetch(url.href, {
    headers: { accept: 'application/json' }, signal: execution.signal,
    timeoutMs: 8000, maxBytes: 256 * 1024,
  });
  if (!response.ok || response.truncated) return { content: `查询失败（HTTP ${response.status}）。`, isError: true };
  const data = await response.json();
  execution.signal?.throwIfAborted();
  if (typeof data.answer !== 'string') return { content: '服务返回了不支持的数据格式。', isError: true };
  return { content: data.answer.slice(0, 6000) };
}
```

API 密钥用 `configSchema: {apiKey:{type:'string',secret:true}}`，`settings.apiKey` 留空。运行时从 ctx.config.get 取，并只放在目标服务要求的认证头里，不写入 URL、日志或工具输出。

## 8. 发送文本、图片和消息段

普通工具使用 `execution.send`；后台用 `ctx.send(chatKey,segments,{signal:ctx.lifecycle.signal})` 或 `ctx.capability('core.send')`。所有方法都需 qq.send。

| 方法 | 参数 | 成功值 |
|---|---|---|
| `sendTextBatch(chatKey,texts,options={})` | texts 为字符串或字符串数组；options 可为 signal、replyToMessageId、atUserId | 统一发送回执 |
| `sendImage(chatKey,image,options={})` | image 为 `{url?,file?,dataUrl?,base64?}`；options 同上，另有 note（最多 500 字符） | 统一发送回执 |
| `sendSticker(chatKey,sticker,options={})` | sticker 至少有 localPath、fileId、url 之一，可有 id；使用宿主已有表情对象 | 统一发送回执 |
| `sendSegments(chatKey,segments,options={})` | 非空扁平段数组；不传原始 CQ 码 | 统一发送回执 |
| `poke(chatKey,{groupId?,userId})` | 群内填写 userId，groupId 可由 chatKey 推导 | 传输动作结果，默认 OneBot 返回 true，失败抛错 |

统一回执是 `{ok,sent:[{index,text,msgId,at}],failed:[{index,text,error}],aborted?,deduped?,note?}`。`ok:false` 可能已经部分发送，**不能整批无脑重试**；无消息成功时可能直接抛 Error。`ok:true,sent:[],deduped:true` 表示刚发过而跳过，不能报告“新发送成功”。msgId 来自协议确认，不是传给工具的会话 ID。队列拥有串行、限频、文本转换和成功后去重。

图片优先 URL → file → 已提供的 base64/dataUrl，网络图失败不会自动凭空得到 base64。dataUrl 必须为 `data:image/png;base64,...` 这类 base64 编码；裸 base64 也可传 base64 字段，回退上限为解码后 15 MiB。不要把 base64 放 file 字段；file 是本机文件路径，路径应来自自己的受控数据，不是模型任意参数。简单文生图直接把 API 的 b64_json 转成 dataUrl，避免落盘。

```js
// 完整 manifest、参数、HTTP 桩和回归用例见 image-generate 范例。
const payload = await response.json();
const b64 = payload.data?.[0]?.b64_json;
if (typeof b64 !== 'string' || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
  throw new Error('生成服务没有返回有效的 base64 图片');
}
if (Buffer.byteLength(b64, 'base64') > 10 * 1024 * 1024) throw new Error('生成图片过大');
if (!execution.chatKey) throw new Error('当前调用没有聊天目标，请从聊天中使用此工具');
execution.signal?.throwIfAborted();
const receipt = await execution.send.sendImage(execution.chatKey,
  { dataUrl: `data:image/png;base64,${b64}` }, { signal: execution.signal, note: 'AI 绘图' });
if (!receipt.ok) throw new Error('图片未完整发送');
return receipt.deduped
  ? { content: '图片刚刚发送过，本次没有重复发送。', deduped: true }
  : { content: '图片已发送。', sentCount: receipt.sent.length };
```

默认 OneBot 支持的常用扁平段：`{type:'text',text}`、`{type:'at',id:'QQ号'|'all'}`、`{type:'face',id}`、`{type:'image',url|file}`、`{type:'record',url|file}`、`{type:'video',url|file}`、`{type:'reply',id}`、`{type:'json',data:'JSON字符串'}`、`{type:'forward',id:'资源ID'}`。具体平台能力和文件段字段由传输提供者决定；不要从 0.4 的“全部原始 OneBot 消息段”推导任何段必可发送。

## 9. 能力：用法、可用性和公共方法

```js
// 提供：清单 capabilities 也写 text.reverse。
ctx.registerCapability('text.reverse', ({ text = '' } = {}) => Array.from(text).reverse().join(''));
// 使用：自定义能力没有消费者时不会自动触发。
if (ctx.hasCapability('text.reverse')) {
  const reversed = await ctx.capability('text.reverse', { text: '你好' });
}
// 宿主对象能力：不要在 setup 中立即调用 loading 状态的自身/未启动服务。
const send = ctx.capability('core.send');
const receipt = await send.sendTextBatch(execution.chatKey, '完成', { signal: execution.signal });
```

函数能力用 `ctx.capability(name,...args)`；对象能力先获取对象再 await 方法。普通宿主 facade 可能存在但方法目标尚未就绪，调用会明确抛错；hasCapability 为真也不保证配置齐全、权限已批或网络可达。缺失的自定义能力可得到 undefined，写软依赖必须给回退；硬依赖使用 manifest.requires/工具 requires。单提供者优先活跃非 default，管理员可指定 owner；同优先级保持注册顺序。多提供者的 `llm.request-params/llm.response/llm.usage/llm.retry-advisor/tool.guard/media.download` 由宿主按各自链式/认领合同消费，普通 ctx.capability 不等于“调用全部”。

常用宿主方法如下，普通扩展一律 await。返回对象为脱敏副本；未列方法不可访问。

| 能力 / 上下文别名 | 公共方法 | 权限 |
|---|---|---|
| `data.messages` / execution.store | recent(chatKey,n=500,options={forContext?,resolveReplies?}) → 消息数组；findByMid(chatKey,mid,options?) → 消息或 null；updateByMid(chatKey,mid,patch) → 消息或 null；listChats() → `{chatKey,lastActive,lastText,unread,count}[]` | 读 data.sessions.read；updateByMid 为 fs.outsideNamespace。recent 第二参是数字，**不是 0.4 的 {limit,before}** |
| `data.memory` / execution.memory | append/remove/query/stats/markConsolidated/lastConsolidatedAt/replaceMember/removeMember/clearChat/listFiles | query/stats/lastConsolidatedAt/listFiles 为 data.memory.read，写为 fs.outsideNamespace；不能把旧仓方法直接搬过来 |
| `data.sessions` | create/update/finish/peek/get/current/running/listSummaries/todayUsage | 读 data.sessions.read，写 fs.outsideNamespace；得到的副本不能控制正在运行的主 Agent |
| `data.reminders` / execution.reminders | add({chatKey,text,dueAt,createdBy?}) → entry；pending(chatKey?)、due(nowMs?) → entry[]；cancel(id)、markFired(id)、updatePendingTexts(id,texts) → boolean；prune | 查询 data.sessions.read，写 fs.outsideNamespace；dueAt 为毫秒时间戳；本扩展简单定时优先 scheduler |
| `data.stickers` / execution.stickers | all/get/list/note/markUsed/collect/mergeFromQQ/controlledLocal/ensureSendable/collectIntoQQ/syncFromQQ | 常规读 data.sessions.read，常规写 fs.outsideNamespace；ensureSendable 为 net.outbound，collectIntoQQ 为 qq.send+net.outbound，syncFromQQ 为 data.sessions.read+net.outbound |
| `core.send` / execution.send | 第 8 节全部方法 | qq.send |
| `transport.actions` / execution.transport.actions | 下表 | 逐方法，见下表 |
| `media.reader` / execution.mediaReader | image/imageParts/probe/framesAvailable | net.outbound；访问指定本地绝对路径/localRoots 还需 fs.outsideNamespace |
| `web.search` | search(query,options)、fetchPage(url,options)、lockState() | 前两项 net.outbound；lockState fs.namespace |
| `llm.client` | complete(options) | net.outbound；使用宿主已选渠道配置，不能传任意 Key/端点接管宿主凭据。普通外部 API 直接用自己的 ctx.http |
| `host.environment` | version/profile 只读元信息 | 普通扩展没有 appRoot/dataDir/进程环境 |
| `host.config` | get()/onChange(fn) | 普通扩展仅自身 schema 设置；没有全局 update |
| `extensions.state` | isActive(id)/isEnabled(id) | fs.namespace；videoFrames 只给具名默认服务 |
| `tools.catalog` | list() | fs.namespace；只读清单，不能执行其它扩展的工具 |

数据业务的完整内部写入形状随业务仓而异；上述列表**不授权 AI 猜测未展开方法的参数**。本手册的常见技能不依赖这些高级写入；需要它们时使用专门业务范例或补充明确合同与测试。旧仓全量对象、任意模型循环启动/恢复服务、任意工具执行器不是当前公共 SDK。

默认 OneBot 下的动作参数、返回与范围：

| 方法 | 返回 | scope |
|---|---|---|
| `listGroups({signal?})`、`listFriends({signal?})` | `[{id:string,name:string}]` | data.sessions.read |
| `getChatInfo(chatKey)` | 协议群/陌生人信息 data，字段由协议端决定 | data.sessions.read |
| `getMembers(groupId)` | 协议成员 data 数组 | data.sessions.read |
| `getGroupMembers(groupId)` | `[{userId,nickname,card}]` | data.sessions.read |
| `getGroupMemberInfo(groupId,userId,{signal?})` | `{userId,card,nickname}` 或 null，验证返回身份与当前账号 | data.sessions.read + net.outbound |
| `getGroupName(chatKey,{signal?})` | string | data.sessions.read |
| `getForward(messageId)` | 合并转发 data | data.sessions.read |
| `getImage(file)`、`getVideo(file)`、`getFile(file)`、`getRecord(file)` | 协议媒体 data；getRecord 要求 mp3 | data.sessions.read |
| `fetchCustomFaces(count=48)` | string[] | data.sessions.read |
| `fetchCustomFaceDetails({limit=100,signal?})` | `{entries:[{id,emojiId,resId,qqFile,url,md5,desc}],complete:false}` | data.sessions.read + net.outbound |
| `addCustomFace(file)` | `{emojiId:string}`，必须协议确认 | qq.send |
| `modifyCustomFace(emojiId,desc)`、`deleteCustomFace(emojiId)` | `{ok:boolean}`，必须检查 ok | qq.send |
| `poke(chatKey,{groupId?,userId})`、`recall(messageId)` | 默认 poke 返回 true；recall 成功返回 undefined | qq.send |

这里没有 `call('set_group_ban',...)` 或登录身份查询。并非所有旧 OneBot 功能都已映射，详见对照表。部分旧式查询实现没有自己的 signal 参数，facade 会使取消后的消费者拒绝并丢弃旧结果，但不能宣称底层远端请求均被强制中断。

还有 `market.client`、`community.client`、`memory.consolidate`、`process.mcp`、`mcp.tools` 等专用服务，权限范围见 [公共 SDK](plugin-sdk.md#公开能力面)。不要用市场接口在普通技能 setup 中自动发布/安装；发布凭据只由宿主管理。`mcp.service/reminders.service/telemetry.service` 的生命周期仅归宿主，扩展不可调用它们 create/start/stop。

## 10. 提示词与钩子

静态提示词清单：`"prompt":{"sections":[{"id":"usage","title":"使用说明","content":"需要统计文本时使用本技能的 count 工具。","priority":40}]}`。也可 `ctx.prompt.add({...})`，同一片段选择一个来源避免重复。priority 越高越靠前，上限 99，不可试图覆盖核心安全提示。动态 `promptSections(context)` 可作为入口导出，返回片段数组；它不会创建一个工具。

原生注册方式：

```js
ctx.hooks.on('before-tool', ({ toolName, args, signal }) => {
  signal?.throwIfAborted();
  if (toolName === 'my_skill__run' && args?.dangerous === true) {
    return { block: true, reason: '此扩展未启用该操作' };
  }
});
```

| hook | 额外字段 | 生效语义 |
|---|---|---|
| before-context | triggerEntries/messages/context（视调用入口而定） | 对受控副本的变更在回调成功且仍当前时提交 |
| before-llm-messages | messages | 对 messages 的原地修改提交给模型 |
| after-response | response | 观察脱敏响应，普通 hook 不能靠修改副本改写宿主响应；要改写用对应 llm.response 能力 |
| before-tool | toolName/argsRaw/args（按入口可有） | 返回 `{block:true,reason}` 可否决；异常记录但通常不阻断工具 |
| after-tool | toolName/argsRaw/result | 观察结果；result 可能是字符串，不要假设固定业务对象 |

公共字段是第 6 节的受控上下文。每个回调当前有 5 秒边界，结束/超时后旧视图失效。hook 保持短小，不在这里自建长时间请求/重试循环；异步业务应放工具或受控后台任务。标准能力 `tool.guard` 返回 `{block:true,reason}` 才能阻止工具，不能照旧文档猜测 `false` 或 `{ok:false}` 即阻止。

## 11. 完整事件与定时插件

以下插件只统计消息并定时写自己的 KV，不发送 QQ、不联网；不会把用户消息复制到日志。

`plugins/activity-meter/plugin.json`：

```json
{
  "id":"activity-meter","name":"本机活动计数","version":"1.0.0",
  "kind":"plugin","apiVersion":1,"entry":"index.js","category":"utility",
  "enabledByDefault":false,"permissions":[],
  "settings":{"intervalMs":60000},
  "configSchema":{"intervalMs":{"type":"number","label":"快照间隔（毫秒）","minimum":1000,"maximum":3600000}}
}
```

`index.js`：

```js
export default {
  setup(ctx) {
    let count = Number(ctx.storage.get('count')) || 0;
    let timer;
    const snapshot = () => { if (!ctx.lifecycle.signal.aborted) ctx.storage.set('count', count); };
    ctx.events.on('message.in', () => { count += 1; });
    const reschedule = () => {
      timer?.stop();
      const ms = Math.max(1000, Math.min(3600000, Number(ctx.config.get('intervalMs')) || 60000));
      timer = ctx.scheduler.every(ms, snapshot, { name: 'count-snapshot' });
    };
    reschedule();
    ctx.config.onChange(reschedule);
    ctx.registerTool({
      id: 'count', name: '读取本机活动计数', description: '读取此插件启动以来累计保存的消息事件计数。',
      params: { type: 'object', properties: {}, additionalProperties: false },
      handler() { snapshot(); return { content: `累计消息事件：${count}`, count }; },
    });
    // SDK 自动撤销 events/config/timer；自己的额外资源仍须登记清理。
    ctx.lifecycle.onStop(() => { timer?.stop(); });
  },
};
```

计数示例按间隔保存，强制退出可能丢失最后一个间隔，不是持久化审计系统。不要在 onStop 中依赖已失效 ctx.storage 来补写。需要不丢的计数，在事件回调同步持久化并评估频率。

可订阅事件完整白名单：`log/server.ready/plugin.loaded/plugin.unloaded/message.in/session.start/session.update/session.end/chat.update/onebot.status/transport.status/reminder.fire/feedback`。未知/禁止事件只返回空 disposer 并记录日志，不会替你建立监听。载荷随事件变化，不能从名字推导含原始协议事件、密钥或全量仓对象。message.in 可用于计数等观察；需要改写消息用对应 hook/能力。总线不 await 异步监听器，异步工作必须自行 `.catch()`，同时检查生命周期 signal。

`scheduler.every` 不串行 async 回调；联网轮询采用 `if (busy) return; busy=true; try {...} finally {busy=false}`，每次用 lifecycle.signal。`at('09:00',...)` 只在进程运行期间按宿主本地时间调度，退出期间不会补发，不是持久提醒；HH 应为 00–23，MM 为 00–59，由作者校验后传入。定时回调没有 execution.chatKey，目标必须来自自身用户设置，不可假定“当前群”。

## 12. 完整自有面板

面板是 opaque-origin 沙箱 iframe，不能读宿主 DOM、本地存储或控制台令牌，也不能访问任意后台 API。普通面板仅 `ctx.call`（自身工具）、`ctx.getConfig`（自身脱敏配置）、`ctx.notify`。不要复制默认 bundled 面板里的 request/api.request 用法。

在第 2 节 text-count 清单 permissions 加 `ui.panel`，在 setup 中加入：

```js
await ctx.ui.panel.register({ id: 'text_count_panel', title: '文本统计', entry: 'index.html' });
```

此处 setup 必须改成 `async setup(ctx)`。`entry` 相对于自身 ui/，不要写 ui/index.html、../、绝对路径、query 或 hash；资源与入口都放 ui/ 内。size 是可选展示元信息，通常省略。id 只用 `[A-Za-z0-9_-]`，不与其它面板重名。停用/卸载/热更会撤销本代面板及资源地址。

`ui/index.html`：

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>文本统计</title><link rel="stylesheet" href="/panels/common.css">
</head><body><main class="card">
<label for="text">待统计文本</label><textarea id="text" maxlength="20000"></textarea>
<button id="run" type="button">统计</button><pre id="result" aria-live="polite"></pre>
</main><script type="module" src="panel.js"></script></body></html>
```

`ui/panel.js`：

```js
import { ctx } from '/panels/panel-client.js';
import '/panels/theme.js';
const run = document.querySelector('#run');
const result = document.querySelector('#result');
let active = true;
window.addEventListener('pagehide', () => { active = false; }, { once: true });
run.addEventListener('click', async () => {
  run.disabled = true;
  try {
    const receipt = await ctx.call('text-count__count', { text: document.querySelector('#text').value });
    if (!active) return;
    if (!receipt.ok) throw new Error(receipt.error || '执行失败');
    result.textContent = receipt.result?.content || '执行完成';
  } catch (error) {
    if (active) result.textContent = String(error.message || error);
  } finally { if (active) run.disabled = false; }
});
```

工具前缀保留字母、数字、短横线和下划线，其它字符（如 manifest ID 中的点）替换为下划线；开发时使用 registerTool 返回值核对。此例最终 ID 是 `text-count__count`，不要凭显示名猜 ID。

面板渲染用户/远端数据用 textContent，避免 innerHTML。配置由宿主技能设置表单保存，普通面板不能全局保存设置；若需自有编辑器，把自身业务状态经工具存入 ctx.storage。公共主题/图标/动效是可选引用，完整合同保留于公共 SDK，不增加 RPC 权限。

## 13. 自检、打包与发布

在应用根目录使用：

```text
node scripts/extension-dev.mjs check examples/extensions/roll-dice --json
node scripts/extension-dev.mjs test examples/extensions/roll-dice --case examples/extensions/roll-dice/extension.check.json --json
node scripts/extension-dev.mjs pack examples/extensions/roll-dice --out .qa-local/roll-dice.zip --json
```

Windows 安装版可用 `scripts\extension-dev.cmd` 替换 `node scripts/extension-dev.mjs`，复用随包 Electron 的 Node 模式，无需另装 Node。含空格目录加双引号；--out 放在扩展目录之外。源码环境使用 Node 20 或以上。

`check` 只做静态结构与常见合同误用检查，不导入扩展；通过不表示可运行。`test` 会执行扩展的受信任原生代码，隔离临时 app/data，使用真实清单规范化、加载器、工具注册、SDK 和权限服务；宿主 HTTP/发送使用离线桩，不访问真实 QQ/生成 API。它不是阻止恶意 Node 模块自行访问磁盘/网络的安全沙箱；只运行自己认可的代码。`pack` 复用生产 ZIP 规则，发现运行数据、环境/密钥文件或非空敏感默认值即拒绝打包；先将这些内容移出发布目录或清空敏感默认值，不会自动过滤。不要把某个 zip 成功等同于社区审核通过。

扩展自带 `extension.check.json`，不会被宿主自动执行。最小合同：

```json
{
  "version": 1,
  "cases": [{
    "name": "统计并读取默认设置",
    "config": { "includeWhitespace": false },
    "permissions": {},
    "input": { "tool": "count", "args": { "text": "你好 world" }, "chatKey": "private:10001" },
    "expect": { "ok": true, "result": { "count": 7 }, "sendCount": 0, "httpCount": 0 }
  }]
}
```

case 的 config 仅自身 schema 键；permissions 默认拒绝，显式设置声明过的 scope 为 allow/deny。`input.tool` 写本地短 ID；可用 `inputs:[...]` 在同一实例顺序执行，expect.results 对照每次完整回执，expect.result 指最后一项的 result。`cancelAfterMs` 可使调用中止，`stopAfterMs` 可在调用期间卸载。`http` 数组按次序精确匹配 URL/method，填写 status/json/headers 或 bodyBase64，`responseDelayMs` 用于取消；未匹配的请求失败，不会回退真实网络。expect 可断 `ok/result/resultIncludes/errorIncludes/sends/sendCount/httpCount/storage`；result/results/sends/storage 按递归子集匹配，数组的长度和每项仍需匹配，sends 可只写 `{method:'sendImage',chatKey:'private:10001'}`。业务失败也必须断 result.isError，不只断外层 ok。完整可执行用例见三个范例。

v1 用例字段完整速查（未填字段按下表默认）：

| 层级 | 字段 | 合同 |
|---|---|---|
| 根 | version/cases | version 必须为1；cases 是各自重新隔离加载的用例数组 |
| case | name/config/permissions | 名称、自身设置覆盖、scope→allow或deny；不要放真实密钥 |
| case | input 或 inputs | 单次调用对象或同实例顺序调用数组，选择其一 |
| input | tool/args/chatKey | 本地或完整工具ID、参数对象（默认{}）、明确的聊天目标（不填则undefined） |
| input | cancelAfterMs/stopAfterMs | 延迟取消本次调用 / 卸载本代扩展，用于迟到结果测试 |
| case.http[] | url/method | 逐次精确匹配URL，method默认GET；URL query顺序也是字符串的一部分 |
| case.http[] | request | 对请求`{url,method,headers,json,body}`做递归子集断言；json来自JSON请求体解析 |
| case.http[] | status/headers/json/body/bodyBase64 | 默认200；设置json会JSON编码并给application/json；二进制优先bodyBase64，其次json，其次body（默认空） |
| case.http[] | responseDelayMs/error | 延迟响应毫秒数；error字符串模拟抛错，不是真实网络连接 |
| case | sendResult/sendError/sendDelayMs | 所有发送桩返回的回执 / 抛出错误 / 延迟；用于失败、部分发送、去重或取消测试 |
| expect | status | 加载期预期状态，默认active；可明确测试error/unmet等，不执行无活跃实例工具 |
| expect | ok/errorIncludes | 最后一次registry.invoke外层ok（有调用时默认true）；errorIncludes检查外层error字符串 |
| expect | result/resultIncludes | 最后一次的result递归子集 / 序列化文本包含字符串，不等于全对象深相等 |
| expect | results | 每次完整工具回执的数组，长度相同，每项递归子集 |
| expect | sends/sendCount/httpCount | 发送记录数组子集、实际宿主发送调用次数、HTTP调用次数；HTTP夹具必须全部被准确消费 |
| expect | storage | 最终自身KV的递归子集；每个case开始为独立空数据 |

每个 case 结束会验证工具撤销、调度器回收及实例 signal 中止。公开测试值也可能随 ZIP 分发，外部服务响应里如含个人数据应先改为固定合成响应。

至少验收：正常输入、缺参数、无配置、配置更新、远端错误/坏格式、拒权、取消、重复调用、停用资源清理。发送类还应断实际产生的发送记录和回执，不能只断“代码没有抛错”。面板与定时的真实可见交互还需宿主验证，不由上述工具自动证明。

### 已授权的本地安装与宿主核验

本节供本机 AI 在用户已授权的制作、安装和试用范围内操作现有控制台，**不是普通扩展的 SDK**。技能和插件共用下表中的 `/api/skills` 路由，区别由清单与 `kind` 决定；启动覆盖层不走此安装接口，也不能夹在普通 ZIP 中取得信任。自检 CLI 只有 `check/test/pack`，没有 `install` 或 `reload` 子命令。

优先使用已打开的本机控制台：进入技能或插件页，选择“安装技能 ZIP”或“安装插件 ZIP”，检查新条目的设置、启用状态和宿主授权。该界面由宿主处理认证，不需要 AI 获取控制台令牌。若使用本机 HTTP 自动化，必须已有用户授权会话或受控测试环境明确提供的 `consoleOrigin` 和 `consoleToken`：

- `consoleOrigin` 是正在运行的本机控制台地址（如实际的回环主机及端口），不能猜端口或调用远端网站。请求使用 `Content-Type: application/json` 和 `x-console-token: consoleToken`，不是 `Authorization: Bearer`。浏览器请求须来自该控制台同源；本机脚本不需要伪造 `Origin`、`Referer` 或浏览器来源头。
- 令牌只用于当前已授权的宿主管理操作，不从全局配置、他人账号、其它插件、浏览器内部存储或真实用户 `data/` 中搜取，不放入 URL、日志、README、扩展源码或安装包。普通扩展及其面板不得获得令牌，也不能利用本节绕过其 SDK 边界。
- 没有明确凭证、遇到 `401` 或无法连接当前宿主时，回到正常本机控制台的连接/恢复界面；需要时请用户完成连接。不要伪造来源领取认证，也不要把 ZIP 已生成或离线加载通过标成实际宿主已加载。

| 顺序 | 现有 HTTP 合同 | 必须核对的结果 |
| --- | --- | --- |
| 安装前检查 | `GET /api/skills` | 返回 `skills` 数组；核对目标 ID 没有占用。不要覆盖已有同 ID、同目录或其它域的扩展 |
| 安装 ZIP | `POST /api/skills/install`，JSON 为 `{zipBase64, skillId: extensionId, kind: extensionKind}` | `zipBase64` 是已自检 ZIP 的标准 base64，解码后不超过 8MiB；`extensionKind` 为 `skill` 或 `plugin`，必须与包的身份一致。成功返回 `{ok:true, installed, root, enabled:false, skill}`；安装器强制停用，不会因为清单默认启用就执行代码。`409` 表示身份已存在，不能改成覆盖操作或重复安装 |
| 配置及启用 | `POST /api/skills/{encodeURIComponent(extensionId)}`，JSON 可为 `{settings: ownSettings, enabled:true}` | `settings` 仅写本扩展 `configSchema` 已声明字段；密钥优先由用户在本机设置页填写。只有用户已授权信任并启用本次新增代码时才提交 `enabled:true`；否则停留在已安装未启用。响应中的 `skill` 是当前状态，不能只看外层 `ok` |
| 按需重扫 | `POST /api/skills/reload`，JSON `{}` | 返回 `loaded`、`failed`、`pruned`、`skills` 等字段；直接复制完整目录后用它重扫。ZIP 安装本身已经装载该目录，一般不需再做全量重扫；重扫会涉及其它已安装扩展，不要无目的反复调用 |
| 核对目标状态 | `GET /api/skills`，仅取 `id === extensionId` 的条目 | 实际加载并启用应有 `enabled:true`、`loaded:true`、`active:true`、`status:'active'`（`code` 同为 `active`）、`reason:null` 和 `broken:false`。工具最终 ID 从此条目的 `toolIds` 读取，不猜拼接或截断结果；`status:'disabled'` 只证明已安装未运行 |
| 核对工具可用性 | `GET /api/tools/availability`，筛选 `skillId === extensionId` | 目标工具有 `id`、`enabled`、`code`、`reason`；不可用时保留实际原因，不能把注册成功说成可调用。没有工具的事件型扩展不应编造工具条目，应另核对它实际注册的消费者和行为 |

所有变量均由当前已授权任务或待安装包提供；不要把以上变量名作为接口默认值。请求路径中的 ID 需进行 URL 编码，密钥及令牌不能写入验收产物。配置响应会脱敏，不能从 `******` 或 `has...` 状态还原密钥。

“启用”与“权限已授予”分别记录。需要权限的扩展应通过现有“宿主授权”界面确认；代码指纹变化后旧授权不能沿用。不需要权限的技能记录清单请求范围为空即可，不能为了验收编造授予步骤。工具可用性列表也不是最终业务执行回执；成功执行仍使用离线用例或用户明确授权的真实试用取得证据。普通权限、外部服务或宿主不可用时，交付 ZIP 并说明剩余步骤和阻碍。

若选择直接放置目录而非 ZIP 安装，在本地验证后将完整新目录放入 skills/plugins，再按已授权范围重扫、配置和启用；不需要重复执行 ZIP 安装。两种方式都须分别核对加载状态、启用状态、所需权限与工具可用原因。只有真实聊天试验才能验证模型选工具及最终 QQ 接收，只有真实社区账号/提交响应才能验证上线端发布；离线测试不冒充它们。

社区闭环：在内置社区选择正确类型、登录自己的社区账号、选择本机扩展、预览打包内容并提交；宿主负责必要的认证/验证步骤。保留服务器返回的条目 ID/状态，区分投稿成功、审核中和可安装。包内不能含已填写 API Key、data、插件运行缓存、node_modules 或启动覆盖层。当前发布接口/站点以应用实际选择的 market 提供者为准，不照抄 0.4 文档中的历史域名或旧端点。测试与公开发布是不同操作，按用户明确的发布范围执行。

## 14. 常见失败定位

| 现象 | 先检查 |
|---|---|
| log is not a function | 是否把 0.4 callable log 写到 native ctx.log；不要盲加兼容标记后就声称完整兼容 |
| 参数为空、ctx.sender undefined | handler(args,execution) 的顺序；发送改用 execution.send |
| 自己的 API Key 读不到 | schema 声明、settings 默认值、控制台填写；不要从 execution.cfg 取密钥 |
| 有能力但模型不使用 | 是否 registerTool；自定义 capability 没有自动消费者 |
| 工具没出现 | enabled、加载错误、requires、总开关/分类/单工具开关、权限和视觉/搜索前置条件 |
| 配置改变但行为不变 | 是否 setup 时快照；应执行时读取或 config.onChange 重建自己的任务 |
| 发图报告成功却没有新消息 | 是否只检查外层 ok；检查 result、发送回执 ok/sent/deduped，不把生成成功等同发送成功 |
| 面板调用失败 | 只调用自身工具、最终 ID 正确、ui.panel 已声明/授权、entry 在 ui/ 内 |
| 更新后权限失效 | 源码指纹已变化，需要重新确认；不能复用旧目录/旧闭包的授权 |
| 热更不生效 | 完整落盘、重扫；模块图装载有上限/依赖缓存约束，明确提示需要完整重启 |

本手册描述目前公开合同，不承诺 0.4 任意原始 OneBot 接口等价，也不承诺普通市场包可替换整个桌面外壳。真实缺口保留在 [能力对照](v04-extension-parity.md)，避免 AI 用直接 import 内部文件或访问原始客户端偷偷绕过架构。

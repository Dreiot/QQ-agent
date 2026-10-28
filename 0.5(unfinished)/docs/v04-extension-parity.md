# 0.4 → 0.5 扩展能力对照

核对日期：2026-10-21。范围是 **AI 作者能够通过普通技能/插件的公开接口完成什么**，不把“可以替换 runtime.kernel”计作某个现有功能的等价入口。本文对照当前工作区的 0.4 `../develop/doc/extend_development/skill-reference.md`、`../develop/src/plugin-loader.js` 与 0.5 的真实加载器、SDK facade、工具/发送队列、默认传输和实际消费者；没有读取旧版账号数据、密钥或用户配置。

状态含义：**等价**＝已有公开功能；**入口改变**＝功能存在，参数/权限/生命周期须迁移；**缺口**＝普通 SDK 没有等价入口或默认消费路径；**不可直搬**＝旧做法越过新边界，应按受控合同重写。等价是源码合同判断，不是全部真实 QQ/外部服务验收已通过。新增文档补充了原先未写清的合同，但文档不能补出运行时能力。

## 1. 日常创作闭环

| 原子能力 | 当前状态 | 0.5 路径 / 限制 |
|---|---|---|
| 两个文件新增文本工具 | 等价 | skill.json + setup 注册工具，无需修改出厂源码 |
| AI 可复制的当前版本完整合同 | 文档补齐 | [扩展参考](extension-reference.md)，明确 native params/handler、日志对象与执行上下文 |
| 复制提示词即可从空白需求开始 | 引导合同补齐；实测另记 | [AI引导提示词](ai-extension-prompt.md)无需填写占位符；第一条先问想让机器人做什么，每次1—3个日常问题，既有描述只是初始想法 |
| AI 澄清并确认实际需求 | 引导合同补齐；实测另记 | 读开发文档/写代码前复述短摘要，等待用户明确确认；更正后重新确认，已确认上下文不重复问；不让用户选择skill/plugin或技术方案 |
| 确认后 AI 自主定位、选型并交付 | 流程补齐；证据分层 | 从已给根目录或AI当前工作目录定位，找不到再问；读当前文档，按主要触发方式判断技能/插件，生成、自检、直接放入独立目录并重扫；最终清单与宿主保持禁用，用户点击启用，ZIP按额外需求生成，不自动发布社区。离线加载通过不代表运行中宿主已安装、已启用或已授权 |
| 有配置的 HTTP 工具 | 入口改变 | ctx.config.get + ctx.http.fetch，net.outbound 声明/授权与取消 |
| 文生图→base64→发送 | 入口改变 | [image-generate 范例](../examples/extensions/image-generate/README.md)，execution.send.sendImage；生成成功和发送成功分别检查 |
| 注册提示词片段 | 等价 | prompt.sections 或 ctx.prompt.add；priority ≤99 |
| 确定性能力/钩子 | 入口改变 | 在 native setup 中显式 registerCapability/hooks.on |
| 注册自有面板 | 等价且受控 | ui.panel + ui/，自己的工具/脱敏配置/通知 RPC |
| 周期/一次性任务 | 入口改变 | ctx.scheduler.every/at，生命周期回收；不承诺进程退出后补发 |
| 自身持久化 | 等价且受控 | ctx.storage JSON KV；不是任意全局数据访问 |
| 静态检查 | 新工具 | extension-dev check；不执行代码，不等同运行通过 |
| 经真实 SDK 的隔离离线用例 | 新工具 | extension-dev test；HTTP/QQ 桩，不是 Node 恶意代码沙箱 |
| 生成安装器接受的 ZIP | 等价且补工具 | extension-dev pack 复用生产 ZIP 规则；不把真实配置打包 |
| 本机扩展自动打包投稿 | 等价 | 当前 market 提供者 publish；必须在 skills/plugins 中按 manifest ID 同名目录安装 |
| 社区真实投稿、审核、公开安装 | 外部验收项 | 登录/验证码/服务端权限与审核分开；本文不将离线 fixture 标成真实发布 |
| 普通市场包替换整个主窗口/核心 | 非同一信任入口 | 可信 overrides 启动组合另行部署，需完整重启；不会由普通 ZIP 自动获得 |

范例与工具的实际通过数量及外部发布结果由本次验收报告记录，本文不预写“全部通过”。

0.4的真实引导入口位于`../develop/ui/app/09-community.js`的`buildModuleCreationPrompt`：要求AI主动问用户想让机器人学会什么，询问用途和触发方式，并替用户判断技能或插件。本轮按这个低门槛体验补齐0.5的访谈阶段，同时要求在开发文档读取和制作前先得到需求确认；不沿用0.4“落盘必定自动加载”的承诺。上一轮三个盲测从已写明的需求起步，不能作为这项空白需求引导的通过证据；后续实测须记录提问、回答、确认、开发文档读取和实际宿主安装结果。

## 2. setup API、清单和生命周期逐项迁移

| 0.4 项目 | 状态 | 原生 0.5 写法 / 差异 |
|---|---|---|
| apiVersion:1 | 不可直接判别兼容性 | 0.5 native 也用 1。不能据此自动判断旧接口 |
| setup(api)/register(api) | 部分自动兼容 | setup(ctx) 推荐；未标记用户包可使用兼容提供者的双接口 SDK |
| registerTool(def) | 入口改变 | id/name、params、handler(args,execution)；返回最终 ID |
| parameters | 自动兼容 | 原生写 params；未标记用户包的 parameters 自动映射，并使用 execute(execution,args) |
| execute(ctx,args) | 入口改变 | native execute/handler 都是 (args,execution)，顺序颠倒会使参数和发送接口失效 |
| `{content,isError}` | 等价但回执分层 | 可返回业务对象；外层 invoke.ok 仅表示执行是否抛错，须另断 result.isError |
| api.config() | 自动兼容 | 未标记用户包保留可调用配置入口，同时支持 ctx.config.get(key)/all()/onChange；执行时读取最新值 |
| manifest.settings 默认值 | 等价 | 用户 settings 合并默认值；schema.default 不是自动默认值来源 |
| configSchema 字段 | 等价且更严格 | 宿主保存只接受声明字段、验证基础类型/enum/minimum/maximum；明文密钥只在自身 SDK 读取 |
| configSchema.boolean | 等价 | type:boolean |
| configSchema.number 的 min/max/step | 入口改变 | type:number或integer，范围用minimum/maximum；旧min/max不作为当前后端范围合同 |
| configSchema.enum + options | 入口改变 | 用基础type和enum:[JSON值]；不是type:'enum' |
| configSchema.string + multiline | 部分变化 | 当前普通设置页字符串是文本/密码框；长文本可使用自有面板和自身工具 |
| configSchema.internal | 入口改变 | 明确声明object/array并由设置页JSON编辑；旧隐藏internal类型不要照搬 |
| api.log/warn/error 函数 | 自动兼容 | 未标记用户包保留旧调用，同时支持 ctx.log.info/warn/error/debug 方法 |
| api.fetch | 入口改变 | ctx.http.fetch；web_fetch兼容映射net.outbound，限制目标与响应字节并支持取消 |
| api.utils.safeJsonParse | 入口改变 | 自己的纯函数或 try/catch；无宿主全局 utils |
| api.utils.sleep | 入口改变 | 自建可取消等待并登记清理；不要复制旧忽略 signal 的 sleep |
| api.isSkillActive | 等价 | ctx.isSkillActive(id)，不是外部连接就绪探测 |
| api.capability / hasCapability | 入口改变 | ctx.capability / hasCapability；公共对象方法需 await，权限/代际可能使调用拒绝 |
| providers 导出 + setup | 入口改变 | native setup 中显式 registerCapability；不能假定并列导出自动收集 |
| hooks 导出 + setup | 入口改变 | native setup 中显式 hooks.on；并列导出不会自动收集 |
| activate 导出 + setup | 入口改变 | native setup 分支不会随后自动调用activate；在setup建立SDK资源，lifecycle.onStop回收 |
| available() 动态自检 | 缺口 | native没有通用 available() 求值入口；manifest/tool requires仍可阻止缺能力，配置缺失在handler返回可读错误 |
| deactivate / dispose | 入口改变 | 旧兼容路径有适配；native以无参清理/SDK自动回收为准，不借旧api重新发副作用 |
| promptSections(context) 动态片段 | 等价且受控 | 可异步、5秒回调边界、上下文脱敏，不返回宿主原始对象 |
| tools[]清单自动注册 | 两版都没有 | 工具必须实际 registerTool |
| capabilities[]清单自动实现 | 两版都没有 | 元数据必须与实际 registerCapability 对应 |
| 文件热重载 | 入口改变 | 开关/监听由当前宿主控制；模块图快照、代码指纹和装载次数约束；不要继续说必须QQ_AGENT_DEV=1才热更 |
| 旧授权继续沿用新源码 | 不可直搬 | 管理员授权绑定目录/源码指纹；改代码后重审 |

apiVersion:0、compat:'04'、compat04:true、legacyApi:'0.4' 或旧 prompt 形状仍选择完整的旧生命周期适配。另由 compat-04 提供者为未标记用户包提供双接口 SDK：实际调用 config()/log()/warn()/error() 时记录旧接口使用；工具逐项按 parameters（旧参数顺序）和 params（原生参数顺序）适配，不改市场源码或清单，不通过重复 setup 猜测版本。原生配置/日志方法及其余窄 SDK 保持可用，兼容记录可从扩展 DTO 的 compatibility 字段读取。没有 schema 的未标记工具仍采用原生参数顺序，避免一个旧工具改变同包其它工具的行为；这种含糊的旧工具及旧式并列生命周期声明仍需明确兼容标记。compat-04 停用时原生加载仍可使用，但自动适配不提供。上述自动识别不代表 execution.sender/任意 OneBot 调用等其它旧行为已经兼容。

## 3. 工具执行上下文逐字段对照

| 0.4 字段 | 状态 | 当前公开等价 |
|---|---|---|
| chatKey | 等价 | execution.chatKey；常用 group:123/private:456 |
| kind | 入口改变 | 解析已知 QQ chatKey，不把下划线文件名当运行键 |
| chatId | 入口改变 | 同上，业务号保持字符串，传输侧转换 |
| selfId | 缺口 | 普通工具执行上下文没有公开登录 QQ ID；不从process/global配置猜 |
| selfNickname | 缺口 | botName是人设名，不等价登录昵称 |
| botName | 等价 | execution.botName，允许缺省 |
| onebot | 不可直搬/部分缺口 | 只开放 transport.actions，不能拿原始client/token/call |
| store | 入口改变/部分缺口 | execution.store四个明确方法；见第5节 |
| memory | 入口改变/部分缺口 | execution.memory受控白名单，不是原MemoryStore实例 |
| stickers | 入口改变 | execution.stickers，方法名与参数按当前业务合同 |
| sender | 入口改变；旧兼容映射缺口 | 原生改execution.send；不能假定compat自动补sender别名 |
| session | 入口改变 | 脱敏副本；修改不会改变宿主活会话，自己创建记录不等于启动主Agent |
| reminders | 入口改变 | execution.reminders，写数据要fs.outsideNamespace；简单任务优先ctx.scheduler |
| videoReader | 入口改变/部分缺口 | mediaReader/probe/framesAvailable；describeRoute不在公共白名单 |
| emit | 不可直搬 | 使用ctx.events白名单观察；任意SSE/宿主写事件未开放 |
| cfg（内部原对象） | 不可直搬 | 执行cfg脱敏自身视图；用ctx.config读自己密钥，不获取全局模型Key |
| signal | 0.5明确合同 | execution.signal传遍网络/发送；生命周期signal用于后台任务 |
| log | 不应假定 | 工具里用setup闭包ctx.log，执行上下文本来不应靠任意log字段 |

## 4. 旧 OneBot 操作逐项对照

以下按通用协议调用与扩展开发所需的动作逐项记录；具体支持情况由协议端决定。v0.5普通SDK没有通用raw call。传输内部仍能执行某协议动作，**不代表普通插件拥有该接口**。

| 旧动作 | 状态 | 普通 0.5 路径 / 缺口 |
|---|---|---|
| get_login_info | 缺口 | 无公开登录身份查询；仅宿主/transport内部 |
| get_status | 缺口 | 可观察transport.status事件，但不是原始协议状态主动查询 |
| get_version_info | 缺口 | host.environment.version是Agent版本，不是协议版本 |
| can_send_image | 缺口 | 无等价探测 |
| can_send_record | 缺口 | 无等价探测 |
| get_friend_list | 入口改变 | transport.actions.listFriends({signal}) → [{id,name}] |
| get_stranger_info | 入口改变 | getChatInfo('private:QQ号') |
| get_group_list | 入口改变 | listGroups({signal}) → [{id,name}] |
| get_group_info | 入口改变 | getChatInfo('group:群号') 或 getGroupName(chatKey) |
| get_group_member_list | 入口改变 | getMembers(groupId)原始data，或getGroupMembers(groupId)归一化视图 |
| get_group_member_info | 入口改变/结果收窄 | getGroupMemberInfo(groupId,userId,{signal})仅userId/card/nickname；完整管理字段不开放 |
| get_msg | 缺口/本地替代 | store.findByMid仅查本地已存档，不等价向协议端拉任意消息 |
| get_group_msg_history | 缺口/本地替代 | store.recent仅本地存档 |
| get_friend_msg_history | 缺口/本地替代 | store.recent仅本地存档 |
| get_image | 入口改变 | actions.getImage(file)或media.reader.image受控读取 |
| get_record | 入口改变 | actions.getRecord(file)，当前输出mp3 |
| fetch_ptt_text | 缺口/功能替代 | 可注册media.transcribe，但没有旧原始接口的公共方法 |
| get_group_album_list | 缺口 | 无公共动作 |
| get_qun_album_list | 缺口 | 无公共动作 |
| get_group_album_media_list | 缺口 | 无公共动作 |
| get_qzone_msg_list | 缺口 | 无公共动作 |
| get_qzone_feeds | 缺口 | 无公共动作 |
| get_group_admin_settings | 缺口 | 无公共动作 |
| get_group_file_url | 缺口 | getFile(file)不等价按群文件ID查询URL |
| get_group_root_files | 缺口 | 无公共动作 |
| get_group_files_by_folder | 缺口 | 无公共动作 |
| fetch_sys_faces | 缺口 | 自定义收藏表情查询不是系统表情查询 |
| fetch_face_entity | 缺口 | 无公共动作 |
| search_sys_faces | 缺口 | 无公共动作 |
| get_essence_msg_list | 缺口 | 无公共动作 |
| _get_group_notice | 缺口 | 无公共动作 |
| get_cookies | 不可直搬 | 普通SDK不公开账户Cookie/秘密；不应为了兼容暴露凭据 |
| send_msg | 入口改变 | execution.send.sendTextBatch/sendSegments，走队列/限频/去重 |
| send_private_msg | 入口改变 | 同上，chatKey为private:QQ号 |
| send_group_msg | 入口改变 | 同上，chatKey为group:群号 |
| delete_msg | 入口改变 | actions.recall(messageId)，需qq.send |
| set_group_kick | 缺口 | 无公共群管理写入动作 |
| set_group_kick_members | 缺口 | 无公共群管理写入动作 |
| set_group_ban | 缺口 | 无公共群管理写入动作 |
| set_group_whole_ban | 缺口 | 无公共群管理写入动作 |
| set_group_admin | 缺口 | 无公共群管理写入动作 |
| set_group_card | 缺口 | 无公共群管理写入动作 |
| set_group_add_option | 缺口 | 无公共群管理写入动作 |
| set_friend_add_request | 缺口 | 无公共请求处理动作 |
| set_group_add_request | 缺口 | 无公共请求处理动作 |
| upload_group_file | 缺口 | 可发送file段不等价协议群文件管理上传 |
| upload_private_file | 缺口 | 可发送file段不等价协议私聊文件管理上传 |
| send_like | 缺口 | poke不等价点赞 |
| friend_poke | 入口改变 | send.poke/private chatKey + userId |
| group_poke | 入口改变 | send.poke/group chatKey + userId |
| send_poke | 入口改变 | send.poke/chatKey + {groupId?,userId} |
| set_group_reaction | 缺口 | 无公共表情回应动作 |
| set_essence_msg | 缺口 | 无公共动作 |
| delete_essence_msg | 缺口 | 无公共动作 |
| _send_group_notice | 缺口 | 无公共动作 |
| mark_group_msg_as_read | 缺口 | 宿主存档已读与协议已读不是同一合同 |
| mark_private_msg_as_read | 缺口 | 同上 |
| mark_msg_as_read | 缺口 | 同上 |
| upload_forward_msg | 缺口 | 发送已有forward资源ID不等价上传新合并转发 |
| upload_image_to_qun_album | 缺口 | 无公共动作 |
| send_qzone_msg | 缺口 | 无公共动作 |
| delete_qzone_msg | 缺口 | 无公共动作 |
| like_qzone | 缺口 | 无公共动作 |
| upload_file_stream | 缺口 | 无公共流式协议动作 |
| download_file_stream | 缺口 | HTTP媒体下载不等价该协议动作 |
| download_file_image_stream | 缺口 | 同上 |
| download_file_record_stream | 缺口 | 同上 |
| get_forward_msg | 入口改变 | actions.getForward(messageId) |
| get_video | 入口改变 | actions.getVideo(file) |
| get_file | 入口改变 | actions.getFile(file) |

这些缺口不宜用给插件整个 OneBot client 解决。后续若补，应在现有传输能力中增加明确方法、参数验证、最小权限、账号/配置代际、取消与回归测试。文档和示例不得绕过 facade import 客户端、读取连接令牌或自行猜端口。

## 5. 旧数据仓与发送接口逐项对照

| 0.4 方法 | 状态 | 当前普通SDK |
|---|---|---|
| store.recent | 入口改变 | recent(chatKey,n,options)，旧{limit,before}不能照搬 |
| store.findByMid | 等价且受控 | findByMid(chatKey,mid,options)，结果副本 |
| store.listChats | 入口改变 | 返回{chatKey,lastActive,lastText,unread,count}摘要数组，不是key数组 |
| store.getChatMeta | 部分替代 | listChats摘要部分字段；无同名方法 |
| store.unreadCount | 部分替代 | listChats摘要unread；不是独立可调用方法 |
| store.peekUnread | 缺口 | 无公共同等分页/未读预览 |
| store.markAllRead | 缺口/不可直搬 | 属于宿主已读一致性，不对普通插件开放 |
| store.findByLocalId | 缺口 | 无公共方法 |
| store.appendIncoming | 不可直搬 | 入站由宿主ingest拥有，普通插件不伪造真实消息 |
| store.appendSelf | 不可直搬 | 只由确认后的发送队列留档，避免伪造已发送 |
| store.activeMembers | 缺口 | 可用recent自算受限视图，不是原完整语义 |
| store.muteUnread | 缺口 | 无公共方法 |
| store.clearChat | 缺口 | 公共SDK不开放批量清空消息 |
| memory.query | 等价且受控 | query(chatKey,{userId?,name?})，需data.memory.read |
| memory.getMember | 入口改变 | query按成员过滤取数组，不提供仓对象 |
| memory.listChats | 入口改变 | listFiles摘要含chatKey，不是同名方法 |
| memory.members | 入口改变 | query(chatKey)返回成员印象副本 |
| memory.editMemberImpression | 部分替代 | replaceMember显式替换有区别，需自行适配并测试 |
| memory.replaceMember | 等价且受控 | replaceMember(chatKey,{userId,name,impressions})，fs.outsideNamespace |
| memory.removeMember | 等价且受控 | removeMember(chatKey,userId)，fs.outsideNamespace |
| memory.remove | 等价且受控 | remove(chatKey,{userId?,name?,content?})，fs.outsideNamespace |
| memory.clear | 入口改变 | clearChat(chatKey)，fs.outsideNamespace |
| memory.formatForPrompt | 缺口 | 普通SDK不公开同名方法；可以自行格式化读取结果 |
| memory.append | 等价且受控 | append(chatKey,{userId?,name?,content})，fs.outsideNamespace |
| memory.consolidationState | 部分替代 | lastConsolidatedAt，仅保留明确时间查询 |
| memory.markConsolidated | 等价且受控 | markConsolidated(chatKey) |
| memory.replaceConsolidated | 缺口/部分替代 | replaceMember有不同语义，不能称完全等价 |
| stickers.list | 入口改变 | list/get/all在公共白名单，数据结果脱敏 |
| stickers.find | 入口改变 | 当前用get；原引用解析规则不应凭名字假定一致 |
| stickers.collect | 等价且受控 | collect，写库需fs.outsideNamespace |
| stickers.sync | 需独立扩展 | 默认不提供 QQ 收藏表情同步；本地已有索引保留，外部同步依赖用户选择的扩展能力 |
| stickers.note | 等价且受控 | note，写库需fs.outsideNamespace |
| stickers.markUsed | 等价且受控 | markUsed，写库需fs.outsideNamespace |
| sender.sendTextBatch | 入口改变 | execution.send.sendTextBatch(chatKey,texts,options)，qq.send |
| sender.sendImage | 入口改变 | execution.send.sendImage(chatKey,{url,file,dataUrl,base64},options) |
| sender.sendSticker | 入口改变 | execution.send.sendSticker，真实回执/去重/失败仍要判断 |
| sender.poke | 入口改变 | 目标从单一targetUserId改为{groupId?,userId} |
| reminders.add | 等价且受控 | add({chatKey,text,dueAt,createdBy})，fs.outsideNamespace |
| reminders.cancel | 等价且受控 | cancel(id)，fs.outsideNamespace |
| reminders.pending | 等价且受控 | pending(chatKey?)，data.sessions.read |
| reminders.due | 等价且受控 | due(nowMs?)，data.sessions.read |
| reminders.prune | 不能照旧无参搬 | 当前prune内部合同需列表，普通作者不应猜测；通常不需要主动调用 |
| videoReader.describeRoute | 缺口 | 无公共方法 |
| videoReader.framesAvailable | 入口改变 | execution.mediaReader.framesAvailable |
| videoReader.probe | 入口改变 | execution.mediaReader.probe，网络/外部本地路径权限分别检查 |

## 6. 旧默认能力与 hook 消费

这一节区分“注册表接受名字”和“生产链路真的查找并消费”。0.5 对 `message.speaker-format` 等名字设置了提供者脱敏规则，并不能证明默认消费者已经接通。

| 旧能力名/机制 | 当前状态 | 已核消费或差异 |
|---|---|---|
| llm.request-params | 等价且受控 | llm请求体转换链，脱敏副本成功后回填body |
| llm.response | 等价且受控 | llm响应转换链，对允许字段回填；不透传模型Key |
| llm.usage | 入口改变 | llm用量协作链，按当前参数形状而不是旧手册猜 |
| llm.retry-advisor | 入口改变 | llm降级建议协作链；null为不认领 |
| llm.endpoint-pick | 入口改变 | 当前llm.js真实消费，必须按当前端点选择上下文 |
| llm.endpoint-feedback | 入口改变 | 当前llm.js真实消费，不能取得原始模型凭据 |
| llm.endpoint-snapshot | 缺口 | 未发现当前默认生产消费者；自定义注册不会自动启用 |
| tool.guard | 入口改变 | 列表和调用级真实消费；返回{block:true,reason}才阻断，不是旧表中的任意false/ok:false |
| video.frames | 入口改变 | media-service真实消费，input与{frames,count,signal}，异步结果按代际丢弃 |
| video.frames.available | 入口改变 | media-service真实消费；注册不等于ffmpeg/外部工具可用 |
| media.transcribe | 入口改变 | kernel入站语音真实消费 |
| chat.ban-state | 入口改变 | 默认事件业务与编排器禁言策略消费 |
| message.owner-check | 入口改变 | 默认编排器真实消费，配置经受控投影 |
| message.speaker-format | 缺口 | 当前仅SDK预留受控名字；未发现kernel将它接到orchestrator.setSpeakerFormat |
| message.inline-at-normalize | 缺口 | 当前仅SDK预留受控名字；未发现默认传输/发送实际消费 |
| image.mime-support | 入口改变 | bundled media-tools预览路径真实消费 |
| model.thinking-detect | 缺口/设计入口改变 | 没有该旧名字的默认消费；现有思考策略/llm.dialect是不同合同，不能只改名字冒充等价 |
| sticker.annotate | 缺口 | 没有该旧名字的默认消费；自写工具可调用自定义能力，不等价旧自动标注 |
| sticker.annotate-batch | 缺口 | 同上 |
| image.random | 缺口 | 没有该名字的默认工具消费；应让新技能注册工具 |
| media.download.bilibili | 入口改变 | 统一media.download认领链；旧名字没有自动别名 |
| media.download.douyin | 入口改变 | 同上，provider按URL认领，不属于自己返回null/skip |
| before-context | 等价且受控 | 默认编排器实际消费；可变字段仅受控副本成功后提交 |
| before-llm-messages | 等价且受控 | runner实际消费messages变更 |
| after-response | 入口改变 | 观察脱敏response；修改hook副本不等价llm.response转换 |
| before-tool | 等价且受控 | runner和工具入口实际消费否决结果 |
| after-tool | 入口改变 | 结果载荷可能为序列化字符串，不假定始终是业务对象 |

检索证据入口：`src/kernel/plugin-loader.js`（清单、分支、SDK、callback）、`src/kernel/sdk-services.js`（字段、白名单、权限）、`src/kernel/tools.js`（参数与两层回执）、`src/kernel/send.js`（队列与图片）、`bundled/transport-onebot/provider.js`（动作实现）、`src/kernel/llm.js`、`src/kernel/orchestrator.js`、`bundled/media-service/reader.js`、`bundled/runtime-defaults/business.js`。这张表不覆盖整个 0.4 产品的所有页面、安装器和业务功能；范围限定在扩展作者的公开合同。

## 7. 后续补齐次序

先用常见技能的完整离线与实际安装路径验证低门槛，再按用户需求增加缺失的**具名受控接口**。优先级应由用户场景决定：例如缺少登录身份会阻碍安全的群管理工具，缺少群管理动作使旧禁言/管理技能无法原样迁移。自定义能力名的生产接线缺口应补真实消费者及回归，而不是只补文档或注册表条目。

保留当前接插件架构：不将原始 OneBot client、全局配置、任意仓对象或未授权工具执行器重新暴露。可信启动组合继续承担深度换形；它不是“每个普通技能都能轻松完成旧功能”的证明。

// Human-facing port contracts. Keys, types and execution semantics stay stable.
const info=(label,description,example)=>({...(label?{label}:{}),description,...(example?{example}:{})});
const eventUsers={message:'发送者 QQ',member_join:'新成员 QQ',member_leave:'离群成员 QQ',member_muted:'被禁言成员 QQ',member_unmuted:'被解禁成员 QQ',admin_changed:'身份变更成员 QQ',message_recalled:'原消息发送者 QQ',group_poke:'发起戳一戳的 QQ',group_upload:'上传者 QQ',join_request:'申请入群的 QQ'};
const fields={
  match:'选择怎样匹配文字：包含、完全相同、开头或结尾。完全相同不会忽略空格。',
  users:'填写 QQ 号，多个号码用空格或逗号分隔。这个名单只用于当前节点，不会更改规则适用的聊天范围。',
  groups:'填写要比较的群号，多个群号用空格分隔。只作判断，不会自动把这些群加入规则范围。',
  kind:'检查整条消息是否含有选定的消息片段。一条图文消息可以同时含有文字和图片。',
  role:'选择普通成员、管理员或群主。检查身份的节点只作判断；选人节点才会改变待处理名单。',
  days:'填写星期数字，1 是周一，7 是周日；多个数字用空格分隔。按运行电脑的本地日期判断。',
  percent:'每次到达此节点时重新抽取；0 表示永不通过，100 表示总是通过。',
  quantifier:'选择只需其中一人发言，还是名单中的每个人都必须发言。',
  template:'用 {{a}}、{{b}}、{{c}}、{{d}} 标出需要替换的位置；用到的变量必须提供，不会执行代码。',
  operator:'选择当前节点的比较或运算方式。运算只产生结果，接到后续节点才会用于判断或操作。',
  format:'把秒单位的时间戳按运行电脑的时区显示为日期、时间或两者。',
  event_type:'选择要订阅的群事件。此参数只选择数据来源，不会自动执行撤回或其他操作。',
  replay_seconds:'补入应用实际缓存中最近多少秒的事件；不是向 QQ 拉取聊天历史，0 表示只接收后续事件。',
  on_error:'选择某一项失败后停止整个循环，还是记录失败并继续下一项。',
  max_items:'单轮最多尝试处理的项数，包含失败项；达到上限后停止并报错。',
  ttl_seconds:'保存的状态在多少秒后过期；0 表示不过期。过期后按未保存处理。',
  initial:'状态键还没有数值时，先使用这个初值，再加上本次增量。',
};

function fieldInfo(spec,port){
  const key=port.configKey,f=spec.fields.find(f=>f.key===key);
  if(key==='text'){
    if(spec.type==='send_text'||spec.type==='send_at')return info(spec.type==='send_text'?'发送的文字':'提醒文字','机器人准备发送的文字。可输入固定内容，也可连入昵称、拼接结果等纯文字；不接收图片等消息段。','欢迎 {{nickname}}');
    if(spec.type==='note')return info(null,'写入本轮规则执行记录的说明，不会发到 QQ 聊天。');
    if(['rename_group','rename_card','special_title'].includes(spec.type))return info(null,`替换为这里填写的${f.label.replace(/^新的/,'')}，可用文字变量；不是查找条件。`);
    if(spec.type==='reject_join')return info(null,'拒绝本轮入群申请时提供给协议端的理由，不是另发一条群消息。');
    if(['user_sent','user_not_sent'].includes(spec.type))return info(null,'只把包含这些文字的发言算作已发言；留空时任意发言都算。');
    if(['contains_any','contains_all'].includes(spec.type))return info(null,'每行一个关键词。任一关键词节点只需命中一行，全部关键词节点要求每行都命中；空行忽略。');
    return info(null,'要寻找或比较的文字，按“匹配方式”判断；这里不是收到的消息，也不会发送出去。','#sl');
  }
  if(key==='scope')return info(null,spec.type.startsWith('state_')?'当前规则只在本规则内共享；当前账号可供该账号的多条规则共用。不同 QQ 账号始终分开。':spec.type==='message_frequency'?'同一位用户只统计当前发言人的消息；整个群统计该群所有成员的消息。':'选择每位触发用户分别计数，还是同一群共用一个计数；不同规则和账号分开。');
  if(key==='key')return info(null,spec.type.startsWith('state_')?'保存和读取同一份状态时必须使用相同的键与状态范围。若要分群、分人或分日期保存，需要把相应号码或日期拼进键。':'同名且同范围才使用同一份计数。不同规则和账号不会共用计数。','群号/日期/次数');
  if(key==='seconds')return info(null,spec.type==='time_offset'?'在基准时间上加上这些秒数；负数表示向前推。不是等待时长。':spec.type==='mute'?'对待处理的普通成员禁言多少秒；例如 600 秒是 10 分钟。':spec.type==='interval'?'每隔多少秒启动一轮。暂停或断线期间错过的轮次不会补跑。':spec.type==='cooldown_gate'?'本节点通过后开始计时；冷却结束前，后续到达会走“不满足”。':`按秒填写${f.label.replace(/（秒）/g,'')}。表示持续多久，不是具体的时刻。`);
  if(key==='time')return info(null,'按运行电脑的本地时间填写 HH:mm；如果今天已经过了该时刻，会等到明天。','08:00');
  if(key==='start'||key==='end')return info(null,(spec.type==='date_range'?'按本地日期填写；开始和结束日期都包含在内。':'按本地时刻填写；包含开始时刻，不包含结束时刻，支持跨午夜。'));
  if(key==='min'||key==='max')return info(null,`${key==='min'?'下限':'上限'}包含该数值。${spec.type==='target_count'?'统计的是待处理成员名单中的人数。':spec.type==='text_length'?'只统计消息文字的字符数，不计算图片等片段。':'单位是秒，只决定当前路径的随机等待时长。'}`);
  if(key==='count')return info(null,spec.type==='target_random'?'从当前名单中随机保留这么多人；人数不足时保留全部，不自动加入新成员。':spec.type==='counter_check'?'读取的计数达到此值时满足条件；只检查，不增加次数。':'统计窗口内达到多少条消息才满足条件，包含刚收到的这条消息。');
  if(key==='amount')return info(null,spec.type==='state_add'?'给该状态键的现有数值增加多少，可以为负数。只改数值，不直接处理成员。':'到达本节点时给选定计数器增加的次数。');
  if(key==='path')return info(null,spec.type==='list_filter'?'逐个元素读取这个字段后比较；留空则比较元素本身。只使用点分隔的字段名，不执行表达式。':'读取对象中的字段，用点分隔多层名称；字段缺失时输出空值，不执行表达式。','sender.nickname');
  if(key==='fallback')return info(null,'原值没有提供或为 null 时使用的备用值；空字符串、0 和“否”仍按原值保留。');
  if(key==='condition')return info('是否满足条件','填“是”时执行“是”出口，填“否”时执行“否”出口。也可以连入比较结果，由结果选择下一步。');
  if(key==='a'||key==='b')return info(null,spec.type==='text_join'?`拼接时排在${key==='a'?'前面':'后面'}的文字。两段直接相接，不额外加空格。`:`比较时的${key==='a'?'左侧':'右侧'}数值。结果是“是 / 否”，不会直接执行操作。`);
  if(key==='value')return info(null,spec.type==='value_bool'?'提供固定的“是 / 否”，供后续条件使用。':spec.type==='value_number'?'提供固定数值，可用于次数、时长或运算；单位由接入的参数决定。':'提供固定文字，不会直接发送到 QQ。');
  if(fields[key])return info(null,fields[key]);
  const options=port.options?.map(option=>option[1]).join('、');
  return info(null,options?`设置${f?.label??port.label}，可选：${options}。`:`${spec.label}使用的${f?.label??port.label}参数${port.type==='number'?'，填写数值':''}。`);
}

export function portInfo(spec,port,direction){
  const input=direction==='inputs',key=port.key;
  let detail;
  if(input&&port.configKey)detail=fieldInfo(spec,port);
  else if(key==='group_id')detail=info(spec.trigger&&spec.type==='message'?'消息所在群号':null,input?'默认使用启动这轮规则的群。填写或连线可为本节点指定其他群，但必须在规则已选范围内；只影响本节点，后续不会自动改到这个群。私聊没有群号。':'本节点实际使用的群号。默认来自启动这轮规则的群；若本节点指定了群号，则输出指定值。私聊不提供群号。','12345');
  else if(key==='targets')detail=info('待处理成员',input?'默认沿当前执行路径取名单：开始时为事件相关的人，选人节点会替换或增减，多路汇合会去重合并。填写或连线后，本节点改用指定名单；成员操作逐人处理。':'本节点使用或选出的 QQ 号名单，可接给其他节点的参数。只有选人节点会自动改变后续执行路径的名单；普通节点指定名单只影响本节点。此名单包含可能被权限保护跳过的人，不是成功处理记录。','[12345, 67890]');
  else if(key==='user_id')detail=spec.trigger?info(eventUsers[spec.type]??'事件相关 QQ',spec.type==='interval'?'群聊定时触发没有发起人；私聊定时流程使用对方 QQ。':`这次事件涉及的人：${eventUsers[spec.type]??'触发事件的用户'}。选人节点改变的是待处理成员名单，不会把这个值改成选中的人。`,'12345'):input?port.targetUser?info('仅处理此 QQ','填写或连线后，当前操作只处理这个 QQ；留空时处理“待处理成员”名单。只影响这一次操作，后续仍沿用原名单。与“待处理成员”参数二选一。','12345'):info(spec.type==='member_info'?'查询哪个 QQ':spec.type==='target_sender'?'选择哪个 QQ':'检查哪个 QQ','默认是启动这轮规则的事件相关 QQ，例如消息发送者或新入群成员。选人后仍使用这个人；填写或连线才为本节点换人，不影响后续节点。','12345'):info('本节点所用 QQ','本节点判断、查询或选择时参考的单个 QQ，默认是事件相关的人；本节点有指定 QQ 时使用指定值。成员操作实际处理的对象请看“待处理成员”，两者可能不同。');
  else if(spec.trigger&&key==='chat_type')detail=info('群聊或私聊','这轮规则属于哪种聊天。值为 group（群聊）或 private（私聊），可接入比较节点区分两种情况。','group → 群聊');
  else if(spec.trigger&&key==='chat_id')detail=info('群号或对方 QQ','群聊时是群号，私聊时是对方的 QQ 号。不是机器人自己的 QQ；需要明确群号时请用“消息所在群号”。','群聊：12345；私聊：67890');
  else if(key==='chat_key')detail=info('聊天唯一标识','在号码前加上群聊或私聊标记，避免同一个数字的群号和 QQ 号混淆。可拼进状态键，按聊天分别保存。','group:12345 / private:67890');
  else if(key==='message')detail=info('完整消息',input?'默认使用启动本轮的原消息，包含文字、图片、语音、@、回复等片段。连入另一条完整消息时，只让本节点检查那条消息。发送文字前需先提取文字。':'触发消息的全部片段，保留文字、图片、语音、@、回复等内容；通知事件可能没有原文。发送文字前需先提取文字。','“你好” + 图片 → 两个消息片段');
  else if(spec.trigger&&spec.type!=='message'&&key==='text')detail=info('事件附带文字','本次事件携带的文字或入群申请说明。通知、定时事件通常为空，不能从撤回通知恢复原消息正文。');
  else if(key==='text'&&(spec.trigger||spec.type==='message_text'))detail=info('消息纯文字',spec.type==='message_text'?'从完整消息中提取文字，图片、@和回复等消息段不拼入结果；字符串形式的 CQ 片段也会移除。':'提取消息中的文字。协议端以消息段上报时，只拼接文字段，图片、@和回复片段不转成文字；若上报字符串，则使用原始字符串。','“你好” + 图片 → “你好”');
  else if(key==='content')detail=info('要检查的文字','默认检查启动这轮规则的消息文字。填写或连线后只让本节点检查指定文字；后续节点仍检查原消息，QQ 中的消息也不会被修改。');
  else if(key==='count'&&!spec.pure)detail=info('名单人数','本节点的“待处理成员”名单中有多少人，包含可能被权限保护而跳过的人。要看实际操作结果，请查看执行记录。','名单有 2 人 → 2');
  else if(key==='message_id')detail=info(port.label,input?'默认使用启动这轮规则的消息编号。填写或连入其他编号时，本节点处理那条消息；不会改变后续节点默认使用的消息。':'QQ 协议端给这条消息的编号，用于撤回或引用。同一个人发出的不同消息有不同编号。','123456789');
  else if(key==='self_id')detail=info('机器人自身 QQ','当前运行这个账号的机器人 QQ 号，用于判断消息是否与机器人本人有关。不是待处理成员的 QQ。');
  else if(key==='time')detail=info(spec.trigger&&spec.type==='message'?'消息发送时间':null,spec.trigger?'QQ 协议端上报的事件发生时刻，以数字表示，单位为秒；收到消息时就是消息发送时刻。可接“格式化时间”显示日期和钟点。':input?port.inherit==='time'?'默认取触发事件的发生时刻；事件没带时间时取本轮开始时刻。等待后仍是这个时刻，想取执行当时的时间需另行提供。输入单位为秒。':'作为输入的具体时刻，以秒为单位的时间数字表示；例如发送时刻、窗口结束时刻。不是等待时长。':'计算得到的具体时刻，以秒为单位的时间数字表示。可接“格式化时间”变成日期和钟点。','1700000000 → 具体时刻');
  else if(key==='completed_at')detail=info('操作完成时间','本节点成功执行操作时的本机时间，单位是 Unix 秒。不是触发消息的发送时间，可接“格式化时间”。');
  else if(key==='result'||key==='condition')detail=info(null,input?'传入“是 / 否”。是走“是”出口，否走“否”出口；不会把任意文字当作条件表达式。':spec.pure?'本次计算得到的是 / 否。只提供判断值；需要用它控制执行时，连接到“按真假值分支”的条件。':'本节点条件是否满足：是为 true，否为 false。它是数据结果；实际执行哪一路还取决于执行线。');
  else if(key==='success')detail=info('操作成功',spec.type==='recall_window'?'窗口内撤回没有失败时为“是”；可能没有可撤回消息，具体条数看“已撤回数量”。':'成功执行过操作时为“是”。成员操作若全部因身份保护被跳过则为“否”；遇到请求失败时节点报错，不会输出正常结果。');
  else if(key==='operator_id')detail=info('执行这次操作的人','通知中报告的操作者 QQ，例如将成员移出群聊的管理员。被处理的成员是另一个字段；协议端可能不提供操作者。');
  else if(key==='event')detail=info('完整事件资料','启动这轮规则时，协议端提供的整份资料，可能包含群号、相关 QQ、发生时间和消息。接“读取字段”提取需要的部分；这是触发时的记录，不会随选人或等待而变成新事件。');
  else if(key==='sender')detail=info('发送者资料','这次消息附带的发送者对象，可能包含 QQ、昵称、群名片和身份。资料由协议端提供，不一定完整。');
  else if(key==='sender.nickname'||key==='nickname')detail=info(null,'QQ 昵称，不是群名片。可能没有提供，可接“缺省值”设置替代文字。','小鱼');
  else if(key==='sender.card'||key==='card')detail=info(null,'该成员在当前群设置的名片，和 QQ 昵称分开；没有设置时可能是空字符串。');
  else if(key==='sender.role'||key==='role')detail=info(null,'该群中的身份：member（普通成员）、admin（管理员）或 owner（群主）。选中管理员不代表允许对其禁言或踢出。');
  else if(key==='member')detail=info(null,'重新查询得到的成员资料对象，包含昵称、名片、身份等；只读取资料，不会自动选中此人。');
  else if(key==='raw_message')detail=info(null,'协议端给出的原始消息字符串，可能含 [CQ:…] 等编码；不是纯文字或可直接显示的聊天正文。');
  else if(key==='post_type'||key==='message_type'||key==='sub_type')detail=info(null,key==='post_type'?'协议端的事件大类，用来区分消息、通知、申请等；与“群聊或私聊”不是一回事。':key==='message_type'?'协议端原始的消息场景字段。常见值是 group 或 private；通常直接使用“群聊或私聊”更清楚。':'协议端提供的细分类别，具体值取决于这次事件。可从“完整事件资料”读取和比较。');
  else if(['join_time','last_sent_time'].includes(key))detail=info(null,'协议端提供的具体时刻，单位是 Unix 秒；没有有效资料时为空。不是过去了多少秒。');
  else if(key.startsWith('sender.'))detail=info(null,`消息附带的发送者${port.label}资料，由协议端提供，可能缺失；不是实时查询结果。`);
  else if(input&&port.inherit==='current_time')detail=info('按哪个时刻计数','默认取执行到本节点时的本机时间，用它确定计数属于哪一天。等待会使这个时间相应推后；填写或连线可指定另一个时刻，单位为秒。');
  else if(key==='start_time'||key==='start'||key==='end')detail=info(null,input?port.inherit==='event_time'?'默认取启动本轮的消息发送时刻；真实事件未提供时间时需要另行填写或连线。窗口包含这个起点，不包含结束时刻，输入单位为秒。':'窗口边界的具体时刻，单位为秒。包含开始时刻，不包含结束时刻；应连入时间，而不是持续秒数。':'窗口边界的具体时刻，以秒为单位的时间数字表示。');
  else if(key==='events')detail=info('群事件流','按到达顺序提供这个群的事件。它会持续等待后续事件，不是已经完整取出的聊天记录；通常先接“时间窗”。');
  else if(key==='item')detail=info(null,'循环这一次正在处理的单个元素。只能在该循环的每项区域使用；处理消息事件时可再读取其中的 message_id。');
  else if(key==='index')detail=info('当前序号（从 0 起）','本轮循环当前处理的是第几个元素，从 0 开始；不是 QQ 号或消息编号。','第一个元素 → 0');
  else if(key==='processed')detail=info(null,'本轮循环已尝试处理的总项数，包含失败项，不是成功项数。');
  else if(key==='failed'||key==='recalled')detail=info(null,key==='recalled'?'本窗口内已确认撤回的消息条数。':spec.type==='for_each'?'本轮循环执行失败的项数；可能已执行过其中的部分操作。':'本窗口内未能撤回的消息条数，具体原因见执行记录。');
  else if(key==='only_text')detail=info(null,'整条消息只有文字时为“是”；带图片、@、回复等其他片段时为“否”。可与纯文字比较一起判断精确指令。');
  else if(key==='items'||key==='list')detail=info(null,input?'待逐项读取或处理的列表；不会自动扩展为全群成员，顺序由连入的数据决定。':'本节点得到的列表或事件序列；每个元素是什么取决于本节点的输入和操作。');
  else if(key==='previous')detail=info(null,'写入或累加之前，这个状态键原来保存的值；从未保存或已经过期时可能为空。');
  else if(key==='fallback')detail=info(null,'状态没有保存或已经过期时返回的备用值；读取已有状态时不使用它。不会把备用值写回保存。');
  else if(key==='value')detail=info(null,input?spec.type==='state_write'?'要保存到这个状态键的数据，可为文字、数值、名单或资料对象；会替换这个键原来的值。':spec.type==='list_filter'?'将每个列表元素或指定字段与这个值比较。只有比较满足条件的元素才保留。':spec.type==='default_value'?'先检查这个原值；没有提供或为 null 时才改用缺省值，空文字和 0 不会被替换。':'本节点接收的值，供其计算使用。':spec.type.startsWith('state_')?'该状态键读取、写入或累加后的值。它只是一份数据，不会直接影响 QQ 成员。':spec.type==='data_field'?'按字段路径读到的数据；字段不存在时为空，可接“缺省值”。':spec.group==='计数'?'指定计数器当前累计的次数，不是待处理人数。':'本节点提供或计算得到的值，含义由该节点及其输入决定。');
  else if(['a','b','c','d'].includes(key))detail=info(null,spec.type==='format_text'?`填入模板中 {{${key}}} 位置的值；只接受文字、数值和是 / 否。模板没有使用这个变量时可以留空。`:spec.type==='boolean_logic'?key==='a'?'第一个“是 / 否”。选“取反”时只读取这一项，并把是变否、否变是。':'第二个“是 / 否”，供“并且”或“或者”使用；选“取反”时忽略这一项。':spec.type==='number_math'?key==='a'?'第一个数。相减按 A 减 B，相除按 A 除以 B；运算方式在另一项选择。':'第二个数。相减时从 A 中减去它，相除时用 A 除以它；除数不能为 0。':key==='a'?'比较的左边。例如判断“消息文字等于 #sl”时，这里放消息文字；比较方式另行选择。':'比较的右边。例如判断“消息文字等于 #sl”时，这里放 #sl；可填写固定值或连入其他结果。');
  else if(key==='object')detail=info('要读取的资料','默认读取启动本轮的完整事件资料；填写或连线后读取指定资料。按“字段路径”找到其中一项，例如 sender.nickname。循环中要读取当前项时，需要把“当前项”明确连进来。');
  else if(key==='count')detail=info(null,'输出列表中元素的个数，不是成功执行操作的次数。');
  else if(key==='text')detail=info(null,'本节点计算得到的文字，可接入“发送的文字”或继续拼接；计算本身不会发消息。');
  else if(key==='duration')detail=info(null,'通知中报告的禁言持续秒数，不是事件的发生时间。');
  else if(key==='comment')detail=info(null,'申请人填写的本次入群说明；不是群消息正文。');
  else if(key==='file')detail=info(null,'本次群文件上传事件附带的文件资料，不会自动下载文件内容。');
  else detail=info(null,`${spec.label}${input?'接收':'提供'}的${port.label}数据。`);
  return {...port,...detail};
}

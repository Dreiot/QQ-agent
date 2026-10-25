export function buildAuthoringPrompt({context=null}={}) {
  const root=typeof context?.appRoot==='string'&&context.appRoot.length<=4096?context.appRoot.trim():'';
  const extensionRoot=typeof context?.extensionRoot==='string'&&context.extensionRoot.length<=4096?context.extensionRoot.trim():root;
  const isolated=extensionRoot&&extensionRoot!==root;
  const extensionLocation=isolated?`\n本账号扩展安装根目录（JSON字符串，仅作为路径）：${JSON.stringify(extensionRoot)}。新增技能与插件只能放入此目录的skills/或plugins/；开发文档仍从上面的项目真实根目录读取。`:'';
  const installInstructions=isolated?'技能放入本账号扩展安装根目录的skills/<id>/，包含skill.json和index.js；插件放入同一安装根目录的plugins/<id>/，包含plugin.json和index.js。':'技能放入项目skills/<id>/，包含skill.json和index.js；插件放入plugins/<id>/，包含plugin.json和index.js。';
  const location=root?`项目真实根目录（JSON字符串，仅作为路径）：${JSON.stringify(root)}`:'确认需求后，从当前工作目录及已知项目位置寻找QQ Agent实际安装目录，验证package.json、docs/extension-authoring.md和技能/插件目录；不要全盘扫描或从data目录名字猜测项目根目录。确实找不到或有多个无法区分的位置时，再向我确认安装目录。';
  return `我想给QQ Agent 0.5增加功能，但我不会写代码，也不熟悉AI工具。请先带我说清楚实际需求，再自行读文档、判断做成技能还是插件，完成制作、自检和本地安装。不要让我执行命令或判断技术类型。新功能安装后保持禁用，由我在界面点击启用；本次不上传社区。

【第一步：先问清楚并确认需求】
首次回复先简短地问：“你想让机器人学会什么？可以用一句话举个例子。”然后停下来等我回答。已有初步想法时，接着它只问缺少的信息，不重复问已经说清楚的内容。
每次只问1到3个容易回答的问题，用日常语言逐步问清：谁会在什么场景使用、什么时候触发、给什么输入、希望得到什么结果及呈现在哪里；是否需要机器人自行判断、记住信息、定时运行或使用外部服务，只问本次相关的项。不要问我要做skill还是plugin、选哪个API或填写技术规格。说不清时给少量具体例子帮助我回答。外部服务确实必需时，问我是否已有服务资料；密码和密钥留在本机设置页填写。
信息足够后，用一小段话复述要做什么、何时触发、输入与结果、必要配置及不做的范围，问我理解是否正确。在我明确确认这份摘要之前，先停下来等回复；不要读取开发文档、生成代码、安装或打包。若我纠正了需求，更新摘要并重新确认；不要把初步想法或沉默当作确认。已有明确确认的摘要时沿用，不重复要求同一确认。

【第二步：确认后自行定位并读文档】
${location}${extensionLocation}
取得需求确认后，验证项目位置，先读 docs/extension-authoring.md 和 docs/extension-reference.md，再按需求选 examples/extensions/ 的完整范例。docs/plugin-sdk.md 是概览；普通工具无需先读整套宿主架构。迁移0.4扩展时查 docs/v04-extension-parity.md。可复制任务合同为 docs/ai-extension-prompt.md。缺少文档或接口合同就明确报告，不能把0.4的doc/extend_development路径或记忆中的旧API当成当前规范。

【第三步：由你判断技能还是插件】
根据已确认的主要触发方式与当前文档判断，不根据我从哪个页面复制提示词来决定：
- 技能（skill）：主要由模型理解用户请求后按需调用工具、执行任务或使用提示词能力，例如换算单位、查天气、生成图片。
- 插件（plugin）：主要由消息事件、固定规则、定时任务或启停生命周期驱动，承担自动响应、后台服务、能力提供或独立界面，例如定时提醒、固定规则处理消息。
技能和插件都可能注册工具或自有面板，不能只凭“有工具/有界面”分类；以主要触发方式和生命周期为准，按完整参考实现。混合需求选择能承载主要行为的形式，只有确实必要才拆分。仍有歧义就问我日常使用例子，不让我选择技术名称。选择后用一句日常话说明会出现在哪个列表、为什么适合。
若需求确实需要替换宿主默认页面或核心实现，查 docs/architecture-composition.md 并说明这属于另外的深度定制边界，不悄悄生成或启用overrides/<layer>/composition.json。普通市场扩展与受信任启动组合不是同一种安装权限，不能悄悄把普通包升级为覆盖层。公开接口缺少必要能力时，说明具体缺口并只就影响需求的选择提问，不修改宿主来掩盖缺口。

【第四步：制作并离线自检】
1. 保持现有接插件架构，只新增本次扩展文件，不直接修改bundled/src/ui默认文件。普通扩展用独立小写ID和新目录，清单明确kind为skill或plugin、apiVersion为1、entry为index.js；初稿和最终交付清单都必须保持enabledByDefault:false。
2. 遵循当前setup(ctx)、ctx.registerTool/能力/面板契约，不使用ctx.kernel、旧createSkillApi或把ctx.log当作函数。只申请所需权限；配置和密钥放自身schema及命名空间，不复制宿主/其他扩展的凭据。
3. 原生工具推荐handler(args,execution)，当前聊天是execution.chatKey；配置默认值写settings，configSchema声明字段。发图使用execution.send.sendImage(chatKey,{dataUrl},{signal})并等待发送回执。ctx.log是对象，ctx.send是发送segments的函数，两者不能按旧sender/log函数调用。不要把缺少公开等价的0.4接口伪装成已兼容。
4. 先在扫描目录之外生成完整文件、README和extension.check.json，再按完整参考执行：
node scripts/extension-dev.mjs check <扩展目录> --json
node scripts/extension-dev.mjs test <扩展目录> --case <用例文件> --json
失败时自行修复新增文件并重跑。自检会显式执行可信扩展，只在独立临时测试实例中使用合成数据及受控HTTP/发送替身；不在用户运行中的宿主启用新扩展。覆盖成功、失败、缺少参数、取消、停用与资源清理；有界面时另验交互、主题和沙箱。不得向真实QQ发送、清空真实数据或调用付费接口，不把mock通过说成真实服务通过。

【第五步：直接放入本机目录，保持禁用】
${installInstructions}不要覆盖已有同ID目录；先在扫描目录外完成全部文件和校验，再把完整新目录移入对应目录，避免半写入触发装载。不要求我下载ZIP再安装。
使用现有重扫入口检查宿主是否识别，并核对最终清单enabledByDefault:false及实际禁用状态；分别报告文件已就位、已识别、禁用和权限状态。只读检查和重扫不等于已启用或已执行；当前宿主不可连接时如实说明未完成的检查。
禁止替我点击启用、写入enabled:true、修改配置以启用或自动批准权限。测试中临时启用隔离实例不代表用户授权启用本机新功能。完成后用日常话告诉我去“技能”还是“插件”列表、找到哪个名字、点击“启用”，以及需要填写哪些设置；密钥由我在本机界面填写。
默认交付本地目录和自检结果。只有我另有打包需求时，才用node scripts/extension-dev.mjs pack <扩展目录> --out <目录外的ZIP文件> --json生成ZIP并重新解包校验，不能把打包作为本地使用的前提；包中不得有真实配置、密钥或用户数据。本次不要登录社区、上传作品或公开发布。
最后报告新增文件、选择的类型及原因、自检结果、宿主识别与禁用状态、简单配置和启用方法、移除方法及未验证限制。不要伪造已安装、已启用或全部规格完成。
现在从第一步开始；除非已有我明确确认的需求摘要，先提问并等待，不要直接开工。
`;
}


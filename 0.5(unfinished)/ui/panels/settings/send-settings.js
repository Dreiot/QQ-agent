// Compact presentation around the original bound inputs. Explanations describe
// the default runtime; no second configuration or sending policy is introduced.
export const SEND_SETTING_HELP = {
  'api.temperature':'控制回答的变化程度。数值越高，措辞通常越多样；越低，回答通常越稳定。并不代表越高越聪明，部分模型或思考模式会忽略此项。',
  'api.maxRounds':'一次会话最多让模型连续处理多少轮，包括调用工具后继续处理结果。越高，越能完成多步骤任务，但也可能更慢、更费额度；越低，复杂任务越容易提前结束。',
  'api.timeoutMs':'每次等待模型返回结果的最长时间，1000 毫秒等于 1 秒。越大，越能容忍慢请求，但出错时也会等得更久；越小，越快报超时，也越容易打断正常的慢请求。',
  'api.thinkingMode':'决定是否请求模型先思考再回答。“自动”结合模型和思考强度设置决定；“开启”请求思考；“关闭”请求不思考。能否生效取决于模型是否支持。',
  'api.thinkingEffort':'向支持的模型指定思考强度。越高，通常会花更多时间和额度推敲；越低，通常更快。“默认”交给模型决定，“关闭”会关闭思考，即使上面的模式设为开启。',
  'api.thinkingBudget':'向支持此项的模型指定思考额度，通常按 Token 计。越大，允许的思考空间越多，也可能更慢、更费额度；越小，限制越紧。0 表示不额外指定预算，不等于关闭思考。',
  'wakeDelayMs':'收到消息后先等待一小段时间，把接连到来的消息放在一起处理。越大，越容易合并连续发言，但回复也更晚；越小，反应更快，也更容易分成多次处理。',
  'drainDelayMs':'处理完一批消息后，等待多久再处理后续积压。越大，连续处理的节奏越慢；越小，积压清得更快，也更容易连续调用模型。',
  'maxConcurrentRuns':'最多同时处理多少个会话。越大，多个群或好友可同时获得回复，但资源和接口压力也更大；越小，更省资源，其余会话需要排队。同一个会话仍按顺序处理。',
  'sessionRetryAttempts':'会话出错且尚未成功发言时，最多自动重试多少次。越大，临时故障越有机会恢复，但等待和调用成本也会增加；越小，失败后越快结束。0 表示不自动重试，最多 5 次。',
  'send.minGapMs':'分多条发言时，随机停顿的较低基准，实际间隔还会结合字数计算。越大，发言通常越慢；越小，通常越紧凑。应不高于最高间隔；默认发送器还会采用最低等待保护，并非填 0 就完全无停顿。',
  'send.maxGapMs':'分多条发言时，随机停顿的较高基准，实际间隔还会结合字数计算。越大，可能出现的停顿越长；越小，发言通常越紧凑。应不低于最低间隔；并非每条都固定等待这个时长。',
  'send.byLengthMs':'让较长的文字带来更多发送停顿。数值越大，长消息通常等得越久；越小，长短消息之间的等待差异越小。默认发送器对最终停顿设有上限，0 会沿用默认值。',
  'send.maxPerMinute':'每个会话一分钟内最多成功发送多少条。越高，短时间内允许的发言越多；越低，越容易触发限频。达到上限后会拒绝继续发送，不是自动攒到下一分钟再发。',
  'send.maxPerHour':'每个会话一小时内最多成功发送多少条。越高，允许的总发言量越大；越低，限制越严格。达到上限后会拒绝继续发送，需要等待较早的记录过期。',
  'send.hardSplitAt':'过长的文字按此长度拆成多条发送。越大，每条可容纳的文字越多、拆分通常越少；越小，单条更短、条数更多，也更容易触发限频。0 表示不主动按长度拆分。',
  'send.dedupeWindowMs':'在这段时间内，拦截同一会话里已经发送成功的相同消息。越大，防重复的时间越长，也越容易挡住有意重复的内容；越小，允许更快重发。0 表示关闭此项去重。',
  'store.maxMessagesPerChat':'本地为每个群或好友保留多少条消息记录。越大，可保留更久的历史，但会占用更多存储；越小，旧记录越早被清理。0 表示不限。它不等于每次交给模型的历史条数。',
  'store.keepSessionFiles':'本地保留多少份已结束的会话记录。越大，越方便追查旧问题，但占用更多存储；越小，旧会话记录越早被清理。0 表示不限，不会因此清理正在运行的会话。',
  'store.promptAnchor.enabled':'尽量复用交给模型的历史消息前段，让支持缓存的模型接口更容易命中提示词缓存。开启可能节省重复输入成本；关闭则直接使用当前历史。实际是否省钱取决于接口的缓存支持。',
  'store.promptAnchor.maxExtraRead':'使用缓存锚点时，允许累计追加多少条已读历史，超过后重建锚点。越大，旧前段通常能复用更久，但累计内容也更多；越小，锚点更新更频繁。默认逻辑中 0 沿用默认的 5 条。',
};

export const PROACTIVE_SETTING_HELP = {
  'proactive.probability':'每次检查尝试发起话题的概率。25% 表示平均约四次检查尝试一次；仍需满足闲置、准入和运行状态条件。',
  'proactive.idleThresholdMs':'群里至少安静多少秒，才可能成为主动开话题的对象。越大，需要冷场越久，主动打扰通常越少；越小，更早获得发言机会。最少 300 秒（5 分钟），并非安静满这个时间就一定会发言。',
  'proactive.checkIntervalMinMs':'两次主动检查之间，随机等待时间的下限，单位是秒。越大，检查之间至少等得越久；越小，可能检查得更频繁。最少 60 秒，应不大于最长检查间隔。检查不等于一定发言。',
  'proactive.checkIntervalMaxMs':'两次主动检查之间，随机等待时间的上限，单位是秒。越大，可能等得越久才再次检查；越小，最长等待越短。应不小于最短检查间隔；如果填得更小，运行时会按最短间隔处理。检查不等于一定发言。',
};

export function mountSendSettings(host,options={}){
  return mountCompactSettings(host,{help:SEND_SETTING_HELP,id:'send-setting-tooltip',...options});
}

export function mountCompactSettings(host,{help:helpText,id}){
  const doc=host.ownerDocument,win=doc.defaultView,bindings=[];
  let active=null,timer=null,disposed=false;
  const tooltip=doc.createElement('div');tooltip.className='send-setting-tooltip';tooltip.id=id;tooltip.setAttribute('role','tooltip');tooltip.dataset.motion='off';tooltip.hidden=true;
  const heading=doc.createElement('strong'),description=doc.createElement('p');tooltip.append(heading,description);
  if(typeof tooltip.showPopover==='function')tooltip.setAttribute('popover','manual');
  doc.body.append(tooltip);host.classList.add('send-config');
  const listen=(el,type,fn,options)=>{el.addEventListener(type,fn,options);bindings.push(()=>el.removeEventListener(type,fn,options));};
  function hide(){
    win.clearTimeout(timer);timer=null;
    active?.removeAttribute('aria-describedby');active=null;
    if(tooltip.matches(':popover-open'))tooltip.hidePopover();tooltip.hidden=true;
  }
  function position(){
    if(!active)return;const r=active.getBoundingClientRect(),width=doc.documentElement.clientWidth,height=doc.documentElement.clientHeight;
    if(!active.getClientRects().length||r.bottom<0||r.top>=height){hide();return;}
    tooltip.style.maxHeight=`${Math.max(0,height-16)}px`;
    let box=tooltip.getBoundingClientRect();const below=height-r.bottom-16,above=r.top-16,useAbove=below<Math.min(100,box.height)&&above>below;
    // Prefer below; near the viewport edge keep the explanation readable.
    tooltip.style.maxHeight=`${Math.max(0,useAbove?above:below)}px`;box=tooltip.getBoundingClientRect();
    tooltip.style.left=`${Math.max(8,Math.min(r.left,width-box.width-8))}px`;tooltip.style.top=`${useAbove?r.top-box.height-8:r.bottom+8}px`;
  }
  function show(button){
    if(disposed)return;win.clearTimeout(timer);active?.removeAttribute('aria-describedby');active=button;
    heading.textContent=button.dataset.helpTitle;description.textContent=helpText[button.dataset.helpPath];
    tooltip.hidden=false;if(tooltip.hasAttribute('popover')&&!tooltip.matches(':popover-open'))tooltip.showPopover();
    button.setAttribute('aria-describedby',tooltip.id);position();
  }
  const deferHide=()=>{win.clearTimeout(timer);timer=win.setTimeout(()=>{if(!tooltip.matches(':hover')&&!active?.matches(':hover,:focus-visible'))hide();},100);};
  for(const field of host.querySelectorAll('.setting-field[data-path]')){
    const input=field.querySelector('input,select,textarea'),title=field.querySelector('.field-title'),path=field.dataset.path;
    if(!input||!title||!helpText[path])continue;
    const row=doc.createElement('div'),name=doc.createElement('div'),label=doc.createElement('label'),help=doc.createElement('button');
    row.className='send-setting-row';row.dataset.sendSetting=path;name.className='send-setting-name';label.className='send-setting-label';label.htmlFor=input.id;
    title.id=`send-label-${input.id}`;input.setAttribute('aria-labelledby',title.id);label.append(title);
    help.type='button';help.className='send-setting-help';help.textContent='?';help.dataset.motion='off';help.dataset.helpPath=path;help.dataset.helpTitle=title.textContent;help.setAttribute('aria-label',`了解${title.textContent}`);
    name.append(help,label);field.before(row);field.classList.add('send-setting-control');row.append(name,field);
    listen(help,'pointerenter',()=>show(help));listen(help,'pointerleave',deferHide);listen(help,'focus',()=>show(help));listen(help,'blur',deferHide);listen(help,'click',()=>show(help));
  }
  listen(tooltip,'pointerenter',()=>win.clearTimeout(timer));listen(tooltip,'pointerleave',deferHide);
  listen(doc,'pointerdown',event=>{if(active&&!active.contains(event.target)&&!tooltip.contains(event.target))hide();},true);
  listen(doc,'keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();hide();}},true);
  listen(doc,'scroll',event=>{if(!tooltip.contains(event.target))position();},true);listen(host,'toggle',hide,true);listen(win,'resize',position);listen(win,'pagehide',hide);
  return{hide,dispose(){if(disposed)return;disposed=true;hide();for(const unbind of bindings)unbind();tooltip.remove();}};
}

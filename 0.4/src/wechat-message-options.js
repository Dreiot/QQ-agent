const invalid=message=>Object.assign(Error(message),{sendUncertain:false});
// Resolve only the current room's database-backed identities. Display names are labels, not routing keys.
export function resolveWechatMention({key,room,accountId,store,roster=[],atUserId,text}){
  if(atUserId==null)return{text:String(text),atUserIds:[]};
  if(!String(key).startsWith('group:')||!room?.stableId?.endsWith('@chatroom'))throw invalid('原生艾特只用于已绑定的微信群聊');
  const requested=String(atUserId),pairs=Object.entries(room.membersByStableId||{});
  const pair=pairs.find(([stable,local])=>requested===stable||requested===`wxdesktop_${accountId}_${local}`);
  const recent=store?.recent?.(key,{limit:200})||[];
  const record=recent.find(entry=>entry.principal?.verified===true&&entry.principal?.source==='database'&&entry.principal?.platform==='wechat'&&
    (entry.senderId===requested||entry.principal.id===requested));
  const member=roster.find(entry=>entry.chatName===room.name&&entry.id===requested);
  const id=pair?.[0]||record?.principal?.id||member?.id;
  if(!id||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw invalid('找不到此群内已核验的微信成员，请使用当前消息中的发送者 ID');
  const name=String(record?.senderName||roster.find(entry=>entry.chatName===room.name&&entry.id===id)?.name||id).replace(/[\r\n\0]/g,' ').slice(0,80);
  const label='@'+name,body=String(text);
  const alreadyNamed=body.startsWith(label)&&/^[\s\u2005]/u.test(body.slice(label.length));
  return{text:alreadyNamed?body:`${label}\u2005${body}`,atUserIds:[id]};
}

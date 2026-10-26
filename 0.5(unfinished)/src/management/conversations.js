export const conversationScope=(kind,id)=>kind==='private'?'private:'+String(id):String(id);
export const hasConversation=(rule,kind,id)=>(kind==='private'?rule.private??[]:rule.groups??[]).includes(String(id));
export const ruleConversations=rule=>[...(rule.groups??[]).map(id=>({kind:'group',id})),...(rule.private??[]).map(id=>({kind:'private',id}))];

// Permission checks occur immediately before each QQ action, independently of the UI.
export function createModerationActions({client,currentIdentity}){
  const id=value=>{if(!/^[1-9]\d{0,15}$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw Error('群号或 QQ 号无效');return Number(value);};
  function check(result){if(!result||result.status&&result.status!=='ok'||result.retcode!=null&&Number(result.retcode)!==0||!(result.status==='ok'||result.retcode!=null&&Number(result.retcode)===0))throw Error('协议端未确认管理操作成功');return result.data;}
  const scope=options=>{const identity=currentIdentity();if(!identity)throw Error('账号尚未连接');return()=>{if(options?.signal?.aborted||currentIdentity()!==identity||options?.current?.()===false)throw Error('账号或协议连接已改变，管理操作已取消');};};
  async function member(group,user,options={}){const guard=scope(options);guard();const data=check(await client.call('get_group_member_info',{group_id:id(group),user_id:id(user),no_cache:true},{signal:options.signal}));guard();if(!data||String(data.user_id)!==String(user)||!['owner','admin','member'].includes(data.role))throw Error('无法确认群成员身份');return {userId:String(data.user_id),role:data.role,nickname:data.nickname??'',card:data.card??'',joinTime:Number(data.join_time)||0,lastSentTime:Number(data.last_sent_time)||0};}
  return {
    getModerationMember:member,
    async getModerationMembers(group,options={}){const guard=scope(options);guard();const data=check(await client.call('get_group_member_list',{group_id:id(group)},{signal:options.signal}));guard();if(!Array.isArray(data))throw Error('无法读取群成员列表');return data.map(m=>({userId:String(m.user_id),role:m.role,card:m.card??'',nickname:m.nickname??'',joinTime:Number(m.join_time)||0}));},
    async moderateGroup(group,operation,options={}){
      const guard=scope(options),group_id=id(group),selfId=String(client.selfId);guard();
      const self=await member(group,selfId,options);if(!['owner','admin'].includes(self.role))throw Error('机器人不是群主或管理员');
      const {action,userId,value,seconds,messageId}=operation;let api,args={group_id};
      const ownerOnly=['grant_admin','revoke_admin','special_title'].includes(action);if(ownerOnly&&self.role!=='owner')throw Error('该操作仅机器人为群主时可执行');
      if(['mute','unmute','kick','rename_card','grant_admin','revoke_admin','special_title'].includes(action)){
        const target=await member(group,userId,options);if(String(userId)===selfId||target.role!==(action==='revoke_admin'?'admin':'member'))throw Error('不能对机器人、群主或身份不适用的成员执行此操作');args.user_id=id(userId);
      }
      if(action==='mute'||action==='unmute'){const duration=action==='unmute'?0:Number(seconds);if(!Number.isFinite(duration)||duration<0||duration>2592000)throw Error('禁言时长无效');api='set_group_ban';args.duration=Math.floor(duration);}
      else if(action==='kick'){api='set_group_kick';args.reject_add_request=false;}
      else if(action==='rename_group'||action==='rename_card'){if(typeof value!=='string'||!value.trim()||value.length>60)throw Error('名称需要 1–60 字');api=action==='rename_group'?'set_group_name':'set_group_card';args[action==='rename_group'?'group_name':'card']=value.trim();}
      else if(action==='whole_mute'||action==='whole_unmute'){api='set_group_whole_ban';args.enable=action==='whole_mute';}
      else if(action==='grant_admin'||action==='revoke_admin'){api='set_group_admin';args.enable=action==='grant_admin';}
      else if(action==='special_title'){if(typeof value!=='string'||!value.trim()||value.length>18)throw Error('专属头衔需要 1–18 字');api='set_group_special_title';args.special_title=value.trim();args.duration=-1;}
      else if(action==='approve_join'||action==='reject_join'){if(typeof operation.flag!=='string'||!operation.flag||operation.flag.length>500)throw Error('入群申请标识无效');if(typeof value!=='string'||value.length>100)throw Error('拒绝理由过长');api='set_group_add_request';args={flag:operation.flag,sub_type:'add',approve:action==='approve_join',reason:action==='reject_join'?value:''};}
      else if(action==='recall'||action==='recall_window_message'){
        if(!/^-?[1-9]\d*$/.test(String(messageId))||!Number.isSafeInteger(Number(messageId)))throw Error('消息标识无效');
        const message=check(await client.call('get_msg',{message_id:Number(messageId)},{signal:options.signal}));guard();
        if(message?.message_type!=='group'||(message.group_id!=null?String(message.group_id)!==String(group):action!=='recall_window_message'||String(operation.observedGroupId)!==String(group)))throw Error('无法确认撤回消息属于当前群');
        if(action==='recall'){const author=await member(group,message.sender?.user_id??message.user_id,options);if(author.role!=='member'||author.userId===selfId)throw Error('不能撤回受保护成员的消息');}
        // Window cleanup attempts every observed message, including departed
        // members and self messages. QQ confirms each deletion; failed native
        // permissions are reported individually, never treated as success.
        api='delete_msg';args={message_id:Number(messageId)};
      }else throw Error('不支持的管理动作');
      const latest=await member(group,selfId,options);if(!['admin','owner'].includes(latest.role))throw Error('机器人已失去管理权限');
      if(ownerOnly&&latest.role!=='owner')throw Error('机器人已失去群主权限');
      guard();const result=await client.call(api,args,{signal:options.signal});guard();check(result);return {ok:true};
    },
  };
}

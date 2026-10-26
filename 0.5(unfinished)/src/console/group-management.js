export function registerGroupManagementRoutes(http,{management,transport,config,bus}){
  http.route('GET','/api/management',({query})=>{
    if(query?.run){if(!/^[\w-]{1,80}$/.test(query.run))throw Object.assign(Error('执行记录标识无效'),{status:400,expose:true});const run=management.getRun(query.run);if(!run)throw Object.assign(Error('执行记录已过期或不存在'),{status:404,expose:true});return {run};}
    return {...(query?.runs==='1'?{}:{catalog:management.catalog,rules:structuredClone(config.get().management?.rules??[])}),...management.snapshot({summary:true})};
  });
  http.route('POST','/api/management',({body})=>{
    try{
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='rules'))throw Error('请提供规则列表');
      const value=management.validate(body);
      config.update({management:{__replace__:value}});
      bus?.emit('management.update',{changed:true});
      return {ok:true,rules:structuredClone(config.get().management.rules)};
    }catch(error){throw Object.assign(error,{status:400,expose:true});}
  });
  http.route('GET','/api/management/runs',()=>management.snapshot({summary:true}));
  http.route('GET',/^\/api\/management\/runs\/(?<id>[A-Za-z0-9-]{1,80})$/,({params})=>{const run=management.getRun(params.id);if(!run)throw Object.assign(Error('执行记录已过期或不存在'),{status:404,expose:true});return {run};});
  http.route('POST','/api/management/validate',({body})=>{try{return management.validate({rules:[body?.rule]});}catch(error){throw Object.assign(error,{status:400,expose:true});}});
  http.route('POST','/api/management/simulate',async({body})=>{try{return await management.dryRun(body?.rule,body?.scenario);}catch(error){throw Object.assign(error,{status:400,expose:true});}});
  http.route('GET','/api/management/groups',async()=>{
    if(transport.status?.().connected!==true)return {groups:[],connected:false};
    const groups=await transport.actions.listGroups();const result=[];let next=0;
    await Promise.all(Array.from({length:Math.min(4,groups.length)},async()=>{while(next<groups.length){const index=next++,group=groups[index];let role='unknown';try{role=(await transport.actions.getModerationMember(group.id,transport.selfId))?.role??'unknown';}catch{}result[index]={...group,role,allowed:true};}}));
    return {groups:result,connected:true};
  });
}

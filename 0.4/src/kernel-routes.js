// Uses the console's existing authorization/origin gates. No extra port or shell.
export function kernelRoutes({kernelControl,readBody}){let requested=false;return[
  {method:'GET',pattern:'/api/kernel/status',handler:({res,json})=>json(res,200,kernelControl?.status?.()||{restartAvailable:false,reason:'桌面壳尚未启用独立内核管理；首次启用需退出重开软件'})},
  {method:'POST',pattern:'/api/kernel/restart',handler:async({req,res,json})=>{
    await readBody(req);if(!kernelControl?.requestRestart)return json(res,409,{error:'当前运行方式不支持原地重启内核；首次启用请完整重开QQ Agent'});
    if(requested)return json(res,202,{ok:true,restarting:true,reused:true});requested=true;
    json(res,202,{ok:true,restarting:true,pid:kernelControl.status().pid});
    const timer=setTimeout(()=>kernelControl.requestRestart(),500);timer.unref?.();
  }}
];}

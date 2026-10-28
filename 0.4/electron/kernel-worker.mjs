// Fresh module graph on every restart; renderer and browser login stay in main.
const channel=process.parentPort;
const bootAt=Date.now();
if(!channel)throw Error('内核只能由QQ Agent桌面壳启动');
let core,timer,stopping=false,bootReady=false,prior={};
try{prior=JSON.parse(process.env.QQ_AGENT_KERNEL_STATE||'{}');}catch{}
const runtime=()=>({paused:core?.orchestrator.paused===true,pauseReason:core?.orchestrator.pauseReason||null,});
const preferences=()=>({server:{autoStart:core?.getConfig().server?.autoStart===true,closeToTray:core?.getConfig().server?.closeToTray!==false}});
const snapshot=()=>({preferences:preferences(),runtime:runtime()});
channel.on('message',async({data:m})=>{
  if(!m?.id||!core)return;
  try{
    if(m.op==='stop'){
      if(stopping)throw Error('内核正在停止');stopping=true;clearInterval(timer);const saved=runtime();
      await core.stop({preserveHelpers:m.preserveHelpers===true});channel.postMessage({id:m.id,ok:true,runtime:saved,preferences:preferences()});setImmediate(()=>process.exit(0));return;
    }
    if(stopping)throw Error('内核停止中，未接收新操作');
    if(m.op==='toggle-pause')core.orchestrator.setPaused(!core.orchestrator.paused);
    else if(m.op==='set-autostart'&&typeof m.enabled==='boolean')core.updateConfig({server:{autoStart:m.enabled}});
    else throw Error('不支持的内核操作');
    channel.postMessage({id:m.id,ok:true,...snapshot()});
  }catch(error){if(m.op==='stop')stopping=false;channel.postMessage({id:m.id,ok:false,error:String(error.message)});}
});
process.on('unhandledRejection',error=>console.error('[内核未处理异常]',error));
process.on('uncaughtException',error=>{channel.postMessage({type:'fatal',error:String(error.message)});process.exit(1);});
try{
  const {createApp}=await import('../src/app.js');core=createApp({kernelControl:{status:()=>({restartAvailable:bootReady,ready:bootReady,pid:process.pid,startedAt:bootAt}),requestRestart:()=>channel.postMessage({type:'restart-requested'})}});
  if(prior.paused===true)core.orchestrator.setPaused(true,prior.pauseReason==='sleep-cycle'?'sleep-cycle':'manual');
  const port=await core.start();bootReady=true;channel.postMessage({type:'ready',port,...snapshot()});timer=setInterval(()=>channel.postMessage({type:'state',...snapshot()}),2000);timer.unref();
}catch(error){channel.postMessage({type:'fatal',error:String(error.stack||error)});process.exit(1);}

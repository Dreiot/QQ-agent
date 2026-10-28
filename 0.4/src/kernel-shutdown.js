export async function drainKernel({orchestrator,sender,timeoutMs=45000}){
  sender.stopping=true;for(const id of [...orchestrator.activeRuns.values()])orchestrator.abortSession(id);await orchestrator.abortAll();
  const deadline=Date.now()+timeoutMs;while(orchestrator.activeRuns.size){if(Date.now()>deadline)throw Error('在途会话尚未收尾，未释放实例锁或启动第二个内核');await new Promise(r=>setTimeout(r,40));}
  let timer;try{await Promise.race([Promise.all([...sender.chains.values()].map(chain=>chain(async()=>{}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('发送队列尚未收尾')),timeoutMs);})]);}finally{clearTimeout(timer);}
}

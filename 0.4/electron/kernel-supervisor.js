// One replaceable core process; no second core until the previous one has exited.
export class KernelSupervisor {
  constructor({launch,timeoutMs=60000,onChange=()=>{},onRestartRequested=()=>{}}){Object.assign(this,{launch,timeoutMs,onChange,onRestartRequested});this.child=null;this.waiters=new Map();this.serial=0;this.phase='stopped';this.generation=0;this.preferences={};this.runtime={paused:false,pauseReason:null};this.lastError='';this.operation=null;}
  status(){return{phase:this.phase,pid:this.child?.pid||null,port:this.lastPort||null,generation:this.generation,lastError:this.lastError};}
  changed(){this.onChange(this.status());}
  single(fn){if(this.operation)return this.operation;const p=Promise.resolve().then(fn);this.operation=p;return p.finally(()=>{if(this.operation===p)this.operation=null;});}
  start(){return this.single(()=>this.boot());}
  restart(){return this.single(async()=>{await this.shutdown(true);return this.boot();});}
  async stop(){if(this.operation)await this.operation.catch(()=>{});return this.single(()=>this.shutdown(false));}
  async boot(){
    if(this.child){if(this.phase==='ready')return this.lastPort;throw Error('旧内核尚未退出，未启动第二个内核');}
    this.phase='starting';this.lastError='';this.changed();
    let child;try{child=this.launch(this.runtime);}catch(error){this.phase='failed';this.lastError=error.message;this.changed();throw error;}this.child=child;
    this.exited=new Promise(resolve=>child.once('exit',code=>{if(this.child===child){this.child=null;this.phase=code===0?'stopped':'failed';if(code)this.lastError='内核进程退出，代码 '+code;for(const [id,w]of this.waiters){clearTimeout(w.timer);w.reject(Error(this.lastError||'内核已退出'));this.waiters.delete(id);}this.changed();}resolve(code);}));
    const ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('内核启动超时；窗口保留，未另起第二个内核')),this.timeoutMs);
      child.once('exit',()=>{clearTimeout(timer);reject(Error(this.lastError||'内核启动期间退出'));});
      child.on('message',m=>{
        if(this.child!==child)return;
        if(m?.preferences)this.preferences=m.preferences;if(m?.runtime)this.runtime=m.runtime;
        if(m?.type==='restart-requested'){if(this.phase==='ready')this.onRestartRequested();return;}
        if(m?.type==='ready'){clearTimeout(timer);this.lastPort=m.port;this.generation++;this.phase='ready';this.changed();resolve(m.port);}
        else if(m?.type==='fatal'){clearTimeout(timer);this.lastError=String(m.error||'内核启动失败');reject(Error(this.lastError));}
        else if(m?.id&&this.waiters.has(m.id)){const w=this.waiters.get(m.id);clearTimeout(w.timer);this.waiters.delete(m.id);m.ok===false?w.reject(Error(m.error||'内核操作失败')):w.resolve(m);}
      });
    });
    try{return await ready;}catch(error){this.phase='failed';this.lastError=error.message;this.changed();throw error;}
  }
  rpc(op,fields={}){if(!this.child)return Promise.reject(Error('内核未运行'));const id=++this.serial;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(id);reject(Error('内核操作超时；未强杀或启动第二实例'));},this.timeoutMs);this.waiters.set(id,{resolve,reject,timer});try{this.child.postMessage({id,op,...fields});}catch(error){clearTimeout(timer);this.waiters.delete(id);reject(error);}});
  }
  async shutdown(preserveHelpers){if(!this.child)return;this.phase='stopping';this.changed();
    let timer;try{await this.rpc('stop',{preserveHelpers});await Promise.race([this.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('旧内核尚未退出，未启动第二个内核')),this.timeoutMs);})]);}catch(error){this.phase='failed';this.lastError=error.message;this.changed();throw error;}finally{clearTimeout(timer);}}
  command(op,fields={}){if(!['toggle-pause','set-autostart'].includes(op))return Promise.reject(Error('未提供任意内核命令入口'));return this.rpc(op,fields);}
}

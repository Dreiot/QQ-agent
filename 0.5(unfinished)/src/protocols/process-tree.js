import {spawn} from 'node:child_process';
import path from 'node:path';

// Only called with a ChildProcess created and retained by this host. Never
// accepts a PID from HTTP, a runtime ZIP, or an upstream process list.
export async function terminateOwnedProtocolProcess(child,{platform=process.platform}={}){
  if(!Number.isSafeInteger(child?.pid)||child.pid<=0)throw new Error('缺少本应用持有的协议端进程');
  if(platform!==process.platform)throw new Error('进程终止平台与宿主不一致');
  if(platform==='win32'){
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    await new Promise((resolve,reject)=>{
      const task=spawn(executable,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      task.once('error',reject);task.once('exit',code=>code===0?resolve():reject(new Error('协议端进程树未能完全停止')));
    });
  }else{
    // The launcher is created in a new process group. Kill that owned group,
    // including supervisors/workers, rather than an arbitrary executable name.
    try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    await new Promise(resolve=>setTimeout(resolve,200));
    try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  }
}

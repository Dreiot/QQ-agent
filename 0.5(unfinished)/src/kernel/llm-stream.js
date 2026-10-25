// Decode an OpenAI-compatible chat stream without retaining transport frames.
// The final message stays identical to the non-streaming tool-loop contract.
const MAX_FRAME=1024*1024,MAX_TEXT=8*1024*1024,MAX_TOOLS=128;
const text=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(p=>p?.type==='text').map(p=>p.text||'').join(''):'';
export async function readChatStream(response,{signal,onDelta=()=>{},reasoningOf=delta=>delta.reasoning_content||delta.reasoning||''}={}){
  if(!response.body?.getReader)throw Error('模型流没有可读取的响应体');
  const reader=response.body.getReader(),decoder=new TextDecoder(),calls=new Map();
  let buffer='',data=[],frameSize=0,characters=0,ended=false,done=false,content='',reasoning='',model='',id='',finishReason=null,usage=null,completed=false;
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  if(signal?.aborted){abort();throw signal.reason??Error('已中止');}
  signal?.addEventListener('abort',abort,{once:true});
  const append=(current,value)=>{characters+=value.length;if(characters>MAX_TEXT)throw Error('模型流输出超过显示上限');return current+value;};
  function emit(){
    if(!data.length)return;const raw=data.join('\n');data=[];frameSize=0;
    if(raw.trim()==='[DONE]'){completed=done=true;return;}
    let frame;try{frame=JSON.parse(raw);}catch{throw Error('模型流包含无法解析的 JSON');}
    if(frame.error)throw Error(`模型请求失败：${frame.error.message||'流式服务返回错误'}`);
    model=frame.model||model;id=frame.id||id;if(frame.usage)usage=frame.usage;
    const choice=frame.choices?.find(item=>(item.index??0)===0);if(!choice)return;
    const delta=choice.delta||choice.message||{},part=text(delta.content),thought=reasoningOf(delta)||'';
    if(part)content=append(content,part);if(thought)reasoning=append(reasoning,String(thought));
    for(const entry of delta.tool_calls||[]){
      const index=Number(entry.index??0);if(!Number.isSafeInteger(index)||index<0||index>=MAX_TOOLS)throw Error('模型流工具索引无效');
      const call=calls.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};
      if(entry.id)call.id=append(call.id,entry.id);if(entry.type)call.type=entry.type;
      if(entry.function?.name)call.function.name=append(call.function.name,entry.function.name);
      if(entry.function?.arguments)call.function.arguments=append(call.function.arguments,entry.function.arguments);
      calls.set(index,call);
    }
    if(choice.finish_reason!=null){finishReason=choice.finish_reason;completed=true;}
    if(part||thought)onDelta({content:part,reasoning:String(thought)});
  }
  function line(value){
    if(!value){emit();return;}if(value.startsWith(':'))return;
    if(value.startsWith('data:')){const part=value.slice(5).replace(/^ /,'');data.push(part);frameSize+=part.length;}
    if(frameSize>MAX_FRAME)throw Error('模型流单帧过大');
  }
  function result(){
    const message={role:'assistant',content};if(reasoning)message.reasoning_content=reasoning;
    if(calls.size)message.tool_calls=[...calls].sort((a,b)=>a[0]-b[0]).map(([,value])=>value);
    return{id,model,choices:[{index:0,message,finish_reason:finishReason}],usage};
  }
  try{
    while(true){
      if(signal?.aborted)throw signal.reason??Error('已中止');
      const chunk=await reader.read();if(signal?.aborted)throw signal.reason??Error('已中止');
      if(chunk.done){ended=true;break;}buffer+=decoder.decode(chunk.value,{stream:true});
      let at;while((at=buffer.indexOf('\n'))!==-1){const value=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);line(value);if(done)break;}
      if(done)break;
      if(buffer.length>MAX_FRAME)throw Error('模型流单行过大');
    }
    if(!done){buffer+=decoder.decode();if(buffer)line(buffer.replace(/\r$/,''));emit();}
    if(!completed)throw Error('模型请求失败：流式响应提前结束');
    return result();
  }catch(error){
    // Once both the completed choice and its bill arrived, cancellation must
    // still return that bill to the runner (which blocks tool execution).
    if(signal?.aborted&&finishReason!=null&&usage)return result();
    throw error;
  }finally{signal?.removeEventListener('abort',abort);if(!ended)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A cancelled reader may still be releasing its pending read. */}}
}

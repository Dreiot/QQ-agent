import assert from 'node:assert/strict';
import {runAgent} from '../src/kernel/agent-runner.js';
import {chatCompletion} from '../src/kernel/llm.js';

// Reproduce the real provider's reasoning -> tool -> next request -> archive
// path. Both transport forms must retain the model's exact completed reasoning.
for(const stream of [true,false]){
  const requests=[],progress=[],snapshots=[];
  const thoughts=['完整首轮推理🧩','工具结果已核验'];
  const cfg={api:{baseUrl:'https://reasoning.example.test',apiKey:'test-only',model:'reasoning-test',maxRounds:2,timeoutMs:5000}};
  const output=await runAgent({session:{id:`reasoning-${stream}`},cfg,systemPrompt:'local fixture',userPrompt:'local fixture',
    tools:[{type:'function',function:{name:'local_echo',parameters:{type:'object',properties:{}}}}],
    callLLM:args=>chatCompletion({...args,...(!stream?{onDelta:undefined}:{}),fetchFn:async(_url,options)=>{
      const body=JSON.parse(options.body),round=requests.length;requests.push(body);
      if(round===1){
        const previous=body.messages.find(m=>m.role==='assistant');
        assert.equal(previous.reasoning_content,thoughts[0],'tool continuation must send back the completed reasoning');
        assert.ok(previous.tool_calls?.length);
        assert.ok(body.messages.some(m=>m.role==='tool'));
        for(const m of body.messages)for(const key of ['raw','generationState','generationDurationMs','toolCall','activeStep'])assert.equal(key in m,false,`${key} is display metadata`);
      }
      const message={role:'assistant',content:round?'已完成':'',reasoning_content:thoughts[round],...(round?{}:{tool_calls:[{id:'echo-one',type:'function',function:{name:'local_echo',arguments:'{}'}}]})};
      const finish_reason=round?'stop':'tool_calls',usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
      if(!stream)return Response.json({choices:[{message,finish_reason}],usage});
      const packet=delta=>`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`;
      const chunks=[packet({reasoning_content:thoughts[round].slice(0,3)}),packet({reasoning_content:thoughts[round].slice(3)}),packet({content:message.content,tool_calls:message.tool_calls?.map((call,index)=>({...call,index}))}),`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason}],usage})}\n\ndata: [DONE]\n\n`];
      return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
    }}),invokeTool:async()=>({ok:true,result:'echo'}),onStream:e=>progress.push(structuredClone(e)),onRound:s=>snapshots.push(structuredClone(s)),log:{warn(){},error(){}}});
  assert.equal(output.error,null);assert.equal(requests.length,2);
  const replies=output.messages.filter(m=>m.role==='assistant');
  assert.deepEqual(replies.map(m=>m.reasoning_content),thoughts,'both tool and plain-stop archive entries retain exact reasoning');
  assert.equal(replies[1].content,'已完成');assert.equal(output.usage.totalTokens,30);
  assert.deepEqual(snapshots.at(-1).messages.filter(m=>m.role==='assistant').map(m=>m.reasoning_content),thoughts);
  if(stream){assert.ok(progress.some(e=>e.step.reasoning===thoughts[0]));assert.equal(replies[0].reasoning_content.length,thoughts[0].length,'deltas must not be appended again to the final response');}
}
console.log('✓ 307 streamed and JSON reasoning survive tool continuation, plain completion, final snapshots and clean model messages');

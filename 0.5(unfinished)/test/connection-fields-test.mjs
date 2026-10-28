import assert from 'node:assert/strict';
import test from 'node:test';
import {FormState} from '../ui/panels/settings/form-state.js';
import {syncEffectiveConnection} from '../ui/panels/settings/connection-fields.js';
import {createOneBotConnectionResolver} from '../bundled/transport-onebot/connection.js';
test('manual addresses mirror actual endpoints without generating saves or copying secrets',()=>{
  const form=new FormState({onebot:{wsUrl:'ws://127.0.0.1:3001',httpUrl:'http://127.0.0.1:3000',hasAccessToken:true},other:{kept:true}}),controls=new Map(['wsUrl','httpUrl'].map(key=>['onebot.'+key,{value:form.value('onebot.'+key)}]));
  assert.equal(syncEffectiveConnection({form,controls,payload:{onebot:{connection:{wsUrl:'ws://127.0.0.1:18002/',httpUrl:'http://127.0.0.1:18001/'}}}}),true);assert.equal(controls.get('onebot.wsUrl').value,'ws://127.0.0.1:18002/');assert.equal(form.dirty,false);assert.equal(form.base.onebot.hasAccessToken,true);assert.deepEqual(form.base.other,{kept:true});
  form.set('onebot.wsUrl','ws://127.0.0.1:19999');controls.get('onebot.wsUrl').value='ws://127.0.0.1:19999';syncEffectiveConnection({form,controls,payload:{connection:{wsUrl:'ws://127.0.0.1:18002',httpUrl:'http://127.0.0.1:19001'}}});assert.equal(controls.get('onebot.wsUrl').value,'ws://127.0.0.1:19999');assert.equal(controls.get('onebot.httpUrl').value,'http://127.0.0.1:19001');assert.equal(form.pending.size,1);
  const snapshot=form.snapshot();form.accept(snapshot);syncEffectiveConnection({form,controls,edited:new Set(['onebot.wsUrl']),payload:{connection:{wsUrl:'ws://127.0.0.1:17002'}}});assert.equal(controls.get('onebot.wsUrl').value,'ws://127.0.0.1:19999');
});
test('focused address and parent-level manual draft survive runtime refreshes',()=>{
  const form=new FormState({onebot:{wsUrl:'old'}}),input={value:'typing'},controls=new Map([['onebot.wsUrl',input]]);syncEffectiveConnection({form,controls,activeElement:input,payload:{connection:{wsUrl:'new'}}});assert.equal(input.value,'typing');assert.equal(form.base.onebot.wsUrl,'old');
  form.set('onebot',{wsUrl:'draft'});syncEffectiveConnection({form,controls,payload:{connection:{wsUrl:'new'}}});assert.equal(form.value('onebot.wsUrl'),'draft');assert.equal(input.value,'typing');
});
test('selected QQ identity is carried into the actual OneBot client binding',()=>{
  const resolve=createOneBotConnectionResolver(),config={onebot:{wsUrl:'ws://127.0.0.1:18002',httpUrl:'http://127.0.0.1:18001',accessToken:'fixture-token',expectedSelfId:'12345678'}};const actual=resolve(config);assert.equal(actual.expectedSelfId,'12345678');assert.equal(actual.accountId,'12345678');assert.equal(actual.scopedCredentials,true);assert.equal(actual.connectionError,null);assert.notEqual(resolve({...config,onebot:{...config.onebot,expectedSelfId:'87654321'}}).bindingKey,actual.bindingKey);assert.ok(resolve({...config,onebot:{...config.onebot,expectedSelfId:'invalid'}}).connectionError);
});

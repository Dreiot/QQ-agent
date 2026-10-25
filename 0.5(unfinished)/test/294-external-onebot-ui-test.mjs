// Static contract for an external, user-managed OneBot service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('panels/manifest.json'));

test('default navigation contains only supported application panels', () => {
  assert.deepEqual(manifest.panels.map(panel => panel.id), ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']);
  for (const panel of manifest.panels) {
    assert.ok(fs.existsSync(new URL(`../ui/panels/${panel.id}/index.html`, import.meta.url)));
    assert.ok(panel.api.every(api => panel.id==='settings'&&['/api/local-protocols/stop','/api/accounts/stop'].includes(api.path)||!/\/(?:launch|stop|open-webui)$/.test(api.path)));
  }
  const settings = manifest.panels.find(panel => panel.id === 'settings');
  assert.ok(settings.navigation.sections.includes('onebot'));
});

test('settings retain explicit protocol endpoints and credentials alongside local package management', () => {
  const settings = read('panels/settings/panel.js');
  const paths = [...settings.matchAll(/(?:field|secretField)\(link, '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(paths, ['onebot.wsUrl','onebot.httpUrl','onebot.accessToken','onebot.httpAccessToken']);
  assert.match(settings, /已有协议端也可手动连接/);
  assert.match(settings, /localProtocols\.mount\(localHost\)/);
  const local=manifest.panels.find(panel=>panel.id==='settings').api.filter(api=>api.path.startsWith('/api/local-protocols'));
  assert.deepEqual(local.map(api=>[api.method,api.path]),[['GET','/api/local-protocols'],['POST','/api/local-protocols/rescan'],['POST','/api/local-protocols/start'],['POST','/api/local-protocols/stop'],['POST','/api/local-protocols/settings'],['GET','/api/local-protocols/output'],['GET','/api/local-protocols/login'],['POST','/api/local-protocols/login/connect'],['POST','/api/local-protocols/login/refresh'],['POST','/api/local-protocols/login/inject'],['POST','/api/local-protocols/login/close'],['POST','/api/local-protocols/login/visibility']]);
  for(const panel of manifest.panels.filter(panel=>panel.id!=='settings'))assert.ok(!panel.api.some(api=>api.path.startsWith('/api/local-protocols')||api.path.startsWith('/api/accounts')));
  const start=settings.indexOf("if (name === 'settings-section'"),end=settings.indexOf("if (name === 'status' && payload?.reset)",start);
  assert.ok(start>=0&&end>start,'default panel has its navigation event handler');
  const handler=settings.slice(start,end),declared=manifest.panels.find(panel=>panel.id==='settings').navigation.sections;
  const connectionStart=settings.indexOf('let pendingConnectQQ=null;'),connectionEnd=settings.indexOf('let settingsReadDeferred=',connectionStart);assert.ok(connectionStart>=0&&connectionEnd>connectionStart,'connection intent has a bounded readiness helper');const connectionHelper=settings.slice(connectionStart,connectionEnd);
  for(const section of [...declared,'unregistered-section']){
    const selected=[],input={value:'old filter'},sections=new Map(declared.map(id=>[id,{}])),context=vm.createContext({name:'settings-section',payload:{section},activeSection:'models',sectionFilter:'old filter',sections,navigationSections:()=>sections,$:()=>input,buildSectionNav(){},selectSection:id=>selected.push(id)});
    vm.runInContext(handler,context);
    assert.deepEqual(selected,declared.includes(section)?[section]:[],section+' follows the declared settings navigation contract');
    if(declared.includes(section)){assert.equal(context.activeSection,section);assert.equal(input.value,'');}
  }
  const cases=[
    {section:'onebot',connectQQ:true,target:undefined,opens:true},
    {section:'onebot',connectQQ:'123456',target:'123456',opens:true},
    {section:'onebot',connectQQ:'12345678901234567890',target:'12345678901234567890',opens:true},
    ...[false,null,'','1234','123456789012345678901',123456,{accountId:'123456'},'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','http://127.0.0.1:5099/'].map(connectQQ=>({section:'onebot',connectQQ,opens:false})),
    {section:'models',connectQQ:true,opens:false},
    {section:'access',connectQQ:'123456',opens:false},
    {section:'not-declared',connectQQ:true,opens:false},
  ];
  for(const {section,connectQQ,target,opens}of cases){
    const selected=[],opened=[],errors=[],input={value:'old filter'},sections=new Map(declared.map(id=>[id,{}])),context=vm.createContext({name:'settings-section',payload:{section,connectQQ},activeSection:'models',sectionFilter:'old filter',settingsStructure:{},loading:false,sections,navigationSections:()=>sections,$:()=>input,buildSectionNav(){},selectSection:id=>selected.push(id),localProtocols:{openLogin:value=>{opened.push(value);return Promise.resolve();}},report:message=>errors.push(message)});
    vm.runInContext(connectionHelper,context);
    vm.runInContext(handler,context);
    assert.deepEqual(opened,opens?[target]:[],'only a valid QQ connection intent opens native login: '+JSON.stringify({section,connectQQ}));
    assert.deepEqual(errors,[]);
  }
  const consumeQueued=settings.match(/if\(pendingConnectQQ!==null&&settingsStructure[^\n]+/);assert.ok(consumeQueued,'settings load consumes a deferred login only after structure is ready');
  const opened=[],context=vm.createContext({settingsStructure:null,loading:true,resetting:false,resetAccepted:false,disposed:false,localProtocols:{openLogin:value=>{opened.push(value);return Promise.resolve();}},report:message=>{throw Error(message);}});vm.runInContext(connectionHelper,context);
  vm.runInContext('openAccountConnection(true);openAccountConnection("123456");',context);assert.deepEqual(opened,[],'early host intent cannot interrupt the initial settings load');assert.equal(vm.runInContext('pendingConnectQQ',context),'123456','the latest explicit target is retained');
  context.settingsStructure={};context.loading=false;context.resetting=true;vm.runInContext(consumeQueued[0],context);assert.deepEqual(opened,[],'resetting blocks native login');context.resetting=false;context.disposed=true;vm.runInContext(consumeQueued[0],context);assert.deepEqual(opened,[],'disposed settings cannot open a native dialog');context.disposed=false;vm.runInContext(consumeQueued[0],context);assert.deepEqual(opened,['123456'],'the account dialog opens once the settings structure is ready');assert.equal(vm.runInContext('pendingConnectQQ',context),null);vm.runInContext(consumeQueued[0],context);assert.deepEqual(opened,['123456'],'a consumed initial intent is not replayed');
});

test('shell readiness directs users to model and external protocol settings', () => {
  const shell = read('shell/index.html'), app = read('shell/app.js');
  assert.deepEqual([...shell.matchAll(/data-readiness="([^"]+)"/g)].map(match => match[1]), ['onebot','model']);
  assert.match(app, /open\('settings',\{section:id==='model'\?'models':'onebot'\}\)/);
  assert.match(read('shell/panel-registry.js'), /\['models','access','onebot'\]\.includes\(section\)/);
});

#!/usr/bin/env node
/*
 * TauriTavern component compatibility audit, not a full Rust/WebView acceptance test.
 * Uses the current product bundle, public synthetic card, actual helper function bodies,
 * and the referenced Tauri iframe-slot/scroll modules. Database API is substituted.
 * Known incompatibilities are reported as observations; exit 0 means the audit completed.
 * Requires the reference trees and Playwright described in docs/development.md.
 * Optional: MVU_REFERENCE_ROOT, MVU_HELPER_ROOT, MVU_TAURI_AUDIT_OUTPUT.
 * Run: node test/tauritavern-audit.js
 */
'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const refs=process.env.MVU_REFERENCE_ROOT || path.resolve(root,'../参考资料');
const out=process.env.MVU_TAURI_AUDIT_OUTPUT || path.join(root,'.tools/tauritavern-compat-audit');
fs.mkdirSync(out,{recursive:true});
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(refs,'测试工具/browsers');
const {chromium}=require(path.join(refs,'测试工具/node_modules/playwright'));
const {applyingApi}=require(path.join(root,'test/helpers'));
const core=require(path.join(root,'src/mvu2shujuku'));
const helper=process.env.MVU_HELPER_ROOT || path.join(refs,'JS-Slash-Runner');
const globalTs=fs.readFileSync(helper+'/src/function/global.ts','utf8');
const globalJs=globalTs.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'').replace(/this: Window, /g,'').replace(/: LiteralUnion<'Mvu', string>|: any|: Promise<void>|: void|: boolean/g,'');
const variablesTs=fs.readFileSync(helper+'/src/function/variables.ts','utf8');
const varsJs=variablesTs.match(/export function _getAllVariables[\s\S]*?\n}/)[0].replace('export ','').replace('this: Window','').replace(': Record<string, any>','').replace('chat_message: any','chat_message');
const predefine=fs.readFileSync(helper+'/src/iframe/predefine.js','utf8');
const jquery=fs.readFileSync(path.join(refs,'SillyTavern/public/lib/jquery-3.5.1.min.js'),'utf8');
const lodash=fs.readFileSync(path.join(refs,'SillyTavern/node_modules/lodash/lodash.js'),'utf8');
const bundle=fs.readFileSync(path.join(root,'index.js'),'utf8');
const nativeGlobalTs=fs.readFileSync(path.join(refs,'MagVarUpdate/src/function/global/index.ts'),'utf8');
const nativeInitJs=nativeGlobalTs.match(/export function initGlobals\(\) \{[\s\S]*?\n}/)[0].replace('export ','');
const result=core.convert(require(path.join(root,'test/synthetic-card'))(),{installMvuShim:true});
result.card.data.avatar='audit-public.png';
const report={scope:'Chromium component harness: real plugin bundle + official helper global/predefine + real Tauri iframe slot/scroll adapter; substitute database API, no Rust/WebView or model',cases:[],errors:[]};
const contentTypes={'.js':'text/javascript','.html':'text/html','.css':'text/css'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><div id="chat" style="height:500px;overflow:auto;overflow-anchor:none"></div></body></html>');return;}
 if(url.pathname==='/jquery.js'){res.setHeader('Content-Type','text/javascript');res.end(jquery);return;}
 if(url.pathname==='/predefine.js'){res.setHeader('Content-Type','text/javascript');res.end(predefine);return;}
 if(url.pathname.startsWith('/tt/')){
  const file=path.resolve(refs,'TauriTavern',url.pathname.slice(4));
  if(!file.startsWith(path.join(refs,'TauriTavern')+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',contentTypes[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}return;
 }
 res.writeHead(404);res.end();
});
async function main(){
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${server.address().port}`;
 report.versions={plugin:JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version,helper:JSON.parse(fs.readFileSync(path.join(helper,'manifest.json'),'utf8')).version,tauri:JSON.parse(fs.readFileSync(path.join(refs,'TauriTavern/package.json'),'utf8')).version};
 report.sourceSha256=Object.fromEntries([['helperGlobal',globalTs],['helperPredefine',predefine],['helperVariables',variablesTs],['pluginBundle',bundle]].map(([k,v])=>[k,require('crypto').createHash('sha256').update(v).digest('hex')]));
 let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base);
  await page.addScriptTag({content:lodash});await page.addScriptTag({content:jquery});
  await page.evaluate(({card,tables,apiSource})=>{
   window.audit={reads:[],errors:[],loads:0};window.auditTables=tables;
   window.api=eval('('+apiSource+')')(tables);
   const handlers={};window.handlers=handlers;
   window.ctx={characters:[card.data],characterId:0,chatId:'audit-A',chat:[{is_user:false,mes:'opening',TavernDB_ACU_IsolatedData:{test:{storageFrame:{version:2,checkpoint:{kind:'full',data:JSON.parse(JSON.stringify(tables))},logEntries:[]}}}}],extensionSettings:{mvu2shujuku:{}},eventSource:{on(n,f){(handlers[n]||=[]).push(f)},once(n,f){const cb=(...a)=>{this.removeListener(n,cb);return f(...a)};this.on(n,cb)},removeListener(n,f){handlers[n]=(handlers[n]||[]).filter(x=>x!==f)},async emit(n,...a){await Promise.all((handlers[n]||[]).slice().map(f=>f(...a)))}},event_types:{CHAT_CHANGED:'chat_changed',MESSAGE_RECEIVED:'message_received',MESSAGE_SENT:'message_sent',MESSAGE_DELETED:'message_deleted',MESSAGE_UPDATED:'message_updated',MESSAGE_SWIPED:'message_swiped'},saveSettingsDebounced(){},async saveChat(){},async saveChatConditional(){}};
   window.SillyTavern={getContext:()=>ctx};window.AutoCardUpdaterAPI=api;
   window.chat=ctx.chat;window.eventSource=ctx.eventSource;
   window.waitUntil=async fn=>{if(!fn())await new Promise(r=>setTimeout(r,30))};
   window._eventEmit=function(n,...a){return eventSource.emit(n,...a)};window._eventOnce=function(n,f){eventSource.once(n,f)};
   window.errorCatched=fn=>async(...a)=>{try{return await fn(...a)}catch(e){audit.errors.push(e.message)}};
   window.getVariables=()=>({});window.getChatMessages=()=>ctx.chat.map((m,i)=>({message_id:i,message:m.mes,data:{}}));
   window._th_impl={writeExtensionField(){}};
  },{card:result.card,tables:result.template,apiSource:applyingApi.toString()});
  await page.addScriptTag({content:globalJs});
  await page.evaluate(()=>{window._getIframeName=function(){return this.frameElement?.id||this.name};window._getCurrentMessageId=function(){return Number(this.frameElement?.closest('.mes')?.getAttribute('mesid')||0)};window._getScriptId=()=>'';window.get_variables_without_clone=()=>({});window.klona=x=>JSON.parse(JSON.stringify(x));window.eventClearAll=()=>{};});
  await page.addScriptTag({content:varsJs});
  await page.evaluate(()=>{
   window.TavernHelper={initializeGlobal,waitGlobalInitialized,errorCatched,eventClearAll,getVariables,getChatMessages,_bind:{_waitGlobalInitialized,_initializeGlobal,_getAllVariables}};
  });
  await page.addScriptTag({content:bundle});
  await page.waitForFunction(()=>typeof Mvu?.replaceMvuData==='function');
  const normalHtml='<script src="/jquery.js"></script><script src="/predefine.js"></script><input id="local" value="initial"><script>window.ready=waitGlobalInitialized("Mvu").then(()=>{window.globalType=typeof Mvu;window.value=getAllVariables();window.boots=(parent.audit.loads+=1);});</script>';
  const makeFrame=async html=>{
   await page.evaluate(html=>{const mes=document.createElement('div');mes.className='mes';mes.setAttribute('mesid','0');const host=document.createElement('div');host.className='TH-render';const f=document.createElement('iframe');f.id='TH-message--0--0';f.srcdoc=html;host.append(f);mes.append(host);document.getElementById('chat').append(mes);window.testFrame=f;window.testHost=host;},html);
   await page.waitForFunction(()=>testFrame.contentWindow.globalType==='object');
  };
  await makeFrame(normalHtml);
  await page.waitForTimeout(2200);
  report.cases.push({name:'official helper waits and sees Mvu',...(await page.evaluate(()=>({globalType:testFrame.contentWindow.globalType,shimVariables:!!testFrame.contentWindow.getVariables?.__mvu2shujuku,read:JSON.stringify(testFrame.contentWindow.getAllVariables().stat_data)===JSON.stringify(getAllVariables().stat_data),mvuDescriptor:{get:!!Object.getOwnPropertyDescriptor(testFrame.contentWindow,'Mvu')?.get,set:!!Object.getOwnPropertyDescriptor(testFrame.contentWindow,'Mvu')?.set}})))});
  // Let the plugin scan the getter-only global installed by helper _waitGlobalInitialized.
  await page.evaluate(async()=>{delete testFrame.contentWindow.Mvu;await window.TavernHelper._bind._waitGlobalInitialized.call(testFrame.contentWindow,'Mvu');testFrame.contentWindow.getVariables=()=>({old:true});});
  await page.waitForTimeout(2200);
  report.cases.push({name:'helper getter-only Mvu allows remaining shims',...(await page.evaluate(()=>({shimVariables:!!testFrame.contentWindow.getVariables.__mvu2shujuku,hasSetter:!!Object.getOwnPropertyDescriptor(testFrame.contentWindow,'Mvu')?.set})))});
  await page.evaluate(()=>Object.defineProperty(testFrame.contentWindow,'Mvu',{value:Mvu,writable:true,configurable:true}));await page.waitForTimeout(2200);
  report.cases.push({name:'writable Mvu control installs remaining shims',...(await page.evaluate(()=>({shimVariables:!!testFrame.contentWindow.getVariables.__mvu2shujuku,dataEqual:JSON.stringify(testFrame.contentWindow.getAllVariables().stat_data)===JSON.stringify(getAllVariables().stat_data)})))});
  await page.evaluate(async()=>{
   const {createManagedIframeSlot}=await import('/tt/src/tauri/main/adapters/embedded-runtime/managed-iframe-slot.js');
   const slot=createManagedIframeSlot({id:'audit-slot',kind:'jsr_html_render',host:testHost,iframe:testFrame,weight:1,priority:0,maxSoftParkedIframes:0,softParkTtlMs:0,onSourceSettled(){}});
   window.slot=slot;testFrame.contentDocument.getElementById('local').value='selected';window.beforeLoads=audit.loads;
   slot.dehydrate('visibility');slot.hydrate();
  });
  await page.waitForFunction(()=>audit.loads>beforeLoads);
  report.cases.push({name:'Tauri cold recovery resets page input',...(await page.evaluate(()=>({local:testFrame.contentDocument.getElementById('local').value,globalType:testFrame.contentWindow.globalType,dataEqual:JSON.stringify(testFrame.contentWindow.value.stat_data)===JSON.stringify(getAllVariables().stat_data),loads:audit.loads-beforeLoads})))});
  await page.waitForTimeout(2300);
  report.cases.push({name:'Tauri cold recovery data after next shim poll',...(await page.evaluate(()=>({dataEqual:JSON.stringify(testFrame.contentWindow.getAllVariables().stat_data)===JSON.stringify(getAllVariables().stat_data),shimVariables:!!testFrame.contentWindow.getVariables.__mvu2shujuku,mvuDescriptor:{get:!!Object.getOwnPropertyDescriptor(testFrame.contentWindow,'Mvu')?.get,set:!!Object.getOwnPropertyDescriptor(testFrame.contentWindow,'Mvu')?.set}})))});
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.srcdoc='<input value="fallback">';document.body.append(frame);window.fallbackFrame=frame;});
  await page.waitForFunction(()=>fallbackFrame.contentWindow.eventOn?.__mvu2shujukuFallback);
  const fallback=await page.evaluate(async()=>{
   const w=fallbackFrame.contentWindow;let calls=0;const handler=()=>calls++;
   const fire=()=>w.dispatchEvent(new w.CustomEvent('audit_event',{detail:{after:{value:1},before:{value:0}}}));
   w.eventOn('audit_event',handler);const registration=w.eventOn('audit_event',handler);
   fire();w.eventOff('audit_event',handler);fire();const afterOff=calls;registration.stop();
   w.eventOn('audit_event',handler);const savedEventOn=w.eventOn;
   ctx.characters[0]={name:'unconverted',avatar:'unconverted.png',data:{character_book:{entries:[]}}};
   await ctx.eventSource.emit('chat_changed');
   fire();return {name:'fallback eventOff and card-switch cleanup',afterOff,afterRestore:calls,fallbackRemoved:w.eventOn!==savedEventOn};
  });report.cases.push(fallback);
  // Native MVU publication protocol only: actual initGlobals body, substituted store/watch/API.
  const nativePage=await browser.newPage();nativePage.on('pageerror',e=>report.errors.push(e.message));await nativePage.goto(base);
  await nativePage.addScriptTag({content:lodash});await nativePage.addScriptTag({content:jquery});
  await nativePage.evaluate(()=>{
   window.chat=[{is_user:false,swipe_id:0,variables:[{stat_data:{sentinel:42}}]}];window.audit={loads:0};
   const handlers={};window.eventSource={emit(n,...a){for(const f of (handlers[n]||[]).splice(0))f(...a)},once(n,f){(handlers[n]||=[]).push(f)}};
   window._eventEmit=function(n,...a){eventSource.emit(n,...a)};window._eventOnce=function(n,f){eventSource.once(n,f)};
   window.waitUntil=async fn=>{if(!fn())throw new Error('native fixture has no MVU data')};
   window._getIframeName=function(){return this.frameElement?.id||this.name};window._getCurrentMessageId=()=>0;window._getScriptId=()=>'';
   window.get_variables_without_clone=()=>({});window.klona=x=>JSON.parse(JSON.stringify(x));window.eventClearAll=()=>{};
   window.SillyTavern={getContext:()=>({chat,writeExtensionField(){}})};window._th_impl={writeExtensionField(){}};
  });
  await nativePage.addScriptTag({content:globalJs});await nativePage.addScriptTag({content:varsJs});
  await nativePage.evaluate(()=>{window.TavernHelper={eventClearAll,_bind:{_waitGlobalInitialized,_getAllVariables}};});
  const nativeSource='window._=parent._;window.createMvu=()=>({getMvuData:()=>({stat_data:{sentinel:42}})});window.useDataStore=()=>({should_enable:true});window.watch=(read,cb)=>{cb(read());return ()=>{}};window.eventEmit=(...a)=>parent.eventSource.emit(...a);'+nativeInitJs+';window.stopNative=initGlobals();';
  await nativePage.evaluate(source=>{const script=document.createElement('iframe');script.srcdoc='<script>'+source+'</script>';document.body.append(script);},nativeSource);
  await nativePage.waitForFunction(()=>typeof window.Mvu?.getMvuData==='function');
  await nativePage.evaluate(html=>{const host=document.createElement('div'),f=document.createElement('iframe');f.id='TH-message--0--0';f.srcdoc=html;host.append(f);document.getElementById('chat').append(host);window.nativeFrame=f;window.nativeHost=host;},normalHtml);
  await nativePage.waitForFunction(()=>audit.loads===1);
  const nativeBefore=await nativePage.evaluate(()=>({globalType:nativeFrame.contentWindow.globalType,data:nativeFrame.contentWindow.value.stat_data}));
  await nativePage.evaluate(async()=>{const {createManagedIframeSlot}=await import('/tt/src/tauri/main/adapters/embedded-runtime/managed-iframe-slot.js');const slot=createManagedIframeSlot({id:'native-audit',kind:'jsr_html_render',host:nativeHost,iframe:nativeFrame,weight:1,priority:0,maxSoftParkedIframes:0,softParkTtlMs:0,onSourceSettled(){}});nativeFrame.contentDocument.getElementById('local').value='selected';slot.dehydrate('visibility');slot.hydrate();});
  await nativePage.waitForFunction(()=>audit.loads===2);
  report.cases.push({name:'native MVU publication protocol and Tauri cold recovery, plugin absent',scope:'actual initGlobals + helper + Tauri slot; substitute MVU engine/store/watch',before:nativeBefore,...await nativePage.evaluate(()=>({globalType:nativeFrame.contentWindow.globalType,data:nativeFrame.contentWindow.value.stat_data,local:nativeFrame.contentDocument.getElementById('local').value}))});
  // Native scroll writer followed by async iframe expansion, with no product loaded in this page.
  const scrollPage=await browser.newPage();await scrollPage.goto(base);
  report.cases.push(await scrollPage.evaluate(async()=>{
   const {createChatScrollAdapter}=await import('/tt/src/tauri/main/adapters/chat-surface/chat-scroll-adapter.js');
   const root=document.getElementById('chat');root.innerHTML=Array.from({length:40},(_,i)=>`<div class="mes" style="height:100px">${i}<iframe style="height:0;width:1px;border:0"></iframe></div>`).join('');
   const scroll=createChatScrollAdapter(root);scroll.setTop(scroll.height());const before=root.scrollTop;
   await new Promise(r=>requestAnimationFrame(r));for(const el of root.children)el.style.height='400px';
   await new Promise(r=>requestAnimationFrame(r));const first=Math.floor(root.scrollTop/400);
   return {name:'static chat late height expansion after bottom scroll, plugin absent',before,after:root.scrollTop,firstVisible:first,total:40,atBottom:root.scrollTop>=root.scrollHeight-root.clientHeight-1};
  }));
  await scrollPage.addScriptTag({content:'window.createRuntimeGlobals='+require(path.join(root,'src/runtime-globals')).toString()});
  report.cases.push(await scrollPage.evaluate(async()=>{const shared={list:[]};const reg=createRuntimeGlobals({readSharedState:()=>shared,isOursShimFn:fn=>!!fn?.__mvu2shujuku,readFake:()=>null});const f=document.createElement('iframe');document.body.append(f);const load=html=>new Promise(resolve=>{f.onload=resolve;f.srcdoc=html});await load('<script>window.getVariables=()=>({epoch:1})</script>');const win=f.contentWindow;reg.note(win);const shim=()=>({});shim.__mvu2shujuku=true;win.getVariables=shim;await load('<script>window.getVariables=()=>({epoch:2})</script>');const currentRead=f.contentWindow.getVariables().epoch;const second=reg.note(f.contentWindow);const cachedRead=second.get().epoch;f.contentWindow.getVariables=shim;reg.restoreAll();return {name:'original globals registry across real same-iframe navigation',sameWindowProxy:win===f.contentWindow,currentRead,cachedRead,restoredRead:f.contentWindow.getVariables().epoch};}));
  report.cases.push(...await require('./tauritavern-placeholder')({browser,base,refs,helper,bundle,core,applyingApi,jquery,lodash,out}));
  const checksum=require('crypto').createHash('sha256').update(bundle).digest('hex');report.bundleSha256=checksum;
  fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(report,null,2)+'\n');
  if(process.env.MVU_TAURI_ASSERT_FIXED==='1'){
   const find=name=>report.cases.find(c=>c.name===name);
   assert.strictEqual(find('helper getter-only Mvu allows remaining shims').shimVariables,true);
   assert.strictEqual(find('Tauri cold recovery resets page input').dataEqual,true);
   const navigation=report.cases.find(c=>c.sameWindowProxy);assert.strictEqual(navigation.cachedRead,2);assert.strictEqual(navigation.restoredRead,2);
   assert.deepStrictEqual([fallback.afterOff,fallback.afterRestore,fallback.fallbackRemoved],[2,2,true]);
   const native=report.cases.find(c=>c.name.startsWith('native MVU publication'));
   assert.strictEqual(native.globalType,'object');assert.deepStrictEqual(native.data,{sentinel:42});assert.strictEqual(native.local,'initial');
   assert.deepStrictEqual(report.errors,[]);
  }
  fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{fs.writeFileSync(path.join(out,'browser-failure.txt'),e.stack);console.error(e.stack);process.exitCode=1;});

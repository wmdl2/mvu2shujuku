'use strict';
const vm=require('vm'),{EventEmitter}=require('events');
const {test}=require('./runner'),{assert}=require('./helpers');
const factory=require('../src/extension-runtime').createWorldbookRequestFilter;
const clone=x=>JSON.parse(JSON.stringify(x));
const converted=(world='转换书')=>({data:{extensions:{mvu2shujuku:{converter:'mvu2shujuku'},world},character_book:{name:'旧内嵌书'}}});
const lore=(world,comment,uid)=>({world,comment,uid,enabled:true,content:'原业务内容'});

test('正文分流：内联工厂只过滤当前转换卡主世界书的纯更新标记',()=>{
 const inline=vm.runInNewContext('('+factory.toString()+')');
 const filter=inline({readCharacter:()=>converted()});
 const originals=[lore('转换书','[mvu_update]未迁移规则',1),lore('转换书','[mvu_plot]剧情',2),
  lore('转换书','[mvu_plot][mvu_update]共享规则',3),lore('转换书','共享设定',4),
  lore('其他书','[mvu_update]其他角色规则',5),lore('旧内嵌书','[mvu_update]旧书',6),
  {comment:'[mvu_update]无法确认来源',uid:7}];
 const before=JSON.stringify(originals);
 const payload=Object.fromEntries(['globalLore','characterLore','chatLore','personaLore'].map(k=>[k,originals.slice()]));
 filter.filter(payload);
 for(const entries of Object.values(payload))assert.deepStrictEqual(entries.map(e=>e.uid),[2,3,4,5,6,7]);
 assert.strictEqual(JSON.stringify(originals),before,'原条目状态、内容和数据库可读取的原列表保持完整');
 assert.strictEqual(payload.characterLore[0],originals[1],'只改本次列表，不改条目对象');
});
test('正文分流：每次同步读取当前身份，普通卡、切卡与缺失归属不误屏蔽',()=>{
 let card=converted();const filter=factory({readCharacter:()=>card});
 const emit=()=>{const payload={characterLore:[lore('转换书','[mvu_update]规则',1)]};filter.filter(payload);return payload.characterLore.length;};
 assert.strictEqual(emit(),0);
 card={data:{extensions:{world:'转换书'},character_book:{name:'转换书'}}};assert.strictEqual(emit(),1);
 card=converted('另一书');assert.strictEqual(emit(),1);
 card={data:{extensions:{mvu2shujuku:{converter:'mvu2shujuku'}}}};assert.strictEqual(emit(),1);
 card={data:{extensions:{mvu2shujuku:{converter:'mvu2shujuku'}},character_book:{name:'转换书'}}};assert.strictEqual(emit(),0);
 filter.filter(null);filter.filter({characterLore:null});
});
test('正文分流：真实事件绑定幂等，换事件总线与停止时移除旧监听',()=>{
 const bus=new EventEmitter(),next=new EventEmitter(),filter=factory({readCharacter:()=>converted()});
 const context={eventSource:bus,event_types:{WORLDINFO_ENTRIES_LOADED:'loaded'}};
 filter.bind(context);filter.bind(context);assert.strictEqual(bus.listenerCount('loaded'),1);
 const original=[lore('转换书','[mvu_update]更新业务',1),lore('转换书','[mvu_plot]正文设定',2)];
 const payload={characterLore:original.slice()};bus.emit('loaded',payload);assert.deepStrictEqual(payload.characterLore.map(e=>e.uid),[2]);
 assert.strictEqual(original.length,2,'填表直接读取的原列表没有被关闭或移除');
 filter.bind({eventSource:next});assert.strictEqual(bus.listenerCount('loaded'),0);
 assert.strictEqual(next.listenerCount('worldinfo_entries_loaded'),1);filter.stop();filter.stop();assert.strictEqual(next.listenerCount('worldinfo_entries_loaded'),0);
});

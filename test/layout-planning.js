'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
function convert(declaration, initial) {
    const result=core.convert({name:'公开结构矩阵',first_mes:'',character_book:{entries:[{comment:'[InitVar]',content:JSON.stringify(initial)}]},extensions:{tavern_helper:{scripts:[{name:'结构',content:"import {registerMvuSchema} from 'https://example.test/mvu_zod.js';\nconst S="+declaration+';registerMvuSchema(S);'}]}}});
    return {...result,layout:JSON.parse(result.card.extensions.mvu2shujuku.layout)};
}
const read=result=>core.statDataFromTables(result.layout,result.template).stat_data;
async function write(result,next){
    const out=await core.writeStatDiffToDbResult(applyingApi(result.template),result.layout,read(result),next);
    assert(out.ok,out.failureReason);assert.deepStrictEqual(read(result),next);
    const archive=core.getStateTransferFactory()().archive({mvu:{stat_data:read(result)}});
    assert.deepStrictEqual(archive.stat_data,next,'导出不能把缺失容器补成空对象');
}
async function refuse(result,next){
    const before=JSON.stringify(result.template),api=applyingApi(result.template);let calls=0;
    for(const name of ['updateCell','updateRow','insertRow','deleteRow','importTableAsJson']) if(api[name]) {
        const run=api[name];api[name]=(...args)=>{calls++;return run(...args);};
    }
    const out=await core.writeStatDiffToDbResult(api,result.layout,read(result),next);
    assert.equal(out.ok,false);assert.match(out.failureReason,/无法无损/);
    assert.equal(calls,0);assert.equal(JSON.stringify(result.template),before);
}
test('布局规划：固定平台字典独立行表，复杂子结构不折叠整个父对象',async()=>{
    const node='z.object({昵称:z.string(),数量:z.number(),评论:z.record(z.string(),z.string()).default({})})';
    const initial={平台:{甲:{昵称:'甲',数量:1.5,评论:{同名:'甲评'}},乙:{昵称:'乙',数量:2.5,评论:{同名:'乙评'}},丙:{昵称:'丙',数量:3.5,评论:{同名:'丙评'}}}};
    const result=convert('z.object({平台:z.object({甲:'+node+',乙:'+node+',丙:'+node+'})})',initial);
    assert.equal(result.schema.length,4);
    const group=result.schema[0];assert(!group.valueCol);
    assert.equal(result.layout.filter(e=>e.kind==='rows').length,3);
    assert.equal(new Set(result.layout.filter(e=>e.kind==='rows').map(e=>JSON.stringify(e.writePaths))).size,3);
    const next=structuredClone(initial);next.平台.乙.评论.同名='只改乙';next.平台.甲.评论={};
    Object.defineProperty(next.平台.丙.评论,'a./~',{value:'字面键',enumerable:true,writable:true});
    await write(result,next);delete next.平台.乙.评论;await refuse(result,next);
    next.平台.乙.评论={};next.平台.甲.额外={计数:2};await write(result,next);
    await refuse(result,{});await refuse(result,{平台:{}});await write(result,initial);
});
for(const [label,node,value]of[
    ['数组','z.array(z.string())',['重复','重复']],
    ['可空对象','z.object({数值:z.number()}).nullable()',null],
    ['可缺失对象','z.object({数值:z.number()}).optional()',undefined],
    ['未知输出','z.number().transform(v=>v)',1.5],
])test('布局规划：'+label+'及其所属对象的缺失、空容器与重建无损',async()=>{
    const initial={状态:{姓名:'甲',数量:2.5,...(value===undefined?{}:{复杂:value})}};
    const result=convert('z.object({状态:z.object({姓名:z.string(),数量:z.number(),复杂:'+node+'})})',initial);
    assert.deepStrictEqual(read(result),initial);
    const next=structuredClone(initial);next.状态.数量=3.75;await write(result,next);
    delete next.状态.复杂;await write(result,next);
    await refuse(result,{状态:{}});await refuse(result,{});await write(result,initial);
});
test('布局规划：动态记录的数组、同名子键和隐藏值随所属对象操作',async()=>{
    const record='z.object({姓名:z.string(),数组:z.array(z.string()),字典:z.record(z.string(),z.object({数量:z.number(),$缓存:z.string()}))})';
    const initial={角色:{甲:{姓名:'同名',数组:['甲','甲'],字典:{同键:{数量:1.5,$缓存:'甲私有'}}},乙:{姓名:'同名',数组:['乙'],字典:{同键:{数量:2.5,$缓存:'乙私有'}}}}};
    const result=convert('z.object({角色:z.record(z.string(),'+record+')})',initial);
    const next=structuredClone(initial);next.角色.甲.字典.同键.数量=3.75;await write(result,next);
    next.角色.甲.字典={};await write(result,next);delete next.角色.甲;await write(result,next);
    assert.equal(read(result).角色.乙.字典.同键.$缓存,'乙私有');
    await write(result,{角色:{}});await refuse(result,{});await write(result,initial);
});
test('布局规划：未知值和字面键在完整JSON中保持原类型与身份',async()=>{
    const dictionary=JSON.parse('{"数值":2.5,"文本":"甲","空":null,"对象":{"$缓存":"私有"},"数组":["甲","甲"],"__proto__":{"值":1},"a./~":"字面键"}');
    const initial={状态:{说明:'保持',字典:dictionary}};
    const result=convert('z.object({状态:z.object({说明:z.string(),字典:z.record(z.string(),z.any())})})',initial);
    assert.deepStrictEqual(read(result),initial);
    const next=structuredClone(initial);next.状态.字典.数值=3.75;delete next.状态.字典.数组;await write(result,next);
});
test('布局规划：隐藏值不复制进DDL或说明，也不新增辅助行和结构存储',async()=>{
    const initial={角色:{甲:{姓名:'甲',缓存:{公开:'可见',$私有:'完整保存但不注入提示的私有值'}}}};
    const result=convert('z.object({角色:z.record(z.string(),z.object({姓名:z.string(),缓存:z.object({公开:z.string(),$私有:z.string()})}))})',initial);
    const group=result.schema[0],sheet=Object.values(result.template).find(s=>s.name===group.tableName);
    assert.deepStrictEqual(sheet.content.slice(1).map(r=>r[0]),[1]);
    assert(!JSON.stringify(sheet.sourceData).includes('完整保存但不注入提示的私有值'));
    assert(group.columns.some(c=>c.zh==='缓存' && c.isObject));assert.deepStrictEqual(read(result),initial);
    await write(result,{角色:{}});await refuse(result,{});
});
test('布局规划：可选父对象和空字典在新增、删除及恢复中不补默认值',async()=>{
    const initial={状态:{说明:'保持',可选:{字典:{}}}};
    const result=convert('z.object({状态:z.object({说明:z.string(),可选:z.object({字典:z.record(z.string(),z.object({数量:z.number(),数据:z.array(z.string())}))}).optional()})})',initial);
    const next=structuredClone(initial);next.状态.可选.字典.甲={数量:3.75,数据:['重复','重复']};await write(result,next);
    delete next.状态.可选;await write(result,next);next.状态.可选={字典:{}};await write(result,next);
});
test('布局规划：必填标量保留普通列，缺失替换在任何宿主写入前拒绝',async()=>{
    const initial={计数:1.25,名称:'甲',开关:true};
    const result=convert('z.object({计数:z.number(),名称:z.string(),开关:z.boolean()})',initial);
    assert.deepStrictEqual(read(result),initial);
    assert(result.schema.every(g=>!g.valueCol));
    await refuse(result,{});await write(result,{计数:2.75,名称:'',开关:false});
    await write(result,initial);
});

test('布局规划：可选根保留JSON，缺失、null、空对象分别保存',async()=>{
    const result=convert('z.object({角色:z.record(z.string(),z.object({姓名:z.string()})).nullable().optional()})',{角色:{甲:{姓名:'甲'}}});
    assert(result.schema[0].valueCol);
    for(const next of [{},{角色:null},{角色:{}},{角色:{乙:{姓名:'乙'}}}]) await write(result,next);
});
test('布局规划：不兼容类型与删除必填子字段均在提交前拒绝',async()=>{
    const result=convert('z.object({状态:z.object({数量:z.number(),姓名:z.string()})})',{状态:{数量:1.5,姓名:'甲'}});
    await refuse(result,{状态:{数量:2.75}});
    await refuse(result,{状态:{数量:'2.75',姓名:'甲'}});
    await refuse(result,{状态:{数量:2.75,姓名:null}});
    await write(result,{状态:{数量:2.75,姓名:'乙'}});
});

test('布局规划：真实运行时拒绝不可表达替换，不改变数据库或原消息变量',async()=>{
    const source={spec:'chara_card_v3',spec_version:'3.0',data:{name:'公开精细写入',first_mes:'开场',character_book:{entries:[{comment:'[InitVar]',content:JSON.stringify({状态:{数量:1.5,姓名:'甲'}})}]},extensions:{tavern_helper:{scripts:[{enabled:true,name:'Schema',content:'import {registerMvuSchema} from "https://example.test/mvu_zod.js";const S=z.object({状态:z.object({数量:z.number(),姓名:z.string()})});registerMvuSchema(S);'}]}}}};
    const h=await require('./runtime-native').nativeRuntime(source,undefined,core.convert);
    const z=require('../src/vendor/schema-engine-libs').zod,key=h.context.characters[0].extensions.mvu2shujuku.schemaKeys[0];
    assert.equal(h.win.Mvu.registerSchema(z.object({状态:z.object({数量:z.number(),姓名:z.string()}).default({数量:9.5,姓名:'默认'})}),key),true);
    await h.advance(9000);
    const before=JSON.stringify(h.tables),message=JSON.stringify(h.context.chat[0]);
    for(const stat of [{},{状态:{}},{状态:{数量:2.5}},{状态:{数量:'2.5',姓名:'乙'}}]) {
        const pending=h.win.Mvu.replaceMvuData({stat_data:stat});await h.advance(9000);
        assert.equal(await pending,false);assert.equal(JSON.stringify(h.tables),before);assert.equal(JSON.stringify(h.context.chat[0]),message);
    }
    const pending=h.win.Mvu.replaceMvuData({stat_data:{状态:{数量:2.75,姓名:'乙'}}});await h.advance(9000);
    assert.equal(await pending,true);assert.deepStrictEqual(JSON.parse(JSON.stringify(h.win.Mvu.getMvuData().stat_data)),{状态:{数量:2.75,姓名:'乙'}});
});

test('布局规划：旧式pair仅保留叶子JSON，说明跟随记录更新及删除',async()=>{
    const initial={角色:{甲:{姓名:'甲',评分:[2.5,'甲说明']},乙:{姓名:'乙',评分:[3.5,'乙说明']}}};
    const result=core.convert({name:'公开pair',character_book:{entries:[{comment:'[InitVar]',content:JSON.stringify(initial)}]}});
    result.layout=JSON.parse(result.card.extensions.mvu2shujuku.layout);
    assert.equal(result.schema[0].kind,'rows');assert(!result.schema[0].valueCol);
    assert.deepStrictEqual(read(result),initial);
    const next=structuredClone(initial);next.角色.甲.评分=[4.25,'新说明'];await write(result,next);
    delete next.角色.甲;await write(result,next);
    assert.deepStrictEqual(read(result).角色.乙.评分,[3.5,'乙说明']);
});

test('布局规划：异步试写固定规划前快照，不能把并发新数据当成旧基线',async()=>{
    const result=convert('z.object({状态:z.object({数量:z.number(),姓名:z.string()})})',{状态:{数量:1.5,姓名:'甲'}});
    const before=JSON.stringify(result.template),next={状态:{数量:2.75,姓名:'乙'}};
    const pending=core.planStatDiffToDb(applyingApi(result.template),result.layout,read(result),next);
    result.template.concurrentMarker=true;
    const plan=await pending;assert(plan.ok,plan.failureReason);
    assert.equal(plan.beforeJson,before);assert.notEqual(plan.beforeJson,JSON.stringify(result.template));
    assert.deepStrictEqual(core.statDataFromTables(result.layout,plan.tables).stat_data,next);
});

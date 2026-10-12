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
    assert(out.ok,out.reason);assert.deepStrictEqual(read(result),next);
    const archive=core.getStateTransferFactory()().archive({mvu:{stat_data:read(result)}});
    assert.deepStrictEqual(archive.stat_data,next,'导出不能把缺失容器补成空对象');
}
test('布局规划：固定平台字典保持独立原路径，完整替换可分别删除和重建容器',async()=>{
    const node='z.object({昵称:z.string(),数量:z.number(),评论:z.record(z.string(),z.string()).default({})})';
    const initial={平台:{甲:{昵称:'甲',数量:1.5,评论:{同名:'甲评'}},乙:{昵称:'乙',数量:2.5,评论:{同名:'乙评'}},丙:{昵称:'丙',数量:3.5,评论:{同名:'丙评'}}}};
    const result=convert('z.object({平台:z.object({甲:'+node+',乙:'+node+',丙:'+node+'})})',initial);
    assert.equal(result.schema.length,1,'父对象本身可被完整替换，不能只保留后代行数');
    const group=result.schema[0];assert(group.valueCol);assert(!group.overflowCol);
    const next=structuredClone(initial);next.平台.乙.评论.同名='只改乙';next.平台.甲.评论={};
    Object.defineProperty(next.平台.丙.评论,'a./~',{value:'字面键',enumerable:true,writable:true});
    await write(result,next);delete next.平台.乙.评论;await write(result,next);
    next.平台.乙.评论={};next.平台.甲.额外={计数:2};await write(result,next);
    await write(result,{});await write(result,{平台:{}});await write(result,initial);
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
    await write(result,{状态:{}});await write(result,{});await write(result,initial);
});
test('布局规划：动态记录的数组、同名子键和隐藏值随所属对象操作',async()=>{
    const record='z.object({姓名:z.string(),数组:z.array(z.string()),字典:z.record(z.string(),z.object({数量:z.number(),$缓存:z.string()}))})';
    const initial={角色:{甲:{姓名:'同名',数组:['甲','甲'],字典:{同键:{数量:1.5,$缓存:'甲私有'}}},乙:{姓名:'同名',数组:['乙'],字典:{同键:{数量:2.5,$缓存:'乙私有'}}}}};
    const result=convert('z.object({角色:z.record(z.string(),'+record+')})',initial);
    const next=structuredClone(initial);next.角色.甲.字典.同键.数量=3.75;await write(result,next);
    next.角色.甲.字典={};await write(result,next);delete next.角色.甲;await write(result,next);
    assert.equal(read(result).角色.乙.字典.同键.$缓存,'乙私有');
    await write(result,{角色:{}});await write(result,{});await write(result,initial);
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
    assert(!group.overflowCol);assert.deepStrictEqual(read(result),initial);
    await write(result,{角色:{}});await write(result,{});
});
test('布局规划：可选父对象和空字典在新增、删除及恢复中不补默认值',async()=>{
    const initial={状态:{说明:'保持',可选:{字典:{}}}};
    const result=convert('z.object({状态:z.object({说明:z.string(),可选:z.object({字典:z.record(z.string(),z.object({数量:z.number(),数据:z.array(z.string())}))}).optional()})})',initial);
    const next=structuredClone(initial);next.状态.可选.字典.甲={数量:3.75,数据:['重复','重复']};await write(result,next);
    delete next.状态.可选;await write(result,next);next.状态.可选={字典:{}};await write(result,next);
});
test('布局规划：顶层数字、字符串和布尔的缺失不读回初值',async()=>{
    const initial={计数:1.25,名称:'甲',开关:true};
    const result=convert('z.object({计数:z.number(),名称:z.string(),开关:z.boolean()})',initial);
    assert.deepStrictEqual(read(result),initial);
    await write(result,{});await write(result,{计数:2.75,名称:'',开关:false});
    await write(result,initial);
});

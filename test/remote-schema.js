'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const createService = () => require('../src/remote-schema')({ createJsSource: require('../src/js-source') });
const clone = x => JSON.parse(JSON.stringify(x));
const url = 'https://cdn.jsdelivr.net/gh/example/card@main/data_schema/index.js';
const source = `import {registerMvuSchema as r} from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
const zod=z, item=zod.z.object({值:z.number()}), Schema=zod.z.object({组:item});
$(()=>r(Schema));`;
function fixture(content = `import '${url}';`, enabled = true) {
    return { name:'公开远程结构样本', character_book:{entries:[{comment:'[InitVar]',content:'{"组":{"值":1}}',enabled:false}]},
        extensions:{tavern_helper:{scripts:[{name:'变量结构',enabled,content}]}} };
}
const response = text => ({ok:true, headers:{get(){return null;}}, text:async()=>text});
test('远程结构：仅转换时获取，缓存复用且卡不包含下载正文', async () => {
    const service=createService(); let calls=0;
    const options={fetch:async()=>{calls++;return response(source);},preserveRemoteSchemaUrls:true};
    const first=await service.resolve(fixture(),options),second=await service.resolve(fixture(),options);
    assert.strictEqual(calls,1); assert.strictEqual(first[0].sha256,second[0].sha256);
    const result=core.convert(fixture(),{remoteSchemaSources:first});
    assert.strictEqual(result.card.extensions.mvu2shujuku.schemaKeys.length,1);
    const script=result.card.extensions.tavern_helper.scripts[0].content;
    assert(script.includes('registerVariableSchema'));assert(script.includes(url));assert(!script.includes('const zod=z'));
});
test('远程结构：只有内容一致时固定 commit，CDN 滞后保留原链接并报告', async () => {
    for(const equal of [true,false]) {
        const service=createService(),sha='a'.repeat(40);
        const fetch=async target=>response(target.includes('api.github.com')?JSON.stringify({sha}):target.includes('@'+sha)?(equal?source:source+'\n// new'):source);
        const snapshots=await service.resolve(fixture(),{fetch});
        assert.strictEqual(snapshots[0].runtimeUrl.includes('@'+sha),equal);
        assert.strictEqual(Boolean(snapshots[0].pinWarning),!equal);
    }
});
test('远程结构：失败可重试，禁用脚本与普通业务外链不下载',async()=>{
    const service=createService();let failed=true,calls=0;
    const fetch=async()=>{calls++;if(failed)throw new Error('offline');return response(source);};
    await assert.rejects(service.resolve(fixture(),{fetch,preserveRemoteSchemaUrls:true}),/下载失败/);
    failed=false;await service.resolve(fixture(),{fetch,preserveRemoteSchemaUrls:true});assert.strictEqual(calls,2);
    assert.deepStrictEqual(await service.resolve(fixture(undefined,false),{fetch}),[]);
    const other=fixture("import 'https://example.test/business.js';");other.extensions.tavern_helper.scripts[0].name='业务';
    assert.deepStrictEqual(await service.resolve(other,{fetch}),[]);
});
test('远程结构：异步公共入口接受本地快照，并刷新配置不丢登记',async()=>{
    const result=await core.convertWithRemoteSchemas(fixture(),{remoteSchemaSources:[{url,source}],preserveRemoteSchemaUrls:true});
    const next=core.refreshConversion(result,{jsonContainers:true});
    assert.strictEqual(next.card.extensions.mvu2shujuku.schemaKeys.length,1);
});
test('远程结构：压缩多声明、shape rest 与函数局部同名不污染注册结构',()=>{
    const parsed=core.parseRegisteredZodSchema('const base=z.object({删:z.string(),留:z.number()}),{删,...rest}=base.shape,S=z.object({组:z.object({...rest})}); function helper(){const S=z.string();return S;} registerMvuSchema(S);');
    assert.deepStrictEqual(Object.keys(parsed.root.fields.组.fields),['留']);
});
test('远程结构：webpack 模块的实际注册导出在自身作用域提取',()=>{
    const raw=`import * as api from 'https://example.test/mvu_zod.js';var modules={7(e,r,t){var zod=t(2);const value=zod.z.object({组:zod.z.object({值:z.number()})});t.d(r,['S',0,value])}},cache={};function load(id){return cache[id]}var registered=load(7);$(()=>{(0,api.registerMvuSchema)(registered.S)});`;
    const parsed=core.parseRegisteredZodSchema(createService().analysisSource(raw));
    assert.strictEqual(parsed.root.fields.组.fields.值.kind,'number');
});
test('多开场结构：并集只建结构，根组缺失与对象标量切换完整写读',async()=>{
    const input=fixture();input.extensions.tavern_helper.scripts=[];
    input.character_book.entries[0].content='';
    const branches=[{组:{值:1},甲:{开场:'甲'},切换:3},{组:{值:2},乙:{开场:'乙'},切换:{状态:false}}];
    input.first_mes='<initvar>'+JSON.stringify(branches[0])+'</initvar>';
    input.alternate_greetings=['<initvar>'+JSON.stringify(branches[1])+'</initvar>'];
    const result=core.convert(input),layout=JSON.parse(result.card.extensions.mvu2shujuku.layout),tables=clone(result.template);
    let before=core.statDataFromTables(layout,tables).stat_data;assert.deepStrictEqual(before,branches[0]);
    for(const target of [branches[1],branches[0]]){
        assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables),layout,before,target,tables)).ok,true);
        assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,target);before=target;
    }
});
test('Schema 读回：缺失嵌套可选列不虚构空父对象',()=>{
    const input=fixture();input.extensions.tavern_helper.scripts=[];
    const result=core.convert(input),layout=JSON.parse(result.card.extensions.mvu2shujuku.layout),tables=clone(result.template);
    const group=layout.find(g=>g.kind==='singleton'&&g.group==='组'),table=Object.values(tables).find(t=>t.name===group.table);
    group.omitMissingParents=['可选'];
    group.cols.push(['可选','jsonScalarOptional','',['组','缺失','值'],false,'',true]);
    table.content[0].push('可选');table.content[1].push('');
    assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,{组:{值:1}});
});
test('Schema 读回：passthrough 的展示引用不制造不存在的初值',()=>{
    const input=fixture();input.extensions.tavern_helper.scripts[0].content='import {registerMvuSchema} from "https://example.test/mvu_zod.js"; const S=z.object({组:z.object({值:z.number()}).passthrough()}); registerMvuSchema(S);';
    input.first_mes='<%= getvar("stat_data.组.额外") %>';
    const result=core.convert(input);
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(result.card.extensions.mvu2shujuku.layout),result.template).stat_data,{组:{值:1}});
});
test('多开场结构：删除前行后动态字段仍更新到原业务键',async()=>{
    const input=fixture();input.character_book.entries[0].content='{"列表":{"甲":{"值":1},"乙":{"值":2}}}';
    input.extensions.tavern_helper.scripts[0].content='import {registerMvuSchema} from "https://example.test/mvu_zod.js"; const S=z.object({列表:z.record(z.string(),z.object({值:z.number()}).passthrough())});registerMvuSchema(S);';
    const result=core.convert(input),layout=JSON.parse(result.card.extensions.mvu2shujuku.layout),tables=clone(result.template);
    const before=core.statDataFromTables(layout,tables).stat_data,target={列表:{乙:{值:2,新字段:99,第二字段:88}}};
    const api={...applyingApi(tables),exportTableAsJson:()=>clone(tables)};
    assert.strictEqual((await core.writeStatDiffToDbResult(api,layout,before,target,clone(tables))).ok,true);
    assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,target);
    const removed={列表:{乙:{值:2}}};
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables),layout,target,removed,tables)).ok,true);
    assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,removed);
});

test('远程结构：HTTP 浏览器无 SubtleCrypto 时仍生成正确 SHA-256',async()=>{
    const vm=require('vm'),crypto=require('crypto');
    const sandbox=vm.createContext({TextEncoder,URL,AbortController,setTimeout,clearTimeout,crypto:{}});
    vm.runInContext('var createRemote='+require('../src/remote-schema').toString()+';var createJs='+require('../src/js-source').toString()+';var service=createRemote({createJsSource:createJs});',sandbox);
    for(const value of ['', 'abc', '中文🧪'.repeat(100)]) {
        sandbox.input=fixture();sandbox.options={remoteSchemaSources:[{url,source:value}],preserveRemoteSchemaUrls:true};
        const result=await vm.runInContext('service.resolve(input,options)',sandbox);
        assert.strictEqual(result[0].sha256,crypto.createHash('sha256').update(value).digest('hex'));
    }
});
test('远程结构：DOM 就绪回调中的本地声明可解析，其他函数的同名变量不污染',()=>{
    const source='function other(){const S=z.string();return S;}$(()=>{const S=z.object({组:z.object({值:z.number()})});registerMvuSchema(S);});';
    assert.strictEqual(core.parseRegisteredZodSchema(source).root.fields.组.fields.值.kind,'number');
});

test('Schema 读回：已声明的 any 可选叶子仍保留必需空父对象',()=>{
    const input=fixture();input.character_book.entries[0].content='{"组":{"详情":{}}}';
    input.extensions.tavern_helper.scripts[0].content='import {registerMvuSchema} from "https://example.test/mvu_zod.js";const S=z.object({组:z.object({详情:z.object({值:z.any().optional()})})});registerMvuSchema(S);';
    const result=core.convert(input);assert.deepStrictEqual(core.statDataFromTables(JSON.parse(result.card.extensions.mvu2shujuku.layout),result.template).stat_data,{组:{详情:{}}});
});

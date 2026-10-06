'use strict';
const assert = require('assert/strict');
const core = require('../src/mvu2shujuku');
function fixture(url) {
    const card = require('./synthetic-card')();
    card.data.name = '远程 Schema 与分支公开验收';
    card.data.character_book.entries[0].content = '';
    const common = {状态:{生命:100,金币:10,详情:{},评分:0,整数:2,布尔数组:[true,false],混合数组:[1,'字',false,null]},背包:['钥匙',0,false,null],列表:{甲:{值:1},乙:{值:2}}};
    card.data.first_mes = '<initvar>'+JSON.stringify({...common,形态:3})+'</initvar>第一开场。';
    card.data.alternate_greetings = ['<initvar>'+JSON.stringify({...common,形态:{名称:'对象'},场景:{编号:2}})+'</initvar>第二开场。'];
    card.data.extensions.tavern_helper.scripts = [{type:'script',name:'远程变量结构',enabled:true,content:'import '+JSON.stringify(url)+';'}];
    return card;
}
module.exports = async function remoteSchemaHost(h) {
    const {page,runtimeTest,setStorageMode,assertStorageMode,openState,waitCommittedGold,record}=h;
    const moduleUrl=new URL('/fixture-data_schema.js',page.url()).href, helperUrl=new URL('/fixture-mvu_zod.js',page.url()).href;
    const body=`import {registerMvuSchema} from ${JSON.stringify(helperUrl)};
const S=z.object({状态:z.object({生命:z.number(),金币:z.number().transform(n=>Math.min(n,50)),详情:z.object({可选:z.number().optional()}),评分:z.coerce.number().transform(v=>_.clamp(v,0,5)),整数:z.number().int(),布尔数组:z.array(z.boolean()),混合数组:z.array(z.any())}),背包:z.array(z.any()),列表:z.record(z.string(),z.object({值:z.number()}).passthrough()),场景:z.object({编号:z.number()}).optional(),形态:z.number().or(z.object({名称:z.string()}))});
$(()=>{registerMvuSchema(S);window.__remoteSchemaFixtureReady=true;});`;
    let requests=0,routeFailure=null;
    const moduleRoute=async route=>{try{requests++;await route.fulfill({status:200,contentType:'text/javascript',body});}catch(e){routeFailure=e;await route.abort();}};
    const helperRoute=async route=>{try{await route.fulfill({status:200,contentType:'text/javascript',body:'export function registerMvuSchema(schema){registerVariableSchema(z.object({stat_data:schema}),{type:"message"});}'});}catch(e){routeFailure=e;await route.abort();}};
    await page.route(moduleUrl,moduleRoute);await page.route(helperUrl,helperRoute);
    try {
        for(const mode of ['native','sqlite']){
            await setStorageMode(page,mode);
            const input=fixture(moduleUrl),prepared=await core.convertWithRemoteSchemas(input,{remoteSchemaSources:[{url:moduleUrl,source:body}],preserveRemoteSchemaUrls:true});
            const browserPrepared=await page.evaluate(async ({input,url,source})=>{
                const result=await MVU2SHUJUKU_CORE.convertWithRemoteSchemas(input,{remoteSchemaSources:[{url,source}],preserveRemoteSchemaUrls:true});
                return {card:result.card,template:result.template};
            },{input,url:moduleUrl,source:body});
            const browserLayout=JSON.parse(browserPrepared.card.data.extensions.mvu2shujuku.layout);
            assert.deepStrictEqual(core.statDataFromTables(browserLayout,browserPrepared.template).stat_data,
                core.statDataFromTables(JSON.parse(prepared.card.data.extensions.mvu2shujuku.layout),prepared.template).stat_data);
            assert.strictEqual(await page.locator('iframe[data-mvu-schema-evaluator]').count(),0);
            record('schema-execution-browser-'+mode,{tables:browserLayout.length,engine:'javascript-zod'});
            const snapshots=[{url:moduleUrl,source:body,index:0,runtimeUrl:moduleUrl}];
            const converter={...core,convert:(value,opts)=>core.convert(value,{...opts,remoteSchemaSources:snapshots})};
            assert.strictEqual(prepared.card.data.extensions.mvu2shujuku.schemaKeys.length,1);
            const typed=prepared.schema.find(g=>g.name==='状态');
            for(const [name,type]of [['生命','REAL'],['整数','INTEGER'],['评分','TEXT']])assert.strictEqual(typed.columns.find(c=>c.zh===name).type,type);
            const state=await runtimeTest(page,input,converter,'remote-'+mode);
            if(routeFailure)throw routeFailure;
            await assertStorageMode(page,mode,'远程 Schema');
            await page.waitForFunction(()=>Array.from(document.querySelectorAll("iframe")).some(frame=>{try{return frame.contentWindow.__remoteSchemaFixtureReady;}catch(e){return false;}}));
            const beforeRequests=requests;
            assert.strictEqual(await page.evaluate(async()=>{
                for(let n=0;n<5;n++)Mvu.getMvuData();
                const value=Mvu.getMvuData();value.stat_data.状态.金币=120;value.stat_data.状态.生命=100.25;value.stat_data.状态.评分=8.25;value.stat_data.状态.布尔数组=[false,true,false];value.stat_data.状态.混合数组=[null,'',true,3.75,{值:2}];value.stat_data.形态={名称:'切换'};value.stat_data.场景={编号:2};delete value.stat_data.列表.甲;value.stat_data.列表.乙.新字段=99;
                return Mvu.replaceMvuData(value);
            }),true);
            await waitCommittedGold(page,50);
            assert.strictEqual(requests,beforeRequests,'读取和写入不能重新下载 Schema 模块');
            let value=await page.evaluate(()=>Mvu.getMvuData().stat_data);
            assert.strictEqual(value.状态.生命,100.25);assert.strictEqual(value.状态.评分,5);assert.deepStrictEqual(value.状态.布尔数组,[false,true,false]);assert.deepStrictEqual(value.状态.混合数组,[null,'',true,3.75,{值:2}]);
            assert.deepStrictEqual(value.形态,{名称:'切换'});assert.deepStrictEqual(value.场景,{编号:2});assert.deepStrictEqual(value.列表,{乙:{值:2,新字段:99}});
            assert.strictEqual(await page.evaluate(async()=>{const data=Mvu.getMvuData();delete data.stat_data.场景;data.stat_data.形态=3;return Mvu.replaceMvuData(data);}),true);
            await page.reload({waitUntil:'domcontentloaded'});await openState(page,state);await waitCommittedGold(page,50);
            value=await page.evaluate(()=>Mvu.getMvuData().stat_data);assert.strictEqual('场景' in value,false);assert.strictEqual(value.形态,3);assert.deepStrictEqual(value.状态.详情,{});assert.deepStrictEqual(value.列表,{乙:{值:2,新字段:99}});
            assert.strictEqual(value.状态.生命,100.25);assert.strictEqual(value.状态.评分,5);assert.deepStrictEqual(value.状态.布尔数组,[false,true,false]);assert.deepStrictEqual(value.状态.混合数组,[null,'',true,3.75,{值:2}]);
            record('remote-schema-branch-reload-'+mode,{requests,stat:value});
        }
    } finally {await page.unroute(moduleUrl,moduleRoute);await page.unroute(helperUrl,helperRoute);}
};
module.exports.fixture=fixture;

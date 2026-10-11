'use strict';
const {test}=require('./runner');
const {core,assert,applyingApi}=require('./helpers');
const engine=require('../src/schema-execution-node');
const helper="import {registerMvuSchema} from 'https://example.test/mvu_zod.js';\n";
const card=(source,initial)=>({name:'公开真实Schema契约',character_book:{entries:[{comment:'[InitVar]',content:initial===undefined?'':JSON.stringify(initial),enabled:false}]},extensions:{tavern_helper:{scripts:[{name:'结构',enabled:true,content:helper+source}]}}});
const read=r=>core.statDataFromTables(JSON.parse(r.card.extensions.mvu2shujuku.layout),r.template).stat_data;
test('真实Schema：catch输出来自实际参数，管道末端决定存储约束且不调用回退函数',()=>{
    const snapshot=engine.inspectSync('const S=z.object({枚举:z.enum(["甲","乙"]).catch("").describe("原说明"),函数:z.number().catch(()=>{throw new Error("不能执行回退");}),异型:z.number().catch("未知"),末端:z.enum(["甲"]).catch("").pipe(z.enum(["甲"])),外层:z.enum(["甲"]).pipe(z.enum(["甲"])).catch(""),工厂:z.catch(z.number().min(0),-1),小数:z.int().catch(0.5)});registerMvuSchema(S);').roots[0].fields;
    assert.deepStrictEqual(snapshot.枚举.enum,['甲','乙']);
    assert.deepStrictEqual(snapshot.枚举.outputFallbacks,['']);
    assert.strictEqual(snapshot.枚举.desc,'原说明');
    assert.strictEqual(snapshot.函数.kind,'unknown');
    assert.strictEqual(snapshot.异型.kind,'unknown');
    assert.strictEqual(snapshot.末端.outputFallbacks,undefined);
    assert.deepStrictEqual(snapshot.外层.outputFallbacks,['']);
    assert.deepStrictEqual(snapshot.工厂.outputFallbacks,[-1]);
    assert.strictEqual(snapshot.小数.integer,false);
});
test('真实Schema：容器回退按所属字段传播，default短路与prefault解析不混同',()=>{
    const fields=engine.inspectSync('const S=z.object({组:z.object({值:z.number().min(0),状态:z.enum(["甲"])}).catch({值:-1,状态:""}),列表:z.array(z.enum(["甲"])).catch([""]),默认:z.enum(["甲"]).default(""),预填:z.enum(["甲"]).prefault("")});registerMvuSchema(S);').roots[0].fields;
    assert.deepStrictEqual(fields.组.fields.值.outputFallbacks,[-1]);
    assert.deepStrictEqual(fields.组.fields.状态.outputFallbacks,['']);
    assert.deepStrictEqual(fields.列表.element.outputFallbacks,['']);
    assert.deepStrictEqual(fields.默认.outputFallbacks,['']);
    assert.strictEqual(fields.预填.outputFallbacks,undefined);
});
test('真实Schema：Zod克隆追加校验仍保留静态回退参数，动态提供器不执行',()=>{
    const fields=engine.inspectSync('const S=z.object({回退:z.enum(["甲"]).catch("").refine(()=>true),默认:z.string().default("甲").refine(()=>true),预填:z.string().prefault("乙").superRefine(()=>{}),动态:z.number().catch(()=>{throw new Error("不应执行动态回退");}).refine(()=>true),动态默认:z.number().default(()=>{throw new Error("不应执行动态默认");}).refine(()=>true)});registerMvuSchema(S);').roots[0].fields;
    assert.strictEqual(fields.回退.kind,'text');
    assert.deepStrictEqual(fields.回退.outputFallbacks,['']);
    assert.strictEqual(fields.默认.hasDefault,true);
    assert.strictEqual(fields.默认.defaultValue,'甲');
    assert.strictEqual(fields.预填.defaultValue,'乙');
    assert.strictEqual(fields.预填.outputFallbacks,undefined);
    assert.strictEqual(fields.动态.kind,'unknown');
    assert.strictEqual(fields.动态默认.hasDefault,undefined);
    assert.strictEqual(fields.动态默认.dynamicDefault,true);
});
test('真实Schema：等价属性语法、键名和辅助函数生成相同默认开局',()=>{
    const values=[
        'const S=z.object({状态:z.number().default(1)});',
        String.raw`const S=z.object({"\u72b6\u6001":z.number().default(1)});`,
        'const key="状"+"态";const S=z.object({[key]:z.number().default(1)});',
        'const 状态=z.number().default(1);const S=z.object({状态});',
        'function make(key){const out={};for(const name of [key])out[name]=z.number().default(1);return z.object(out);}const S=make("状态");'
    ];
    for(const source of values)assert.deepStrictEqual(read(core.convert(card(source+'registerMvuSchema(S);'))),{状态:1});
});
test('真实Schema：词法作用域及注册别名由实际引擎解析',()=>{
    const source=helper.replace('registerMvuSchema}','registerMvuSchema as r}')+'const x="外层";function unrelated(){const x="错误";throw new Error("不应执行");}$(()=>{const x="状态";const S=z.object({[x]:z.number().default(3)});r(S);});';
    const actual=engine.inspectSync(source);assert.deepStrictEqual(Object.keys(actual.roots[0].fields),['状态']);assert.strictEqual(actual.roots[0].fields.状态.defaultValue,3);
});
test('真实Schema：依赖切片不启动业务、DOM、事件或同一逗号表达式的副作用',()=>{
    const source='const business=(()=>{throw new Error("业务不应启动")})();const S=z.object({值:z.number()});$(errorCatched(async()=>{registerMvuSchema(S),document.write("不应执行"),window.fetch("https://invalid.test");})());';
    assert.strictEqual(engine.inspectSync(source).roots[0].fields.值.kind,'number');
});
test('真实Schema：具名启动函数调用链登记，不启动同函数里的业务',()=>{
    const source='const S=z.object({值:z.number().default(4)});async function register(){registerMvuSchema(S);document.write("业务");}function start(){register();throw new Error("业务");}$(()=>{start();});';
    assert.strictEqual(engine.inspectSync(source).roots[0].fields.值.defaultValue,4);
});
test('真实Schema：静态值使用Zod API，动态默认不执行，缺失必填拒绝',()=>{
    const dynamic='const S=z.object({值:z.number().default(()=>{throw new Error("默认函数不能执行");})});registerMvuSchema(S);';
    assert.strictEqual(engine.inspectSync(dynamic).roots[0].fields.值.dynamicDefault,true);
    assert.throws(()=>core.convert(card(dynamic)),/默认|InitVar/);
    const staticValue='const data={值:7};const S=z.object({组:z.object({值:z.number()}).default(_.cloneDeep(data))});registerMvuSchema(S);';
    assert.deepStrictEqual(read(core.convert(card(staticValue))),{组:{值:7}});
});
test('真实Schema：环境依赖字段保留完整JSON，不能误判完整默认值',()=>{
    const source='function build(x){return z.literal(x);}const S=z.object({组:z.object({动态:build(Date.now()),静态:z.number().default(2)})});registerMvuSchema(S);';
    const snapshot=engine.inspectSync(source);assert.strictEqual(snapshot.roots[0].fields.组.fields.动态.unresolved,true);
    const r=core.convert(card(source,{组:{动态:123,静态:2}}));assert.deepStrictEqual(read(r),{组:{动态:123,静态:2}});
    assert.throws(()=>core.convert(card(source)),/默认|InitVar/);
});
test('真实Schema：未知计算键停止，不能生成环境占位根组',()=>{
    assert.throws(()=>engine.inspectSync('const key=Date.now();const S=z.object({[key]:z.number()});registerMvuSchema(S);'),/当前时间/);
});
test('真实Schema：required恢复必填，未落入数据库的约束明确报告',()=>{
    const source='const S=z.object({值:z.number().optional(),文本:z.string().regex(/a/),整数:z.number().int(),正数:z.number().gt(0)}).required();registerMvuSchema(S);';
    const snapshot=engine.inspectSync(source);
    assert.notStrictEqual(snapshot.roots[0].fields.值.optional,true);
    assert.throws(()=>core.convert(card(source)),/默认|InitVar/);
    for(const kind of ['regex','safeint','greater_than'])assert(snapshot.unsupported.some(item=>item.kind.includes(kind)),kind);
});
test('真实Schema：联合、passthrough、结构变换保留数据并经过真实writer',async()=>{
    const source='const S=z.object({组:z.object({值:z.number().or(z.object({名称:z.string()})),变换:z.number().transform(n=>String(n))}).passthrough()});registerMvuSchema(S);';
    const r=core.convert(card(source,{组:{值:1,变换:2,额外:false}})),layout=JSON.parse(r.card.extensions.mvu2shujuku.layout),tables=JSON.parse(JSON.stringify(r.template)),before=read(r),target={组:{值:{名称:'对象'},变换:'2',额外:false}};
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables),layout,before,target,tables)).ok,true);
    assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,target);
});
test('真实Schema：Node隔离环境不暴露进程、require或动态导入',()=>{
    const source='const S=(()=>{if(typeof process!=="undefined"||typeof require!=="undefined")throw new Error("宿主泄露");return z.object({值:z.number()});})();registerMvuSchema(S);';
    assert.strictEqual(engine.inspectSync(source).roots[0].fields.值.kind,'number');
    assert.throws(()=>engine.inspectSync('const S=(()=>{Function("return process")();return z.object({});})();registerMvuSchema(S);'),/Code generation/);
});
test('真实Schema：构造循环受隔离执行超时约束',()=>{
    assert.throws(()=>engine.inspectSync('const S=(()=>{while(true){}})();registerMvuSchema(S);'),/timed out|超时/);
});

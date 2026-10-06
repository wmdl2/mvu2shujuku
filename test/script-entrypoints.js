'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const engine = require('../src/schema-execution-node');
const helper = 'https://example.test/mvu_zod.js';
const bundle = 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@abcdef/artifact/bundle.js';
const fallback = bundle.replace('cdn.jsdelivr.net', 'testingcf.jsdelivr.net');
const schema = 'const S=z.object({状态:z.object({值:z.number().default(1)})});';
const forms = [
    `import {registerMvuSchema as r} from '${helper}';${schema}r(S);`,
    `import * as api from '${helper}';${schema}api['registerMvuSchema'](S);`,
    `const {registerMvuSchema:r}=await import('${helper}');${schema}r(S);`,
    `let r;try{({registerMvuSchema:r}=await import('${helper}'));}catch(e){({registerMvuSchema:r}=await import('${helper}'));}${schema}$(()=>r(S));`,
    `const api=await import('${helper}');${schema}(0,api.registerMvuSchema)(S);`,
];
for (const [index, content] of forms.entries()) test('脚本入口：静态／动态登记形式 ' + index + ' 共用实际分析与构造', () => {
    assert.strictEqual(engine.analyzeScript(content).registrations.length, 1);
    assert.deepStrictEqual(Object.keys(engine.inspectSync(content).roots[0].fields), ['状态']);
    const card = { name: '公开登记入口', character_book: { entries: [{ comment: '[InitVar]', content: '{"状态":{"值":1}}' }] },
        extensions: { tavern_helper: { scripts: [{ name: '结构', enabled: true, content }] } } };
    const result = core.convert(card), meta = result.card.extensions.mvu2shujuku;
    assert.strictEqual(meta.schemaKeys.length, 1);
    assert.strictEqual(result.schema.find(g => g.name === '状态').columns.find(c => c.zh === '值').type, 'REAL');
    assert(result.card.extensions.tavern_helper.scripts.some(s => s.content.includes('registerSchema')));
});
test('脚本入口：同名参数／局部函数不是原卡登记，隔离构造不执行它们', () => {
    const content = `import {registerMvuSchema as r} from '${helper}';function unrelated(r){r(z.object({错误:z.number()}));}unrelated(()=>{throw new Error('无关业务');});${schema}r(S);`;
    assert.strictEqual(engine.analyzeScript(content).registrations.length, 1);
    assert.deepStrictEqual(Object.keys(engine.inspectSync(content).roots[0].fields), ['状态']);
    assert.strictEqual(engine.analyzeScript(`import {registerMvuSchema as r} from '${helper}';r=()=>{};${schema}r(S);`).registrations.length, 0);
});
test('脚本入口：双 CDN 回退与短延时的纯 MVU 加载器可证明移除', () => {
    const content = `await new Promise(resolve=>setTimeout(resolve,250));try{await import('${fallback}');}catch(e){try{await import('${bundle}');}catch(e2){console.error('加载失败',e2);}}`;
    assert.strictEqual(engine.analyzeScript(content).pureEngineLoader, true);
    const card = { name: '公开引擎入口', character_book: { entries: [{ comment: '[InitVar]', content: '{"状态":{"值":1}}' }] },
        extensions: { tavern_helper: { scripts: [{ name: '原引擎', enabled: true, content }] } } };
    const result = core.convert(card);
    assert(!result.card.extensions.tavern_helper.scripts.some(s => s.name === '原引擎'));
    for (const business of ['window.business=true;', 'eventOn("业务",()=>{});', 'await new Promise(resolve=>{window.business=true;setTimeout(resolve,250);});']) {
        assert.strictEqual(engine.analyzeScript(content + business).pureEngineLoader, false);
        card.extensions.tavern_helper.scripts[0].content = content + business;
        assert(core.convert(card).card.extensions.tavern_helper.scripts.some(s => s.name === '原引擎'));
    }
});
test('脚本入口：未知模块和非字面量引擎地址不能当作纯 MVU 加载器删除', () => {
    for (const source of ['await import("https://example.test/mvu-front.js");', `await import('${bundle}'+suffix);`, `try{await import('${bundle}');}finally{window.business=true;}`]) assert.strictEqual(engine.analyzeScript(source).pureEngineLoader, false);
});
test('脚本入口：大段内嵌资源不作为状态栏回调源码，仍扫描真实字段', () => {
    const source = 'const asset="' + 'a'.repeat(200000) + '.map(([key,value])=>value.错误)";function render(d){const rows=list(d,"记录");rows.map(item=>val(item,"评分"));}';
    const card = { name: '公开资源扫描', extensions: { tavern_helper: { scripts: [{ name: '面板', content: source }] } } };
    const usage = core.scanStatusUsage(card, ['记录']);
    assert(usage.记录.includes('评分')); assert(!usage.记录.includes('错误'));
});

test('脚本入口：已知工具经打包模块导出转发仍可实际构造，运行时沿用远程登记拦截', () => {
    const content = `import * as api from '${helper}';${schema}
    function moduleOf(id){return id===1?{registerMvuSchema:api.registerMvuSchema}:{S};}
    const runtime=moduleOf(1), model=moduleOf(2);$(()=>(0,runtime.registerMvuSchema)(model.S));`;
    assert.deepStrictEqual(Object.keys(engine.inspectSync(content).roots[0].fields), ['状态']);
    assert.strictEqual(engine.analyzeScript(content).registrations.length,0);
});

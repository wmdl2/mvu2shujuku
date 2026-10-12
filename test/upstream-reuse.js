'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
// Retained physical layouts are tested with frozen public metadata; current conversions use layout-planning.js.
const legacyLayoutFixture = require('./legacy-layout-fixture');
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const libraries = require('../src/vendor/schema-engine-libs');
const createParser = require('../src/vendor/ejs-parser');
const createTransform = require('../src/ejs-transform');
const createJsSource = require('../src/js-source');
const { createEjsEvalBridge } = require('../src/extension-runtime');

test("旧布局：上游复用：真实EJS解析器处理转义、嵌套字符串和空白标签，正文保持原文", async () => {
    const ejs = createParser();
    const samples = [
        `<%% example %><%= getvar('stat_data.状态.金币') %>`,
        `前文\n  <%_ const nested='<%= 2 %>'; const n=getvar('stat_data.状态.金币'); _%>  \n<%= n %>`,
        `<%% text %%><%# getvar('stat_data.状态.金币') %><%= getvar('stat_data.状态.金币') %>`,
    ];
    for (const source of samples) {
        const converted = core.rewriteEjsConditions(source, { entries: [] }, core.createReport()).text;
        const expected = source;
        assert.strictEqual(converted, expected);
        const context = { getvar: () => 42, mvu2shujukuGetVar: () => 42 };
        assert.strictEqual(await ejs.render(converted, context, { async: true }), await ejs.render(source, context, { async: true }));
    }
});
test("旧布局：上游复用：标签解析不执行作者代码，残缺模板保留并报告", () => {
    const source = '<% throw new Error("must not run"); %><%= Math.random() %>';
    const transform = createTransform();
    assert.strictEqual(transform.ejsScriptRanges(source).ranges.length, 2);
    const report = core.createReport(), malformed = '<% getvar("stat_data.状态.金币")';
    assert.strictEqual(core.rewriteEjsConditions(malformed, { entries: [] }, report).text, malformed);
    assert(report.manualReview.some(x => x.includes('EJS 模板解析未完成')));
});
test("旧布局：上游复用：Acorn识别模板插值、正则和注释，字面量不参与调用匹配", () => {
    const transform = createTransform();
    const source = 'const s=`raw getvar("stat_data.X") ${getvar("stat_data.Y")}`; const r=/getvar("stat_data.Z")/; /*getvar("stat_data.A")*/';
    const converted = transform.rewriteStatDataCalls(source);
    assert.strictEqual(converted.count, 0);
    assert.strictEqual(converted.text, source);
});
test("旧布局：上游复用：原生变量参数与大小写保留，由宿主执行", () => {
    const source = '<%= getvar("stat_\\u0064ata.X") %><%= getvar(`stat_data.Y`) %><%= getvar("STAT_DATA.X") %><%= getvar("stat_data." + name) %>';
    const expected = source;
    assert.strictEqual(core.rewriteEjsConditions(source, { entries: [] }, core.createReport()).text, expected);
});
test("旧布局：上游复用：公共JS源工具用Acorn保护模板和正则中的分隔符", () => {
    const js = createJsSource();
    const source = 'fn(`text ${nested(`inner ${1}`, 2)}`, /[,)]/.test(x), { value: "a,b" })';
    const close = js.balancedEnd(source, source.indexOf('('));
    assert.strictEqual(close, source.length - 1);
    assert.deepStrictEqual(js.split(source.slice(3, close)), ['`text ${nested(`inner ${1}`, 2)}`', '/[,)]/.test(x)', '{ value: "a,b" }']);
    assert.strictEqual(js.substitute('value + "value" /*value*/ + /value/.source', { value: '3' }), '(3) + "value" /*value*/ + /value/.source');
});
test("旧布局：上游复用：实际解析工厂在无Node作用域VM中使用同一公共依赖", () => {
    const parser = vm.runInNewContext('(' + createParser.toString() + ')')();
    const transform = vm.runInNewContext('(' + createTransform.toString() + ')')({ ejs: parser, acorn: libraries.acorn });
    const source = `<%= getvar('stat_data.X') %>`;
    assert.strictEqual(transform.rewriteEjsConditions(source, { entries: [] }, { auto() {}, note() {}, manual() {} }).text, source);
    const js = vm.runInNewContext('(' + createJsSource.toString() + ')')({ acorn: libraries.acorn });
    assert.strictEqual(js.balancedEnd(String.raw`fn(/\)/)`, 2), 7);
});
test("旧布局：上游复用：Lodash读写保留数组和字面键，undefined按原setter删除", () => {
    let variables = { stat_data: { items: [{ score: 2.5 }, { score: 4 }], 'a.b': { '': 7 } } };
    const bridge = createEjsEvalBridge({ lodash: libraries.lodash });
    const get = bridge.createMessageGetter(() => variables);
    const set = bridge.createMessageSetter(() => variables, stat => { variables = { stat_data: stat }; });
    set('stat_data.items[0].score', 3.75);
    assert.strictEqual(get('stat_data.items[0].score'), 3.75);
    assert.strictEqual(get('stat_data.items[1].score'), 4);
    set('stat_data["a.b"][""]', undefined);
    assert.strictEqual(get('stat_data["a.b"][""]', { defaults: 99 }), 99);
    assert(!Object.hasOwn(variables.stat_data['a.b'], ''));
    assert(Array.isArray(variables.stat_data.items));
});
test("旧布局：上游复用：状态字段扫描也使用EJS边界，混合正文不吞掉真实读取", () => {
    const card = { name: '公开字段扫描', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: JSON.stringify({ 关系系统: { 角色甲: { 名字: '甲' } } }) },
        { id: 2, comment: '阶段控制', content: "player's 说明\n<%_ const n = Number(getvar('stat_data.关系系统.角色甲.评分') || 0); if (n >= 80) { _%>阶段一<%_ } _%>" },
    ] } };
    const usage = core.scanStatusUsage(card, ['关系系统']);
    assert(usage.关系系统.includes('评分'));
    const r = publishedLayoutFixture(card);
    assert(Object.values(r.template).some(t => t?.content?.[0]?.includes('评分')));
});
test("旧布局：上游复用：原始TH脚本中的EJS字符串示例不当作执行模板", () => {
    const card = { extensions: { tavern_helper: { scripts: [{ name: '公开脚本', content: `const sample="<%= getvar('stat_data.世界.示例字段') %>"; const data=getAllVariables().stat_data.世界; console.log(data.真实字段);` }] } } };
    const usage = core.scanStatusUsage(card, ['世界']);
    assert(usage.世界.includes('真实字段'));
    assert(!usage.世界.includes('示例字段'));
});

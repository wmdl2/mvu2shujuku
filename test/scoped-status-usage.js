'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

const scan = scripts => core.scanStatusUsage({ name: '作用域扫描', first_mes: '', extensions: {
    tavern_helper: { scripts: scripts.map(content => ({ name: '前端', content })) },
} }, ['通讯录', '技能', '档案']);

test('字段扫描辅助绑定：helper 字符串和注释不补列，同名参数与重新赋值遮蔽来源', () => {
    const usage = scan([`const example="const a=get(d,'技能'); val(a,'误补')";
        // const a=list(d,'技能'); val(a,'误补')
        const a=get(d,'通讯录'); val(a,'备注');
        function closure(){return val(a,'关系');}
        function shadow(a){return val(a,'误补');}
        const shadowArrow=a=>val(a,'箭头误补');
        {const a=other;val(a,'块误补');}
        a=other;val(a,'赋值误补');
    `]);
    assert.deepStrictEqual(usage.通讯录, ['备注', '关系']);
    assert.strictEqual(usage.技能, undefined);
});

test('字段扫描辅助绑定：entries 只使用真实条目参数，嵌套对象与遮蔽变量不提升', () => {
    const usage = scan([`const list=state.stat_data.通讯录;
        Object.entries(list).forEach(([key,item])=>{
            item.备注;
            const data={};data.无关字段;
            const nested=item.历史; nested.内部字段;
            function shadow(item){return item.遮蔽字段;}
            (()=>item.闭包字段)();
        });
        const sorted=Object.entries(list);
        sorted.forEach(([key,data])=>{
            data.好感;
        });
    `]);
    assert.deepStrictEqual(usage.通讯录, ['备注', '历史', '闭包字段', '好感']);
});

test('字段扫描辅助绑定：合法 get/list 索引、回调与数值 val 保持字段归属', () => {
    const usage = scan([`const all=get(d,'通讯录');const person=all[key];
        val(person,'备注');Number(val(person,'好感',0));
        const info=person['档案'];val(info,'内部字段');
        const skills=list(d,'技能');skills.map(item=>val(item,'熟练度',0));
        const copy=skills.slice();copy.forEach(function(item){val(item,'等级');});
        function wrong(item){val(item,'误补');}
    `]);
    assert.deepStrictEqual(usage.通讯录, ['备注', '好感']);
    assert.deepStrictEqual(usage.技能, ['熟练度', '等级']);
    assert.strictEqual(usage.__types.通讯录.好感, 'number');
});

test('字段扫描作用域：压缩代码中同名临时变量不跨函数或脚本补列', () => {
    const usage = scan([
        'function a(o){const i=o.stat_data.通讯录;return i.好感;}function b(i){return i.熟练度;}function c(i){return i.通讯录;}',
        'function d(){const i=anything;return i.伪造;}const other="i.字符串误列"; // i.注释误列',
    ]);
    assert.deepStrictEqual(usage.通讯录, ['好感']);
});

test('字段扫描作用域：合法闭包继承，参数和局部声明遮蔽，块外恢复原绑定', () => {
    const usage = scan([`const data=state.stat_data.通讯录;
        function closure(){return data.关系;}
        function parameter(data){return data.错误参数;}
        function defaults(first=1, data=other){return data.错误默认参数;}
        function local(){const data=other;return data.错误局部;}
        const arrow=(data)=>{return data.错误箭头参数;};
        const expression=items.map(data => data.错误表达式参数);
        const expressionClosure=items.map(() => data.合法表达式);
        { let data=other; data.错误块; }
        data.好感;
    `]);
    assert.deepStrictEqual(usage.通讯录, ['关系', '合法表达式', '好感']);
});

test('字段扫描作用域：同名字段合法，多个数据别名和 entries 条目仍可扫描', () => {
    const usage = scan([`const a=state.stat_data.通讯录;
        const b=state.stat_data.技能;
        a.通讯录; b.熟练度;
        Object.entries(a).forEach(([key,item])=>{
            item.备注;
        });
    `]);
    assert.ok(usage.通讯录.includes('通讯录') && usage.通讯录.includes('备注'));
    assert.deepStrictEqual(usage.技能, ['熟练度']);
});

test('字段扫描作用域：字符串和注释中的别名声明不生成表格字段', () => {
    const usage = scan([`const example="const i=state.stat_data.通讯录; i.不存在";
        // const x=state.stat_data.技能; x.不存在
        const actual=state.stat_data.档案; actual.说明;
    `]);
    assert.strictEqual(usage.通讯录, undefined);
    assert.strictEqual(usage.技能, undefined);
    assert.deepStrictEqual(usage.档案, ['说明']);
});

test('字段扫描作用域：HTML 围栏内的真实脚本仍扫描，CSS 与展示文字不当作 JS', () => {
    const usage = scan(['```html\n<!doctype html><html><style>.a{content:"const i=stat.技能; i.假字段"}</style><script>const actual=state.stat_data.通讯录;actual.备注;</script><div>actual.假字段</div></html>\n```']);
    assert.deepStrictEqual(usage.通讯录, ['备注']);
    assert.strictEqual(usage.技能, undefined);
});

test('字段扫描作用域：浏览器构建内联扫描模块，无 require 仍能识别真实字段', () => {
    const fs = require('fs'), vm = require('vm');
    const index = core.assembleExtension({ coreSource: fs.readFileSync(require.resolve('../src/mvu2shujuku'), 'utf8') })['index.js'];
    // 执行真实构建中的工厂与核心，UI 启动不属于此用例。
    const factoryEnd = index.indexOf('\n})(typeof globalThis', index.indexOf('const VERSION ='));
    assert.ok(factoryEnd > 0);
    const end = index.indexOf('\n', factoryEnd + 1);
    const context = vm.createContext({ console });
    vm.runInContext(index.slice(0, end) + '\n})(globalThis);', context);
    const usage = context.MVU2SHUJUKU_CORE.scanStatusUsage({ name: '浏览器扫描', first_mes: 'function a(s){const i=s.stat_data.通讯录;i.备注;}function b(i){i.错误;}' }, ['通讯录']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(usage)), { 通讯录: ['备注'] });
});

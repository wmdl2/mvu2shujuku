'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const createSheetIdentity = require('../src/sheet-identity');

function card(data, extra = {}) {
    return { name: '表名身份回归', first_mes: '开场', ...extra,
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(data) }] } };
}
function verify(result, expected) {
    const identity = createSheetIdentity();
    const sheets = Object.entries(result.template).filter(([k]) => k.startsWith('sheet_')).map(([, s]) => s);
    assert.strictEqual(new Set(sheets.map(s => identity.physicalName(s.name))).size, sheets.length);
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    const metadata = (result.card.data || result.card).extensions.mvu2shujuku;
    const store = require('../src/stat-storage')({ readPolicy: () => metadata.statStorage, readChat: () => [] });
    assert.deepStrictEqual(store.merge(core.statDataFromTables(layout, result.template)).stat_data, expected);
    return sheets;
}

test('表名身份：符号、大小写与同音表保留不同路径和初值', () => {
    const data = { '机会': ['原值'], '$机会': ['独立值'], '_机会': [3], '事项': [4], '实项': [5], 'Case': [6], 'case': [7] };
    for (const mode of ['native', 'sqlite', 'both']) {
        const result = core.convert(card(data), { mode });
        const names = verify(result, data).map(s => s.name);
        assert.ok(names.includes('机会表'));
        assert.ok(!names.includes('$机会2表'));
        assert.ok(names.includes('_机会2表'));
        assert.ok(result.report.notes.some(n => /物理名称冲突/.test(n) && n.includes('$机会')));
    }
});

test('表名身份：多开场不同字段结构预建后仍只初始化当前分支', () => {
    const initial = { '$选项': [{ 行动: '前进' }] };
    const result = core.convert(card(initial, { alternate_greetings: [
        '<initvar>{"选项":[{"名称":"等待","来源":"开场"}]}</initvar>',
        '<initvar>{"$选项":[{"行动":"后退"}]}</initvar>',
    ] }));
    const names = verify(result, initial).map(s => s.name);
    assert.ok(names.includes('$选项表'));
    assert.ok(names.includes('选项2表'));
});

test('表名身份：嵌套派生表与顶层表统一分配', () => {
    const initial = { 名册: { 甲: { 技能: ['一'] }, 乙: { 技能: ['二'] } }, '名册_技能': ['顶层值'] };
    const result = core.convert(card(initial, { extensions: { tavern_helper: { scripts: [{
        name: 'Schema', enabled: true, content: 'registerMvuSchema(z.object({名册:z.record(z.string(),z.object({技能:z.array(z.string())})),名册_技能:z.array(z.string())}));',
    }] } } }));
    const names = verify(result, initial).map(s => s.name);
    assert.deepStrictEqual(names, ['名册表', '名册_技能表']);
    assert.strictEqual(result.schema[0].valueCol, '内容');
    const old = require('./legacy-layout-fixture')(card(initial, { extensions: { tavern_helper: { scripts: [{
        name: 'Schema', content: 'registerMvuSchema(z.object({名册:z.record(z.string(),z.object({技能:z.array(z.string())})),名册_技能:z.array(z.string())}));',
    }] } } }));
    assert.ok(verify(old, initial).some(s => s.name === '名册_技能2表'), '展开阶段仍消解派生表与根表的碰撞');
});

test('表名身份：截断后的编号可见，超长冲突不会循环或丢路径', () => {
    const prefix = '长'.repeat(50);
    const initial = { [prefix + '甲']: [1], [prefix + '乙']: [2], [prefix + '丙']: [3],
        ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['a'.repeat(60) + i, [i]])) };
    verify(core.convert(card(initial)), initial);
});

test('表名身份：浏览器内联工厂无 Node 外部作用域，使用锁定的多音字与繁体字规则', () => {
    const factory = vm.runInNewContext('(' + createSheetIdentity.toString() + ')', {});
    const browser = factory(), node = createSheetIdentity();
    for (const name of ['重庆表', '重慶表', '$状态表', '_状态表', '１２３表', '长'.repeat(50)]) {
        assert.strictEqual(browser.physicalName(name), node.physicalName(name));
    }
    assert.strictEqual(browser.physicalName('重庆表'), 'chongqingbiao');
    assert.strictEqual(browser.physicalName('重慶表'), 'zhongqingbiao');
    assert.strictEqual(browser.physicalName('１２３表'), 'table_123biao');
});

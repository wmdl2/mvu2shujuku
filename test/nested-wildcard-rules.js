'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const card = rules => ({ name: '嵌套占位规则', first_mes: '', character_book: { entries: [
    { comment: '[InitVar]', content: JSON.stringify({ 记录: { 甲: { 数量: 1, 价格: 2, 状态: '正常' } } }) },
    { comment: '变量更新规则', content: '变量更新规则:\n' + rules },
] } });
const parse = rules => core.parseMvuShapes(card(rules));
test('嵌套占位规则：三种占位段与点路径写法保留同一字段规则', () => {
    for (const token of ['${名称}', '<名称>', '*']) {
        const nested = parse(`  记录:\n    "${token}":\n      数量:\n        type: number\n        range: 0~10\n        format: 整数\n        check: 获得或消耗时才改变\n`);
        const dotted = parse(`  记录.${token}.数量:\n    type: number\n    range: 0~10\n    format: 整数\n    check: 获得或消耗时才改变\n`);
        const path = `记录.${token}.数量`;
        assert.deepStrictEqual(nested.wildcardRules.记录.find(r => r.path === path), dotted.wildcardRules.记录.find(r => r.path === path));
        assert.ok(nested.wildcardRules.记录.find(r => r.path === path)?.checks.length);
    }
});
test('嵌套占位规则：集合规则与深层字段同时保留完整路径，不串组', () => {
    const info = parse('  记录:\n    属性:\n      "${名称}":\n        check: 最多登记三项\n        数量:\n          check: 仅结算后变化\n        明细:\n          "<条目>":\n            数量:\n              check: 明细按凭证登记\n');
    const rules = info.wildcardRules.记录;
    for (const [path, text] of [['记录.属性.${名称}', '最多登记三项'], ['记录.属性.${名称}.数量', '仅结算后变化'], ['记录.属性.${名称}.明细.<条目>.数量', '明细按凭证登记']]) {
        assert.deepStrictEqual(rules.find(r => r.path === path)?.checks, [text]);
    }
    assert.ok(!info.wildcardRules.名称);
});
test('嵌套占位规则：候选字段展开、note 与 enum 保留，规则内容不被当成字段', () => {
    const info = parse('  记录:\n    "${名称}":\n      "${数量|价格}":\n        check: 依据本项凭证\n        note: 保留其他项目\n      状态:\n        enum: [正常, 锁定]\n        check:\n          - "提及 A.B 不等于更新字段"\n');
    for (const field of ['数量', '价格']) assert.deepStrictEqual(info.wildcardRules.记录.find(r => r.path === '记录.${名称}.' + field).checks, ['依据本项凭证', '保留其他项目']);
    assert.ok(info.enumPaths.some(e => e.path.join('.') === '记录.${名称}.状态' && e.enum.join('/') === '正常/锁定'));
    assert.ok(![...info.wildcardFields].some(p => p.includes('A.B') || p.includes('.check')));
});
test('嵌套占位规则：转换后的实际表格 note 保留嵌套业务规则', () => {
    const source = require('./nullable-records').source();
    source.character_book.entries[1].content = '变量更新规则:\n  记录:\n    "${名称}":\n      数量:\n        check: 仅获得或消耗物品时改变数量\n';
    const result = core.convert(source, { mode: 'both' });
    const table = Object.values(result.template).find(s => s.name === '记录表');
    assert.match(table.sourceData.note, /仅获得或消耗物品时改变数量/);
    assert.ok(!result.schema.find(g => g.tableName === '记录表').columns.some(c => c.zh.includes('${')));
});

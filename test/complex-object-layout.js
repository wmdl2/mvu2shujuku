'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function convert(fields, value, importHelper = true, rows = true) {
    const record = { 姓名: '甲', 属性: value };
    const initial = { 角色: rows ? { 甲: record } : record };
    const card = { name: '嵌套对象边界', first_mes: '', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(initial) }] },
        extensions: { tavern_helper: { scripts: [{ name: '结构', content:
            (importHelper ? "import {registerMvuSchema} from 'https://example.test/mvu_zod.js';\n" : '')
            + `const S=z.object({角色:${rows ? 'z.record(z.string(),' : ''}z.object({姓名:z.string(),属性:z.object({${fields}})})${rows ? ')' : ''}});registerMvuSchema(S);` }] } } };
    const result = core.convert(card);
    return { ...result, initial, layout: JSON.parse(result.card.extensions.mvu2shujuku.layout) };
}

for (const [label, fields, value] of [
    ['动态字典', '数值:z.number(),记录:z.record(z.string(),z.string())', { 数值: 1.5, 记录: { 甲: '已发生' } }],
    ['数组', '数值:z.number(),记录:z.array(z.string())', { 数值: 1.5, 记录: ['甲', '甲', '乙'] }],
    ['可缺失容器', '数值:z.number(),记录:z.object({说明:z.string()}).optional()', { 数值: 1.5 }],
    ['可空容器', '数值:z.number(),记录:z.object({说明:z.string()}).nullable()', { 数值: 1.5, 记录: null }],
    ['隐藏字段', '数值:z.number(),$缓存:z.string()', { 数值: 1.5, $缓存: '禁止复制进提示词的值' }],
    ['变换输出', '数值:z.number().transform(v=>v),说明:z.string()', { 数值: 1.5, 说明: '正常' }],
]) for (const rows of [true, false]) test('复杂对象边界：' + label + (rows ? '字典' : '固定对象') + '完整替换与JSON回退', async () => {
    const result = convert(fields, value, true, rows), group = result.schema.find(g => g.name === '角色');
    assert.strictEqual(group.kind, 'singleton');
    assert(group.valueCol, '保留父容器完整替换时的缺失状态');
    assert.strictEqual(result.schema.length,1);
    assert(!group.overflowCol);
    assert.deepStrictEqual(core.statDataFromTables(result.layout, result.template).stat_data, result.initial);
    const sheet = Object.values(result.template).find(s => s.name === group.tableName);
    assert(!JSON.stringify(sheet.sourceData).includes('禁止复制进提示词的值'));
    assert(!sheet.sourceData.ddl.includes(JSON.stringify(value)), '完整初值仅在数据行保存');
    const next = structuredClone(result.initial); (rows ? next.角色.甲 : next.角色).属性.数值 = 2.5;
    const written = await core.writeStatDiffToDbResult(applyingApi(result.template), result.layout, result.initial, next);
    assert(written.ok, written.reason);
    assert.deepStrictEqual(core.statDataFromTables(result.layout, result.template).stat_data, next);
});

test('复杂对象边界：固定对象的未声明脚本字段保留在完整所属对象中', async () => {
    const result = convert('数值:z.number(),说明:z.string()', { 数值: 1.5, 说明: '正常' });
    const group = result.schema.find(g => g.name === '角色');
    assert(group.valueCol);
    assert(!group.overflowCol, '完整JSON不再重复保存扩展字段');
    const next = structuredClone(result.initial); next.角色.甲.脚本标记 = '稍后新增';
    const written = await core.writeStatDiffToDbResult(applyingApi(result.template), result.layout, result.initial, next);
    assert(written.ok, written.reason);
    assert.deepStrictEqual(core.statDataFromTables(result.layout, result.template).stat_data, next);
});

test('复杂对象边界：无Schema字典检查全部原记录的隐藏字段', () => {
    const initial = { 角色: {
        甲: { 姓名: '甲', 属性: { 数值: 1.5, 说明: '正常' } },
        乙: { 姓名: '乙', 属性: { 数值: 2.5, 说明: '正常', $缓存: '隐藏值不得复制进提示' } },
    } };
    const result = core.convert({ name: '原记录边界', first_mes: '', character_book: {
        entries: [{ comment: '[InitVar]', content: JSON.stringify(initial) }],
    } });
    const group = result.schema.find(g => g.name === '角色');
    assert.strictEqual(group.kind, 'singleton');
    assert(group.columns.find(c => c.zh === group.valueCol)?.isObject);
    assert(!group.columns.some(c => c.zh.startsWith('属性_')));
    const sheet = Object.values(result.template).find(s => s.name === group.tableName);
    assert(!JSON.stringify(sheet.sourceData).includes('隐藏值不得复制进提示'));
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(result.card.extensions.mvu2shujuku.layout), result.template).stat_data, initial);
});

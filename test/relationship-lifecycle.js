'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function fixture() {
    const initial = { 关系: {
        甲: { 好感: 1, 背包: { 同名物品: { 数量: 1, 效果: { 同名效果: { 强度: 1 } } } }, 日志: ['甲1', '甲2', '甲3'] },
        乙: { 好感: 2, 背包: { 同名物品: { 数量: 2, 效果: { 同名效果: { 强度: 2 } } } }, 日志: ['乙1', '乙2', '乙3'] },
    } };
    const rule = '变量更新规则:\n  关系:\n    type: |-\n      { [名称: string]: { 好感: number; 背包: { [物品: string]: { 数量: number; 效果: { [效果名: string]: { 强度: number; } }; } }; 日志: string[]; } }';
    const result = core.convert({ name: '关系生命周期', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(initial) }, { comment: '变量更新规则', content: rule },
    ] } });
    return { initial, template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}
function assertNoOrphans(layout, tables) {
    const sheets = new Map(Object.values(tables).filter(sheet => sheet.content).map(sheet => [sheet.name, sheet]));
    for (const child of layout.filter(entry => ['nestedRows', 'nestedArray'].includes(entry.kind))) {
        const parent = layout.find(entry => entry.table === child.parentTable);
        assert.ok(parent, child.table);
        const parentKeys = [...(parent.ancestorKeyCols || []), parent.keyCol];
        const childKeys = child.ancestorKeyCols?.length ? child.ancestorKeyCols : [child.parentKeyCol];
        assert.strictEqual(parentKeys.length, childKeys.length);
        const ps = sheets.get(parent.table), cs = sheets.get(child.table);
        const parentSet = new Set(ps.content.slice(1).map(row => JSON.stringify(parentKeys.map(key => String(row[ps.content[0].indexOf(key)])))));
        for (const row of cs.content.slice(1)) {
            const key = JSON.stringify(childKeys.map(col => String(row[cs.content[0].indexOf(col)])));
            assert.ok(parentSet.has(key), child.table + ' 孤儿行: ' + key);
        }
    }
}
test('关系生命周期：删除或重命名父行同时清理后代物理行，保留其他祖先下同名记录', async () => {
    for (const operation of ['delete', 'rename', 'delete-child']) {
        const { initial, template, layout } = fixture();
        const next = structuredClone(initial);
        if (operation === 'rename') next.关系.丙 = next.关系.甲;
        if (operation === 'delete-child') delete next.关系.甲.背包.同名物品;
        else delete next.关系.甲;
        next.关系.乙.好感 = 42;
        next.关系.乙.背包.同名物品.数量 = 7;
        next.关系.乙.日志 = ['更新后的日志'];
        await core.writeStatDiffToDb(applyingApi(template), layout, initial, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
        assertNoOrphans(layout, template);
    }
});
test('关系生命周期：省略整个父组属于部分写入，不能触发后代清理', async () => {
    const { initial, template, layout } = fixture(), snapshot = JSON.stringify(template);
    await core.writeStatDiffToDb(applyingApi(template), layout, initial, {});
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.strictEqual(JSON.stringify(template), snapshot);
    assertNoOrphans(layout, template);
});

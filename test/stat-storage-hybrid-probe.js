"use strict";
// Candidate contract research, not an enabled conversion layout or host acceptance.
// DDL, codec and script writer below are the actual product implementations.
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { core, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
const payloadColumn = process.argv.includes('--hidden-column') ? '$记录数据' : '扩展数据';
const initial = { 背包: {
    药水: { 数量: 3, $缓存: '甲' },
    铁剑: { 数量: 3, $缓存: '乙' },
} };
const layout = [{ kind: 'rows', group: '背包', table: '背包表', keyCol: '物品名称',
    writePaths: [['背包']], overflowCol: payloadColumn,
    cols: [['物品名称', 'text', '', []], ['数量', 'number', 0, ['数量']],
        [payloadColumn, 'object', {}, [payloadColumn]]] }];
const group = { name: '背包', tableName: '背包表', ident: 'inventory', kind: 'rows',
    keyCol: '物品名称', keyValue: '', childTables: [],
    columns: [
        { zh: '物品名称', ident: 'item', path: [], type: 'TEXT', value: '' },
        { zh: '数量', ident: 'quantity', path: ['数量'], type: 'REAL', value: 0 },
        { zh: payloadColumn, ident: 'private_payload', path: [payloadColumn], type: 'TEXT',
            isObject: true, jsonKind: 'object', value: '{}' },
    ], rows: [[1, '药水', 3, '{"$缓存":"甲"}'], [2, '铁剑', 3, '{"$缓存":"乙"}']],
};
const template = core.generateTemplate([group], { mode: 'sqlite', targetSpVersion: 'naiv1.2.6' });
const key = Object.keys(template).find(key => key.startsWith('sheet_'));
const originalSheet = template[key];
assert.deepStrictEqual(originalSheet.sourceData.hiddenPhysicalColumns, payloadColumn.startsWith('$') ? ['private_payload'] : undefined);
for (const field of ['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode']) {
    assert(!originalSheet.sourceData[field].includes('甲'), field);
    assert(!originalSheet.sourceData[field].includes('乙'), field);
}
const cases = [
    { name: '按业务键局部修改，所属记录的隐藏值不变',
      sql: "UPDATE inventory SET quantity=quantity-1 WHERE item='药水'",
      expected: { 背包: { 药水: { 数量: 2, $缓存: '甲' }, 铁剑: initial.背包.铁剑 } } },
    { name: '删除指定记录，隐藏值一起删除且不污染其他记录',
      sql: "DELETE FROM inventory WHERE item='药水'",
      expected: { 背包: { 铁剑: initial.背包.铁剑 } } },
    { name: '更改业务键，完整记录随物理行移动',
      sql: "UPDATE inventory SET item='药剂' WHERE item='药水'",
      expected: { 背包: { 药剂: initial.背包.药水, 铁剑: initial.背包.铁剑 } } },
    { name: '同名新记录不继承旧隐藏值',
      sql: "DELETE FROM inventory WHERE item='药水'; INSERT INTO inventory(row_id,item,quantity) VALUES(3,'药水',9)",
      expected: { 背包: { 药水: { 数量: 9 }, 铁剑: initial.背包.铁剑 } } },
    { name: '清空不会从模板初值或旧下标恢复记录',
      sql: 'DELETE FROM inventory', expected: { 背包: {} } },
    { name: '记录内动态数组删除首项，隐藏子字段随完整元素删除',
      sql: `UPDATE inventory SET private_payload=json_remove(json_set(private_payload,'$.附件',json('[{"数量":1,"$缓存":"子甲"},{"数量":1,"$缓存":"子乙"}]')),'$.附件[0]') WHERE item='药水'`,
      expected: { 背包: { 药水: { ...initial.背包.药水, 附件: [{ 数量: 1, $缓存: '子乙' }] }, 铁剑: initial.背包.铁剑 } } },
];
const evidence = [];
for (const entry of cases) {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(originalSheet.sourceData.ddl);
        const insert = db.prepare('INSERT INTO inventory(row_id,item,quantity,private_payload) VALUES(?,?,?,?)');
        for (const row of originalSheet.content.slice(1)) insert.run(...row);
        db.exec(entry.sql);
        const sheet = clone(originalSheet);
        sheet.content = [sheet.content[0], ...db.prepare('SELECT row_id,item,quantity,private_payload FROM inventory ORDER BY row_id').all()
            .map(row => [row.row_id, row.item, String(row.quantity), row.private_payload])];
        assert.deepStrictEqual(core.statDataFromTables(layout, { [key]: sheet }).stat_data, entry.expected);
        evidence.push({ name: entry.name, passed: true });
    } finally { db.close(); }
}
(async () => {
    for (const [name, next] of [
        ['作者完整替换对象，省略的隐藏键移除', { 背包: { 药水: { 数量: 9 }, 铁剑: initial.背包.铁剑 } }],
        ['作者显式修改隐藏键', { 背包: { 药水: { 数量: 3, $缓存: '丙' }, 铁剑: initial.背包.铁剑 } }],
        ['作者新增公开字段，仍保存在所属记录', { 背包: { 药水: { ...initial.背包.药水, 颜色: '红' }, 铁剑: initial.背包.铁剑 } }],
        ['作者新增记录，隐藏键归属新行', { 背包: { ...initial.背包, 宝石: { 数量: 1, $缓存: '丁' } } }],
    ]) {
        const tables = clone(template), api = applyingApi(tables);
        const result = await core.writeStatDiffToDbResult(api, layout, clone(initial), clone(next));
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, next, name);
        evidence.push({ name, passed: true });
        if (name === '作者新增公开字段，仍保存在所属记录') {
            const sheet = tables[key], keyIndex = sheet.content[0].indexOf('物品名称');
            const rowIndex = sheet.content.findIndex((row, i) => i > 0 && row[keyIndex] === '药水');
            assert(await api.deleteRow('背包表', rowIndex));
            assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, { 背包: { 铁剑: initial.背包.铁剑 } });
            evidence.push({ name: '删除记录同时删除它的新增公开字段，读回不复活记录', passed: true });
        }
    }
    console.log(JSON.stringify({ scope: '混合布局候选：产品DDL/codec/writer；Node SQLite与CRUD替代，非转换或实际宿主',
        payloadColumn, passed: evidence.length, evidence }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

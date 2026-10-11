'use strict';
// 研究原型，非已接入的产品实现：完整候选由 SQLite 执行一次，再分配存储。
// 使用产品生成的真实 DDL；不能以本文件通过证明宿主已有相应扩展接口。
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { core } = require('./helpers');
const createStorage = require('../src/stat-storage');
const clone = value => JSON.parse(JSON.stringify(value));
const initial = { 列表: [{ 名字: '相同', $缓存: '甲' }, { 名字: '相同', $缓存: '乙' }] };
const cases = [
    { name: '行表删除首项', sql: 'DELETE FROM liebiaobiao WHERE row_id=1', reference: s => s.列表.splice(0, 1) },
    { name: '行表删除尾项', sql: 'DELETE FROM liebiaobiao WHERE row_id=2', reference: s => s.列表.splice(1, 1) },
    { name: '行表局部 JSON 更新', sql: `UPDATE liebiaobiao SET neirong=json_set(neirong,'$.名字','更新') WHERE row_id=1`, reference: s => { s.列表[0].名字 = '更新'; } },
    { name: '行表完整 JSON 替换', sql: `UPDATE liebiaobiao SET neirong='{"名字":"替换"}' WHERE row_id=1`, reference: s => { s.列表[0] = { 名字: '替换' }; } },
    { name: '完整 JSON 删除首项', whole: true, sql: `UPDATE liebiaobiao SET neirong=json_remove(neirong,'$[0]')`, reference: s => s.列表.splice(0, 1) },
    { name: '完整 JSON 删除尾项', whole: true, sql: `UPDATE liebiaobiao SET neirong=json_remove(neirong,'$[1]')`, reference: s => s.列表.splice(1, 1) },
    { name: '完整 JSON 元素重排', whole: true, sql: `UPDATE liebiaobiao SET neirong=(SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(neirong) ORDER BY key DESC))`, reference: s => s.列表.reverse() },
    { name: '完整 JSON 容器替换', whole: true, sql: `UPDATE liebiaobiao SET neirong='[{"名字":"替换"}]'`, reference: s => { s.列表 = [{ 名字: '替换' }]; } },
];
const store = createStorage();
const evidence = [];
for (const entry of cases) {
    const result = core.convert({ name: '结构操作公开研究', first_mes: '', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(initial) },
    ] } }, { mode: 'sqlite', jsonContainers: !!entry.whole });
    const sheet = Object.values(result.template).find(s => s.name === '列表表');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(sheet.sourceData.ddl);
        const insert = db.prepare('INSERT INTO liebiaobiao(row_id, neirong) VALUES (?, ?)');
        if (entry.whole) insert.run(1, JSON.stringify(initial.列表));
        else initial.列表.forEach((value, index) => insert.run(index + 1, JSON.stringify(value)));
        db.exec(entry.sql); // 原操作只执行一次，不在提交后重新执行 SQL。
        const cells = db.prepare('SELECT neirong FROM liebiaobiao ORDER BY row_id').all().map(row => JSON.parse(row.neirong));
        const full = { 列表: entry.whole ? cells[0] : cells };
        const expected = clone(initial);
        entry.reference(expected);
        assert.deepStrictEqual(full, expected);
        const projected = store.split(full);
        assert.deepStrictEqual(store.combine(projected.database, projected.native), expected);
        evidence.push({ name: entry.name, passed: true, mutationExecutions: 1 });
    } finally { db.close(); }
}
console.log(JSON.stringify({ scope: '完整候选执行研究，未接入产品或宿主', evidence }, null, 2));

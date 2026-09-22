'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
const valueSchema = `z.object({ 数量: z.number().min(0).max(10).describe('持有数量'), 文本: z.string(), 明细: z.record(z.string(), z.number()) }).nullish()`;
const recordSchema = `z.record(z.string(), ${valueSchema})`;
function source(stat = initial()) {
    return { name: '可空动态记录公开样本', first_mes: '开场',
        extensions: { tavern_helper: { scripts: [{ name: '结构', content: `const S = z.object({
            记录: ${recordSchema}, 列表记录: z.record(z.string(), z.array(z.number()).nullish()),
            状态: z.object({ 记录: ${recordSchema} }),
            角色: z.record(z.string(), z.object({ 背包: ${recordSchema}, 藏库: z.record(z.string(), z.object({ 效果: ${recordSchema} })) }))
        }); registerMvuSchema(S);` }] } },
        character_book: { entries: [ { comment: '[InitVar]', content: JSON.stringify(stat) },
            { comment: '变量更新规则', content: '变量更新规则:\n  记录.${名称}.数量:\n    check: 仅获得或消耗物品时改变数量\n' } ] } };
}
function initial() {
    const actor = n => ({ 背包: { 同名: n === 1 ? null : { 数量: n, 文本: '乙', 明细: {} } },
        藏库: { 同名: { 效果: { 同名: n === 1 ? {} : { 数量: n, 文本: '乙', 明细: { 保留: 1 } } } } } });
    return { 记录: { 空值: null, 空对象: {}, 有值: { 数量: 2, 文本: '原值', 明细: { 保留: 3 } } },
        列表记录: { 空值: null, 空数组: [], 有值: [1, 2, 3] }, 状态: { 记录: { 甲: null } },
        角色: { 甲: actor(1), 乙: actor(2) }, 背包: ['钥匙', 0, false, null], 普通: { 文本: '不变' } };
}
function fixture(stat = initial()) {
    const result = core.convert(source(stat), { mode: 'both' });
    return { result, template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}
function rowsFixture(layout, template) {
    return layout.filter(e => e.scalarValueCol).map(e => ({ e, sheet: Object.values(template).find(s => s.name === e.table) }));
}
test('可空动态记录：根、单例内与多层关联记录初值无损，保留结构和业务规则', () => {
    const before = initial(), { layout, template } = fixture(before);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, before);
    const projected = rowsFixture(layout, template);
    assert.strictEqual(projected.length, 5);
    for (const { e, sheet } of projected) {
        assert.strictEqual(e.cols.find(c => c[0] === e.scalarValueCol)[1], 'jsonObjectOptional');
        assert.strictEqual(e.cols.length, 2 + (e.ancestorKeyCols || []).length);
        assert.match(sheet.sourceData.note, /JSON null/);
        assert.match(sheet.sourceData.note, /删除行表示/);
        assert.match(sheet.sourceData.note, /json_set/);
    }
    assert.match(projected.find(x => x.e.table === '记录表').sheet.sourceData.note, /仅获得或消耗物品/);
    assert.match(projected.find(x => x.e.table === '记录表').sheet.sourceData.note, /持有数量/);
    assert.ok(!layout.some(e => /明细/.test(e.table)), '完整记录内部不再派生重复表');
});
test('可空动态记录：空字典也按声明建列，新增 null 和对象可读回', async () => {
    const before = { 记录: {}, 列表记录: {}, 状态: { 记录: {} }, 角色: {} };
    const { layout, template } = fixture(before);
    const next = clone(before); next.记录.甲 = null; next.记录.乙 = {}; next.列表记录.甲 = [];
    next.角色.甲 = { 背包: { 同名: null }, 藏库: { 同名: { 效果: { 同名: { 数量: 3 } } } } };
    await core.writeStatDiffToDb(applyingApi(template), layout, before, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});
test('可空动态记录：新增、更新、删除、改名及同名多层归属，CRUD 只传标量', async () => {
    for (const mode of ['crud', 'cell']) {
        let before = initial(); const { layout, template } = fixture(before), api = applyingApi(template);
        const calls = [];
        for (const name of ['updateRow', 'updateCell', 'insertRow', 'importTableAsJson']) {
            const original = api[name];
            api[name] = async (...args) => {
                const values = name === 'updateRow' ? Object.values(args[2]) : name === 'insertRow' ? Object.values(args[1]) : name === 'updateCell' ? [args[3]] : [args[0]];
                for (const value of values) assert.ok(['string', 'number'].includes(typeof value), name + ' 不得传对象');
                calls.push(name); return original(...args);
            };
        }
        if (mode === 'cell') delete api.updateRow;
        for (const value of [null, {}, { 数量: 4, 文本: '新', 明细: { 未声明: 2 } }, undefined]) {
            const next = clone(before);
            for (const dict of [next.记录, next.状态.记录, next.角色.甲.背包, next.角色.甲.藏库.同名.效果]) {
                if (value === undefined) delete dict.同名; else dict.同名 = value;
            }
            next.列表记录.新 = value === null ? null : value === undefined ? [] : [4];
            await core.writeStatDiffToDb(api, layout, before, next, clone(template));
            assert.strictEqual(core.lastStatWriteFailed, false, mode);
            assert.deepStrictEqual(core.statDataFromTables(layout, clone(template)).stat_data, next, mode);
            assert.strictEqual(await core.writeStatDiffToDb(api, layout, next, next), 0);
            before = next;
        }
        const next = clone(before); next.记录.改名 = next.记录.有值; delete next.记录.有值; delete next.角色.甲;
        await core.writeStatDiffToDb(api, layout, before, next, clone(template));
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
        assert.ok(calls.includes('updateCell') && calls.includes('insertRow'), mode);
        assert.ok(!calls.includes('updateRow'), '单列更新沿用 updateCell，不虚构 updateRow 覆盖');
    }
});
test('可空动态记录：错误类型在任何写入前拒绝', async () => {
    for (const value of [[], '错误', 3, { 数量: Infinity }]) {
        const before = initial(), { layout, template } = fixture(before), snapshot = clone(template);
        const next = clone(before); next.普通.文本 = '不能部分提交'; next.记录.空值 = value;
        await core.writeStatDiffToDb(applyingApi(template), layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, true);
        assert.deepStrictEqual(template, snapshot);
    }
});
test('可空动态记录：模型单元格空值、空对象和删除行读回区分', () => {
    const { layout, template } = fixture(), { e, sheet } = rowsFixture(layout, template).find(x => x.e.table === '记录表');
    const ci = sheet.content[0].indexOf(e.scalarValueCol);
    for (const [encoded, expected] of [['null', null], ['{}', {}], ['', undefined], ['{"数量":5}', { 数量: 5 }]]) {
        sheet.content[1][ci] = encoded;
        const read = core.statDataFromTables(layout, template).stat_data;
        assert.deepStrictEqual(read.记录.空值, expected);
        assert.strictEqual(Object.hasOwn(read.记录, '空值'), expected !== undefined);
    }
    sheet.content.splice(1, 1);
    assert.ok(!Object.hasOwn(core.statDataFromTables(layout, template).stat_data.记录, '空值'));
});
module.exports = { source, fixture, initial };

test('可空动态记录：浏览器序列化候选工厂支持 null 与新增，原表不变', async () => {
    const create = require('vm').runInNewContext('(' + require('../src/extension-runtime').createCandidateBuilder.toString() + ')');
    const before = initial(), { layout, template } = fixture(before), snapshot = clone(template);
    const next = clone(before); next.记录.有值 = null; next.角色.甲.背包.新 = {}; delete next.记录.空对象;
    const candidate = await create({ core }).buildUpdatedTemplateFromStat(layout, before, next, template);
    assert.ok(candidate);
    assert.deepStrictEqual(core.statDataFromTables(layout, candidate).stat_data, next);
    assert.deepStrictEqual(template, snapshot);
});
test('可空动态记录：SQLite 初值哨兵、类型约束和 JSON 局部更新', () => {
    const stat = initial(); stat.记录.哨兵甲 = { 数量: -1 }; stat.记录.哨兵乙 = { 数量: '未获得' };
    const { template } = fixture(stat), sheets = Object.values(template).filter(s => s && s.content);
    const output = require('child_process').spawnSync('python3', ['-c', `
import json, sqlite3, sys
sheets=json.load(sys.stdin); db=sqlite3.connect(':memory:')
for s in sheets:
 ddl=s['sourceData']['ddl']; db.execute(ddl); t=ddl.split()[2]
 for row in s['content'][1:]: db.execute('INSERT INTO '+t+' VALUES ('+','.join('?' for _ in row)+')', row)
s=next(s for s in sheets if s['name']=='记录表'); t=s['sourceData']['ddl'].split()[2]
cols=[r[1] for r in db.execute('PRAGMA table_info('+t+')')]; key,col=cols[1:]
where=' WHERE '+key+'=?'
for value in ['null','{}','', '{"数量":4,"文本":"保留"}']:
 db.execute('UPDATE '+t+' SET '+col+'=?'+where,(value,'有值'))
 assert db.execute('SELECT '+col+' FROM '+t+where,('有值',)).fetchone()[0] == value
db.execute('UPDATE '+t+' SET '+col+'=json_set('+col+', ?, ?)'+where,('$."数量"',5,'有值'))
assert json.loads(db.execute('SELECT '+col+' FROM '+t+where,('有值',)).fetchone()[0]) == {'数量':5,'文本':'保留'}
for value in ['[]','1','bad-json','{"数量":11}']:
 try: db.execute('UPDATE '+t+' SET '+col+'=?'+where,(value,'有值'))
 except sqlite3.DatabaseError: continue
 raise AssertionError('accepted '+value)
print('sqlite-ok')
`], { input: JSON.stringify(sheets), encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(output.status, 0, String(output.error || output.stderr));
    assert.match(output.stdout, /sqlite-ok/);
});

test('可空动态记录：持久化重放守卫区分完整关联键，只拦截同一记录', async () => {
    for (const sameAncestor of [false, true]) {
        const before = initial(); delete before.角色.甲.背包.同名;
        const { layout, template } = fixture(before), snapshot = clone(template);
        if (sameAncestor) {
            const { template: persisted } = fixture(initial());
            for (const [key, sheet] of Object.entries(persisted)) if (sheet.name === '角色_背包表') snapshot[key] = sheet;
        }
        const next = clone(before); next.角色.甲.背包.同名 = { 数量: 3 };
        let inserts = 0; const api = applyingApi(template), insert = api.insertRow;
        api.insertRow = async (...args) => { inserts++; return insert(...args); };
        await core.writeStatDiffToDb(api, layout, before, next, snapshot);
        assert.strictEqual(core.lastStatWriteFailed, sameAncestor);
        assert.strictEqual(inserts, sameAncestor ? 0 : 1);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, sameAncestor ? before : next);
    }
});

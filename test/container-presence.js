'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
const script = `const S = z.object({
    状态: z.object({ 存量: z.number().min(0).max(10).describe('存量'), 模式: z.enum(['甲', '乙']), 线索: z.object({ 文本: z.string() }).optional() }).nullish(),
    List: z.array(z.object({ name: z.string() })).nullish(),
    Dict: z.record(z.string(), z.object({ 存量: z.number() })).nullish(),
    Stable: z.object({ text: z.string() })
}); registerMvuSchema(S);`;
function fixture(stat, options = {}) {
    const result = core.convert({ name: '整组空值公开样本', first_mes: '开场',
        extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: script }] } },
        character_book: { entries: [
            { comment: '[InitVar]', content: JSON.stringify(stat) },
            { comment: '变量更新规则', content: '变量更新规则:\n  状态:\n    存量:\n      check: 完成任务后增加存量，不能凭空增加\n    线索:\n      check: 仅在取得线索后登记\n' },
        ] } }, { mode: 'both', ...options });
    return { result, template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}
test('整组空值：可空对象、数组与字典初值和缺表默认无损，普通表不变', () => {
    for (const values of [{ 状态: null, List: null, Dict: null }, { 状态: {}, List: [], Dict: {} }, {},
        { 状态: { 存量: 2, 线索: { 文本: '线索' } }, List: [{ name: '甲' }], Dict: { one: { 存量: 3 } } }]) {
        const initial = { ...values, Stable: { text: '普通字段' } };
        const { layout, template } = fixture(initial);
        for (const group of ['状态', 'List', 'Dict']) {
            const entry = layout.find(e => e.group === group);
            assert.ok(entry && entry.kind === 'singleton' && entry.valueCol, group + ' 必须登记完整容器列');
            assert.strictEqual(entry.cols.length, 1);
        }
        assert.strictEqual(layout.find(e => e.group === 'Stable').valueCol, '');
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
        assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data, initial);
    }
});
test('整组空值：有值、null、空容器、缺失往返且重复更新无写入', async () => {
    let before = { 状态: { 存量: 1 }, List: [{ name: '甲' }], Dict: { one: { 存量: 2 } }, Stable: { text: '普通字段' } };
    const { layout, template } = fixture(before), api = applyingApi(template);
    for (const values of [{ 状态: null, List: null, Dict: null }, { 状态: {}, List: [], Dict: {} }, {},
        { 状态: { 存量: 3 }, List: [{ name: '乙' }], Dict: { two: { 存量: 4 } } }]) {
        const next = { ...values, Stable: { text: '普通字段' } };
        await core.writeStatDiffToDb(api, layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        const read = core.statDataFromTables(layout, clone(template)).stat_data;
        assert.deepStrictEqual(read, next);
        assert.strictEqual(await core.writeStatDiffToDb(api, layout, read, read), 0);
        before = next;
    }
});
test('整组空值：模型直接修改单元格能表示三态，不依赖隐藏状态列', () => {
    const { layout, template } = fixture({ 状态: { 存量: 1 }, Stable: { text: '普通字段' } });
    const entry = layout.find(e => e.group === '状态'), sheet = Object.values(template).find(t => t.name === entry.table);
    const ci = sheet.content[0].indexOf(entry.valueCol);
    for (const [cell, expected] of [['null', { 状态: null }], ['{}', { 状态: {} }], ['', {}], ['{"存量":4}', { 状态: { 存量: 4 } }]]) {
        sheet.content[1][ci] = cell;
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, { ...expected, Stable: { text: '普通字段' } });
    }
    assert.match(sheet.sourceData.note, /完成任务后增加存量/);
    assert.match(sheet.sourceData.note, /仅在取得线索后登记/);
    assert.match(sheet.sourceData.note, /存量/);
    assert.match(sheet.sourceData.note, /0.*10/);
    assert.match(sheet.sourceData.note, /json_set/);
});
test('整组空值：错误容器和不可序列化内容在宿主写入前拒绝', async () => {
    const initial = { 状态: { 存量: 1 }, List: [], Dict: {}, Stable: { text: '普通字段' } };
    for (const [key, value] of [['状态', []], ['List', {}], ['Dict', 1], ['状态', { 存量: Infinity }]]) {
        const { layout, template } = fixture(initial), api = applyingApi(template), snapshot = clone(template);
        await core.writeStatDiffToDb(api, layout, initial, { ...initial, [key]: value });
        assert.strictEqual(core.lastStatWriteFailed, true);
        assert.deepStrictEqual(template, snapshot);
    }
});
module.exports = { fixture, script };

test('整组空值：浏览器序列化候选工厂保留缺失与空容器，原表不变', async () => {
    const create = require('vm').runInNewContext('(' + require('../src/extension-runtime').createCandidateBuilder.toString() + ')');
    const before = { 状态: { 存量: 1 }, List: [], Dict: {}, Stable: { text: '原值' } };
    const { template, layout } = fixture(before), snapshot = clone(template);
    for (const next of [{ 状态: null, List: null, Stable: { text: '原值' } }, { Stable: { text: '新值' } }]) {
        const candidate = await create({ core }).buildUpdatedTemplateFromStat(layout, before, next, template);
        assert.ok(candidate);
        assert.deepStrictEqual(core.statDataFromTables(layout, candidate).stat_data, next);
        assert.deepStrictEqual(template, snapshot);
    }
});

test('整组空值：SQLite 实际执行三态切换与 JSON 路径更新', () => {
    const { template } = fixture({ 状态: { 存量: 1 }, List: [], Dict: {}, Stable: { text: '原值' } }, { mode: 'sqlite' });
    const sheet = Object.values(template).find(s => s.name === '状态表');
    const sentinelSheets = ['', '未获得', -1, '5'].map(value => Object.values(fixture({ 状态: { 存量: value, 模式: '尚未选择' }, Stable: { text: '原值' } }, { mode: 'sqlite' }).template).find(s => s.name === '状态表'));
    const output = require('child_process').spawnSync('python3', ['-c', `
import json, sqlite3, sys
data=json.load(sys.stdin); s=data['sheet']; db=sqlite3.connect(':memory:'); ddl=s['sourceData']['ddl']; db.execute(ddl)
t=ddl.split()[2]; col=ddl.splitlines()[2].strip().split()[0]
db.execute('INSERT INTO '+t+' VALUES (?,?)', s['content'][1])
for v in ['', 'null', '{}', '{"存量":2}']:
 db.execute('UPDATE '+t+' SET '+col+'=?', (v,))
 assert db.execute('SELECT '+col+' FROM '+t).fetchone()[0] == v
db.execute('UPDATE '+t+' SET '+col+'=json_set('+col+', ?, ?)', ('$."存量"',3))
assert json.loads(db.execute('SELECT '+col+' FROM '+t).fetchone()[0]) == {'存量':3}
for v in ['[]', '1', '"text"', 'bad-json', '{"存量":11}', '{"存量":-1}', '{"模式":"丙"}']:
 try: db.execute('UPDATE '+t+' SET '+col+'=?',(v,))
 except sqlite3.DatabaseError: continue
 raise AssertionError('accepted '+v)
for sentinel in data['sentinels']:
 d=sqlite3.connect(':memory:'); ddl=sentinel['sourceData']['ddl']; d.execute(ddl)
 d.execute('INSERT INTO '+ddl.split()[2]+' VALUES (?,?)', sentinel['content'][1])
print('OK')
`], { input: JSON.stringify({ sheet, sentinels: sentinelSheets }), encoding: 'utf8', timeout: 30000 });
    assert.ifError(output.error);
    assert.strictEqual(output.status, 0, output.stderr);
    assert.strictEqual(output.stdout.trim(), 'OK');
});

test('整组空值：结构声明的内部约束有说明，动态约束不能冒充 SQL 已校验', () => {
    const { result, layout } = fixture({ Stable: { text: '原值' } });
    const root = result.schema.find(g => g.name === '状态');
    assert.ok(root.columns[0].jsonPathChecks.some(c => c.path.join('.') === '存量'));
    assert.match(Object.values(result.template).find(t => t.name === root.tableName).sourceData.note, /模式.*甲.*乙/);
    assert.ok(layout.find(e => e.group === '状态').cols[0][6], '初始缺失不应造默认对象');
    const source = { name: '动态约束告知', extensions: { tavern_helper: { scripts: [{ name: '结构',
        content: 'const S = z.object({ 记录: z.record(z.string(), z.object({ 数量: z.number().min(0).max(3) })).nullish() }); registerMvuSchema(S);' }] } },
        character_book: { entries: [{ comment: '[InitVar]', content: '{"记录":{"甲":{"数量":1}}}' }] } };
    const converted = core.convert(source);
    assert.match(converted.reportText, /CHECK 无法遍历任意元素/);
    assert.match(Object.values(converted.template).find(t => t.name === '记录表').sourceData.note, /数量.*0.*3/);
});

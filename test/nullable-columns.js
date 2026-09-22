'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function convert(stat, rule = '', schemaScript = '') {
    const result = core.convert({ name: '空值语义', first_mes: '开场', extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schemaScript }] } }, character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(stat) },
        { comment: '变量更新规则', content: rule },
    ] } }, { mode: 'both' });
    return { ...result, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}
const sample = () => ({
    A: { x: null, y: 1.5, z: false, nest: { text: null, num: 0 } },
    Rows: { a: { value: null, other: 1 }, b: { value: '', other: 2 }, c: { other: 3 } },
});

test('nullable VWD：空值、空串、数字、布尔与缺失往返，缺表保持字符串默认', async () => {
    const initial = { A: { x: [null, '说明'], label: '默认字符串' }, Rows: { a: { x: [null, '说明'], n: 1 }, b: { x: [false, '说明'], n: 2 } } };
    const rule = '变量更新规则:\n  Rows:\n    type: |-\n      { [name: string]: { x: any; n: number; } }';
    const { layout, template } = convert(initial, rule);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
    assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data.A, initial.A);
    let before = initial;
    for (const value of ['', 0, false, null, undefined]) {
        const next = structuredClone(before);
        if (value === undefined) { delete next.A.x; delete next.Rows.a.x; }
        else { next.A.x = [value, '说明']; next.Rows.a.x = [value, '说明']; }
        await core.writeStatDiffToDb(applyingApi(template), layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
        before = next;
    }
    const declared = convert({ A: { label: '默认字符串' } }, '', 'const S = z.object({ A: z.object({ label: z.string().nullable() }) }); registerMvuSchema(S);');
    assert.deepStrictEqual(core.statDataFromTables(declared.layout, {}).stat_data.A, { label: '默认字符串' });
});

test('nullable 列：显式 nullable/optional 声明支持首次 null 和缺失，不依赖空值样本', async () => {
    const schema = 'const Schema = z.object({ A: z.object({ x: z.number().nullable(), y: z.string().optional(), nested: z.object({ v: z.boolean().nullish() }) }), Rows: z.record(z.string(), z.object({ value: z.number().nullable(), other: z.number() })) }); registerMvuSchema(Schema);';
    const initial = { A: { x: 3, nested: {} }, Rows: { a: { value: 1, other: 2 } } };
    const { layout, template } = convert(initial, '', schema);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
    assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data.A, initial.A);
    const next = { A: { x: null, y: '', nested: { v: false } }, Rows: { a: { value: null, other: 2 } } };
    await core.writeStatDiffToDb(applyingApi(template), layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

test('nullable 列：旧的非 nullable 列拒绝有损 null，整组 JSON 支持 null', async () => {
    const initial = { A: { x: 3, text: '原值' }, Log: {} };
    const { layout, template } = convert(initial);
    for (const key of ['x', 'text']) {
        const next = structuredClone(initial); next.A[key] = null;
        await core.writeStatDiffToDb(applyingApi(template), layout, initial, next);
        assert.strictEqual(core.lastStatWriteFailed, true);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
    }
    const next = structuredClone(initial); next.Log = null;
    await core.writeStatDiffToDb(applyingApi(template), layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

test('普通文本列：新布局清空字符串后不恢复初始文本，旧布局保留既有 fallback', async () => {
    const initial = { A: { text: '初始文本', other: 1 }, Rows: { a: { text: '初始文本', other: 1 } } };
    const { layout, template } = convert(initial);
    const next = structuredClone(initial); next.A.text = ''; next.Rows.a.text = '';
    await core.writeStatDiffToDb(applyingApi(template), layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
    const legacy = structuredClone(layout);
    for (const entry of legacy) for (const col of entry.cols) if (col[1] === 'textExact') col[1] = 'text';
    assert.strictEqual(core.statDataFromTables(legacy, template).stat_data.A.text, '初始文本');
});

test('nullable 列：初始 null、空字符串、缺失、零与布尔分别往返', () => {
    const stat = sample(), { layout, template, schema } = convert(stat);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, stat);
    assert.strictEqual(schema.find(g => g.name === 'A').columns.find(c => c.zh === 'y').type, 'INTEGER');
    assert.strictEqual(layout.find(l => l.group === 'A').cols.find(c => c[0] === 'x')[1], 'jsonScalarOptional');
    assert.strictEqual(core.statDataFromTables(layout, {}).stat_data.A.x, null, '无表的加载窗口仍使用原始 fallback');
    const text = JSON.stringify(template);
    assert.deepStrictEqual(core.statDataFromTables(layout, JSON.parse(text)).stat_data, stat, '序列化后的表快照保持语义');
});

test('nullable 列：脚本往返有值、null、空字符串、缺失，重复提交无写入', async () => {
    const { layout, template } = convert(sample());
    const api = applyingApi(template);
    let before = core.statDataFromTables(layout, template).stat_data;
    for (const value of ['null', '', 0, false, 1.5, '有值', null, undefined]) {
        const next = structuredClone(before);
        for (const obj of [next.A, next.A.nest, next.Rows.a, next.Rows.b]) {
            const key = obj === next.A ? 'x' : obj === next.A.nest ? 'text' : 'value';
            if (value === undefined) delete obj[key]; else obj[key] = value;
        }
        await core.writeStatDiffToDb(api, layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        const read = core.statDataFromTables(layout, JSON.parse(JSON.stringify(template))).stat_data;
        assert.deepStrictEqual(read, next, String(value));
        assert.strictEqual(await core.writeStatDiffToDb(api, layout, read, read), 0, '重复值不触发写入');
        before = read;
    }
    for (const value of [null, '', false]) {
        const next = structuredClone(before);
        next.Rows.new = { value, other: 4 };
        await core.writeStatDiffToDb(api, layout, before, next);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next, '新行编码与已有行一致');
        before = next;
    }
});

test('nullable 列：嵌套关系行的 null、缺失与后续写入保持独立', async () => {
    const stat = { 关系: { 甲: { 好感: 0, 背包: { 钥匙: { 备注: null }, 钱包: {} } } } };
    const rule = '变量更新规则:\n  关系:\n    type: |-\n      { [名称: string]: { 好感: number; 背包: { [物品: string]: { 备注: string; } }; } }';
    const { layout, template } = convert(stat, rule);
    assert.ok(layout.some(l => l.kind === 'nestedRows'));
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, stat);
    const next = structuredClone(stat);
    next.关系.甲.背包.钥匙.备注 = '';
    next.关系.甲.背包.钱包.备注 = null;
    next.关系.甲.背包.新物品 = { 备注: false };
    await core.writeStatDiffToDb(applyingApi(template), layout, stat, next);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

test('nullable 列：拒绝非标量写入，旧布局不猜测空字符串或 null 文本', async () => {
    const { layout, template } = convert(sample());
    const before = core.statDataFromTables(layout, template).stat_data;
    for (const value of [{ a: 1 }, [1], NaN, Infinity]) {
        const next = structuredClone(before); next.A.x = value;
        await core.writeStatDiffToDb(applyingApi(template), layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, true);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, before);
    }
    const old = [{ kind: 'singleton', group: 'A', table: 'A表', cols: [
        ['x', 'text', '', ['A', 'x']], ['y', 'jsonScalar', 'fallback', ['A', 'y']],
    ] }];
    assert.deepStrictEqual(core.statDataFromTables(old, { sheet_a: { name: 'A表', content: [['row_id', 'x', 'y'], [1, 'null', '']] } }).stat_data,
        { A: { x: 'null', y: 'fallback' } });
});

test('nullable 列：SQLite 默认值与初始行有效，JSON 编码仍执行范围和枚举约束', () => {
    const result = convert({ A: { x: null, choice: null } });
    const group = result.schema.find(g => g.name === 'A');
    group.columns.find(c => c.zh === 'x').range = [0, 10];
    group.columns.find(c => c.zh === 'choice').enum = ['甲', '乙'];
    const sheet = Object.values(core.generateTemplate(result.schema, { mode: 'sqlite' })).find(s => s.name === 'A表');
    assert.match(sheet.sourceData.updateNode, /SET x = '1'/, '可空数值的 SQL 示例使用符合范围的 JSON 数字编码');
    assert.strictEqual((sheet.sourceData.note.match(/按 JSON 标量填值/g) || []).length, 1, '编码提示按表合并');
    const output = require('child_process').spawnSync('python3', ['-c', `
import json, sqlite3, sys
s = json.load(sys.stdin)
db = sqlite3.connect(':memory:')
db.execute(s['sourceData']['ddl'])
table = s['sourceData']['ddl'].split()[2]
for row in s['content'][1:]:
    db.execute('INSERT INTO ' + table + ' VALUES (' + ','.join('?' for _ in row) + ')', row)
db.execute('INSERT INTO ' + table + ' DEFAULT VALUES')
cols = [r[1] for r in db.execute('PRAGMA table_info(' + table + ')')]
for col, valid, invalid in [('x', ['', 'null', '0', '10'], ['-1', '11', '{}', '[0]', 'broken']), ('choice', ['', 'null', '"甲"', '"乙"'], ['"丙"', '{}', 'broken'])]:
    sqlcol = cols[s['content'][0].index(col)]
    for value in valid:
        db.execute('UPDATE ' + table + ' SET ' + sqlcol + ' = ?', (value,))
    for value in invalid:
        try:
            db.execute('UPDATE ' + table + ' SET ' + sqlcol + ' = ?', (value,))
        except sqlite3.DatabaseError:
            continue
        raise AssertionError('Invalid value accepted: ' + col + '=' + value)
print('OK')
`], { input: JSON.stringify(sheet), encoding: 'utf8', timeout: 30000 });
    assert.ifError(output.error);
    assert.strictEqual(output.status, 0, output.stderr);
    assert.strictEqual(output.stdout.trim(), 'OK');
});

'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

const DEFAULT_SCHEMA = `const S = z.object({
      A: z.object({ obj: z.object({ x: z.number() }).nullable(), arr: z.array(z.string()).optional() }),
      Rows: z.record(z.string(), z.object({ obj: z.object({ x: z.number() }).nullable() }))
    }); registerMvuSchema(S);`;

test('可空 JSON 边界：已声明整组与整行 nullable 均无损写入', async () => {
    const schema = 'const S = z.object({ A: z.object({ n: z.number() }).nullable(), Rows: z.record(z.string(), z.object({ n: z.number() }).nullable()) }); registerMvuSchema(S);';
    const initial = { A: { n: 1 }, Rows: { one: { n: 2 } } };
    const result = core.convert({ name: '整组可空边界', first_mes: '', extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schema }] } }, character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(initial) }] } });
    assert.doesNotMatch(result.reportText, /整组\/整行可空容器存储/);
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    let before = initial;
    for (const next of [{ ...initial, Rows: { one: null } }, { ...initial, A: null }]) {
        await core.writeStatDiffToDb(applyingApi(result.template), layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, result.template).stat_data, next);
        before = next;
    }
});

function convert(stat, schema = DEFAULT_SCHEMA, mode = 'both') {
    const result = core.convert({ name: '可空 JSON', first_mes: '', extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schema }] } }, character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] } }, { mode });
    return { template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}

test('可空 JSON 容器：固定对象/数组保持单列，并往返 null、缺失和对象值', async () => {
    const initial = { A: { obj: { x: 1 }, arr: ['a'] }, Rows: { one: { obj: null }, two: { obj: { x: 2 } } } };
    const { layout, template } = convert(initial);
    const a = layout.find(x => x.group === 'A');
    assert.strictEqual(a.cols.find(c => c[0] === 'obj')[1], 'jsonObjectOptional');
    assert.strictEqual(a.cols.find(c => c[0] === 'arr')[1], 'jsonObjectOptional');
    assert.ok(!a.cols.some(c => c[0].startsWith('obj_')));
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
    const api = applyingApi(template);
    let before = initial;
    for (const nextA of [{ obj: null, arr: [] }, {}, { obj: { x: 3 }, arr: ['b'] }]) {
        const next = structuredClone(before); next.A = nextA;
        await core.writeStatDiffToDb(api, layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        const read = core.statDataFromTables(layout, JSON.parse(JSON.stringify(template))).stat_data;
        assert.deepStrictEqual(read, next);
        assert.strictEqual(await core.writeStatDiffToDb(api, layout, read, read), 0);
        before = read;
    }
    const bad = structuredClone(before); bad.A.obj = 1;
    const snapshot = JSON.stringify(template);
    await core.writeStatDiffToDb(api, layout, before, bad);
    assert.strictEqual(core.lastStatWriteFailed, true);
    assert.strictEqual(JSON.stringify(template), snapshot);
});

test('可空 JSON 容器：初始 null/缺失重新转换、缺表 fallback 均不造键', () => {
    for (const initial of [
        { A: { obj: null }, Rows: { one: { obj: null } } },
        { A: {}, Rows: { one: {} } },
    ]) {
        const { layout, template } = convert(initial);
        const a = layout.find(x => x.group === 'A');
        assert.strictEqual(a.cols.find(c => c[0] === 'obj')[1], 'jsonObjectOptional');
        assert.strictEqual(a.cols.find(c => c[0] === 'arr')[1], 'jsonObjectOptional');
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
        const fallback = core.statDataFromTables(layout, {}).stat_data;
        assert.deepStrictEqual(fallback.A, initial.A);
    }
});

test('可空 JSON 容器：record 新旧行对象值彼此独立', async () => {
    const initial = { A: { obj: null }, Rows: { old: { obj: { x: 1 } } } };
    const { layout, template } = convert(initial), api = applyingApi(template);
    const next = structuredClone(initial);
    next.Rows.old.obj = null;
    next.Rows.new = { obj: { x: 2 } };
    await core.writeStatDiffToDb(api, layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

test('可空 JSON 容器：nestedRows 的 optional object 独立写回', async () => {
    const schema = `const S = z.object({ Rel: z.record(z.string(), z.object({ Child: z.record(z.string(), z.object({ bag: z.object({ n: z.number() }).optional() })) })) }); registerMvuSchema(S);`;
    const initial = { Rel: { a: { Child: { first: { bag: { n: 1 } }, second: {} } } } };
    const { layout, template } = convert(initial, schema), api = applyingApi(template);
    assert.ok(layout.some(x => x.kind === 'nestedRows'));
    const next = structuredClone(initial);
    delete next.Rel.a.Child.first.bag;
    next.Rel.a.Child.second.bag = { n: 2 };
    await core.writeStatDiffToDb(api, layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

test('可空 JSON 容器：拒绝错误容器种类和无效嵌套 JSON，原表不变', async () => {
    const initial = { A: { obj: { x: 1 }, arr: ['a'] }, Rows: {} };
    const { layout, template } = convert(initial), api = applyingApi(template);
    for (const mutate of [
        n => { n.A.obj = []; }, n => { n.A.arr = {}; },
        n => { n.A.obj = { x: NaN }; }, n => { n.A.obj = { x: Infinity }; },
        n => { n.A.obj = { x: undefined }; }, n => { n.A.obj = {}; n.A.obj.self = n.A.obj; },
        n => { n.A.obj = { x: new Date() }; }, n => { n.A.obj = { x: new (class Value {})() }; },
        n => { n.A.arr = new Array(2); }, n => { n.A.obj = { toJSON: () => ({ x: 1 }) }; },
    ]) {
        const next = structuredClone(initial); mutate(next);
        const snapshot = JSON.stringify(template);
        await core.writeStatDiffToDb(api, layout, initial, next);
        assert.strictEqual(core.lastStatWriteFailed, true);
        assert.strictEqual(JSON.stringify(template), snapshot);
    }
});

test('可空 JSON 容器：跨 iframe 普通对象可写，新行缺省不复用其他行的值', async () => {
    const initial = { A: { obj: null }, Rows: { old: { obj: { x: 1 } } } };
    const { layout, template } = convert(initial), api = applyingApi(template);
    const next = structuredClone(initial);
    next.A.obj = require('vm').runInNewContext('({ x: 2 })');
    next.Rows.new = {};
    await core.writeStatDiffToDb(api, layout, initial, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, JSON.parse(JSON.stringify(next)));
});

test('可空 JSON 容器：SQLite CHECK 仅允许空、null 与声明容器种类', () => {
    const initial = { A: { obj: { x: 1 }, arr: ['a'] }, Rows: {} };
    const result = core.convert({ name: '可空 JSON', first_mes: '', extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: DEFAULT_SCHEMA }] } }, character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(initial) }] } }, { mode: 'sqlite' });
    const sheet = Object.values(core.generateTemplate(result.schema, { mode: 'sqlite' })).find(s => s.name === 'A表');
    const output = require('child_process').spawnSync('python3', ['-c', `
import json, sqlite3, sys
s=json.load(sys.stdin); db=sqlite3.connect(':memory:'); db.execute(s['sourceData']['ddl'])
t=s['sourceData']['ddl'].split()[2]; h=s['content'][0]; db.execute('INSERT INTO '+t+' VALUES ('+','.join('?' for _ in h)+')', s['content'][1])
for col, good, bad in [('obj', ['', 'null', '{"x":2}'], ['[]', '1', '"x"']), ('arr', ['', 'null', '["x"]'], ['{}', '1', '"x"'])]:
  for v in good: db.execute('UPDATE '+t+' SET '+col+'=?', (v,))
  for v in bad:
    try: db.execute('UPDATE '+t+' SET '+col+'=?', (v,))
    except sqlite3.DatabaseError: continue
    raise AssertionError(col+' accepted '+v)
print('OK')
`], { input: JSON.stringify(sheet), encoding: 'utf8', timeout: 30000 });
    assert.ifError(output.error);
    assert.strictEqual(output.status, 0, output.stderr);
    assert.strictEqual(output.stdout.trim(), 'OK');
});

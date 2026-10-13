'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi, pythonExecutable } = require('./helpers');
const engine = require('../src/schema-execution-node');
const createCardApi = require('../src/card-api');
const z = require('../src/vendor/schema-engine-libs').zod;
const clone = value => JSON.parse(JSON.stringify(value));
test('类型契约：原Zod静态回退输出可存入SQLite，完整JSON仍拒绝其他越界值',async()=>{
    for(const complex of [false,true]){
        const members={枚举:z.enum(['甲','乙']).catch(''),数:z.number().min(0).max(5).catch(-1),整数:z.int().catch(0.5)};
        if(complex)members.列表=z.array(z.number());
        const original=z.object({组:z.object(members)}),first={组:{枚举:'甲',数:2,整数:2,...(complex?{列表:[]}: {})}};
        const after=original.parse({组:{枚举:'错误',数:10,整数:1.25,...(complex?{列表:[]}: {})}});
        const schema='{组:z.object({枚举:z.enum(["甲","乙"]).catch(""),数:z.number().min(0).max(5).catch(-1),整数:z.int().catch(0.5)'+(complex?',列表:z.array(z.number())':'')+'})}';
        const result=core.convert(card(first,schema)),{layout,tables}=state(result),group=result.schema.find(g=>g.name==='组');
        assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables),layout,first,after,tables)).ok,true);
        const sheet=Object.values(tables).find(t=>t?.name===group.tableName),column=group.columns.find(c=>c.zh==='数');
        assert.strictEqual(column.type,'REAL');
        assert.deepStrictEqual(column.outputFallbacks,[-1]);
        const script=`import json,sqlite3,sys
p=json.load(sys.stdin); db=sqlite3.connect(':memory:'); db.execute(p['ddl'])
cols=db.execute('pragma table_info('+p['table']+')').fetchall()
q='insert into '+p['table']+' values ('+','.join('?' for c in cols)+')'
for row in p['rows']: db.execute(q,row)
rejected=False
try: db.execute('update '+p['table']+' set '+p['column']+'=?', (p['invalid'],))
except sqlite3.IntegrityError: rejected=True
print(json.dumps({'rows':db.execute('select * from '+p['table']).fetchall(),'rejected':rejected}))`;
        const invalid=10;
        const out=JSON.parse(require('child_process').execFileSync(pythonExecutable,['-c',script],{encoding:'utf8',timeout:15000,input:JSON.stringify({ddl:sheet.sourceData.ddl,table:group.ident,column:column.ident,invalid,rows:sheet.content.slice(1)})}));
        assert.strictEqual(out.rejected,true);
        sheet.content=[sheet.content[0],...out.rows.map(row=>row.map(v=>typeof v==='number'?String(v):v))];
        assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,after);
        assert(!sheet.sourceData.note.includes('原 Schema 回退值'));
    }
});
function card(initial, schema, rules) {
    return { name: '公开类型契约', character_book: { entries: [
        { comment: '[InitVar]', enabled: false, content: JSON.stringify(initial) },
        ...(rules ? [{ comment: '[mvu_update]变量更新规则', content: rules }] : []),
    ] }, extensions: { tavern_helper: { scripts: schema ? [{ enabled: true, content:
        'import {registerMvuSchema} from "https://example.test/mvu_zod.js";const S=z.object(' + schema + ');registerMvuSchema(S);' }] : [] } } };
}
function state(result) {
    return { layout: JSON.parse(result.card.extensions.mvu2shujuku.layout), tables: clone(result.template) };
}
async function roundTrip(input, before, after) {
    const result = core.convert(input), { layout, tables } = state(result);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, before);
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables), layout, before, after, tables)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, after);
    return result;
}
test('类型契约：初值为整数的 number 小数写读不受初值限制，JSON保留标量类型', async () => {
    for (const schema of [undefined, '{组:z.object({数:z.number(),布尔:z.boolean(),文本:z.string()})}']) {
        const first = { 组: { 数: 0, 布尔: false, 文本: '0001' } }, next = { 组: { 数: -1.25, 布尔: true, 文本: '0002' } };
        const result = await roundTrip(card(first, schema), first, next), group = result.schema.find(g => g.name === '组');
        const column=group.columns.find(c=>c.zh==='数');
        assert.strictEqual(column.type,'REAL');
        assert(group.columns.some(c=>c.zh==='布尔' && c.type==='INTEGER'));
        assert.deepStrictEqual(core.statDataFromTables(...Object.values(state(result))).stat_data,first);
    }
});
test('类型契约：Zod integer 元数据来自实际对象，包装及合并不丢失', () => {
    for (const type of ['z.number().int()', 'z.int()', 'z.int32()', 'z.uint32()', 'z.number().multipleOf(2)']) {
        const source = 'const S=z.object({组:z.object({值:' + type + '.default(2)})});registerMvuSchema(S);';
        assert.strictEqual(engine.inspectSync(source).roots[0].fields.组.fields.值.integer, true, type);
        const result = core.convert(card({ 组: { 值: 2 } }, '{组:z.object({值:' + type + '.default(2)})}'));
        assert.strictEqual(result.schema.find(g => g.name === '组').columns[0].type, 'INTEGER', type);
    }
    assert.strictEqual(engine.inspectSync('const S=z.object({值:z.number().multipleOf(.5)});registerMvuSchema(S);').roots[0].fields.值.integer, false);
});
test('类型契约：YAML number 与显式 integer 按完整路径选择，不串扰同名文本', () => {
    const first = { 数字组: { 值: 0, 整数: 2 }, 文本组: { 值: '0001' } };
    const rules = '数字组:\n  值:\n    type: number\n    range: 0~5\n  整数:\n    type: integer\n文本组:\n  值:\n    type: string';
    const result = core.convert(card(first, undefined, rules));
    const numeric=result.schema.find(g=>g.name==='数字组').columns[0];
    assert.deepStrictEqual(numeric.range,[0,5]);
    assert.equal(numeric.type,'REAL');
    assert.equal(result.schema.find(g=>g.name==='数字组').columns.find(c=>c.zh==='整数').type,'INTEGER');
    assert.strictEqual(result.schema.find(g=>g.name==='文本组').columns[0].type,'TEXT');
    assert.deepStrictEqual(core.statDataFromTables(...Object.values(state(result))).stat_data, first);
});
for (const [label, first, next] of [
    ['数字', [0, 1], [1.25, -2.5, 3]], ['布尔', [true, false], [false, true, false]],
    ['混合', [1, '文字', false, null], [null, '', true, 3.75, { 值: 1 }, [2]]],
    ['对象与标量', [{ 值: 1 }, 2, null], [[3], false, { 值: 4 }]],
    ['空数组', [], [0, false, null, '文字']],
]) test('类型契约：无 Schema 嵌套' + label + '数组保留每项类型及小数', async () => {
    await roundTrip(card({ 组: { 数组: first } }), { 组: { 数组: first } }, { 组: { 数组: next } });
});
test('类型契约：关系数组完整JSON保留元素类型，内部布尔仍是JSON布尔', async () => {
    const first = { 人物: { 甲: { 混合: [1, null, false], 布尔: [true, false] }, 乙: { 混合: ['字'], 布尔: [false] } } };
    const next = { 人物: { 甲: { 混合: [null, '字', {}, 2.75], 布尔: [false, true] }, 乙: { 混合: [false], 布尔: [true] } } };
    const schema = '{人物:z.record(z.string(),z.object({混合:z.array(z.any()),布尔:z.array(z.boolean())}))}';
    const result = await roundTrip(card(first, schema), first, next);
    const group = result.schema.find(g => g.name === '人物');
    assert.equal(group.kind, 'rows');
    const column=group.columns.find(c=>c.zh==='布尔');
    assert(column?.isObject); assert.equal(column.type,'TEXT');
    const sheet=Object.values(result.template).find(s=>s?.name===group.tableName);
    assert.deepStrictEqual(JSON.parse(sheet.content[1][sheet.content[0].indexOf(column.zh)]),first.人物.甲.布尔);
});
test('类型契约：完整JSON不被其他组的同名 number 提示改变物理类型或元素类型', () => {
    const first = { 记录: { 列表: [0, false, null, '0'] } };
    const result = core.convert(card(first, undefined, '其他组:\n  内容:\n    type: number\n    range: 0~5'));
    const column = result.schema.find(g => g.name === '记录').columns[0];
    assert(column); assert.strictEqual(column.type, 'TEXT');
    const { layout, tables } = state(result);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, first);
});
test('类型契约：根值、固定嵌套叶子、根字典和关系字典均使用同一 number 规则', async () => {
    const first = { 根值: 1, 组: { 内层: { 值: 1 }, 字典: { 甲: 1 } }, 字典: { 乙: 1 } };
    const next = { 根值: 1.25, 组: { 内层: { 值: 2.75 }, 字典: { 甲: 3.25 } }, 字典: { 乙: 4.5 } };
    const schema = '{根值:z.number(),组:z.object({内层:z.object({值:z.number()}),字典:z.record(z.string(),z.number())}),字典:z.record(z.string(),z.number())}';
    const result = await roundTrip(card(first, schema), first, next);
    for (const group of result.schema) for (const column of group.columns) if (column.logicalType === 'number') assert.strictEqual(column.type, 'REAL', group.tableName + '.' + column.zh);
});
test('类型契约：任意 transform 输出完整 JSON；0–5 clamp 在原 Schema 验证后写回表格', async () => {
    const source = '{组:z.object({评分:z.coerce.number().transform(v=>_.clamp(v,0,5))})}', result = core.convert(card({ 组: { 评分: 0 } }, source));
    const { layout, tables } = state(result), column = result.schema.find(g => g.name === '组').columns[0];
    assert.strictEqual(column.type, 'TEXT');
    const api = createCardApi({ readMetadata: () => ({ schemaKeys: ['结构'] }), isCurrent: () => true });
    api.registerSchema(z.object({ 组: z.object({ 评分: z.coerce.number().transform(v => Math.max(0, Math.min(v, 5))) }) }), '结构');
    for (const [input, expected] of [[3.75, 3.75], [8.25, 5], [-1.25, 0]]) {
        const before = core.statDataFromTables(layout, tables).stat_data, after = await api.validate({ 组: { 评分: input } });
        assert.strictEqual(after.组.评分, expected);
        assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables), layout, before, after, tables)).ok, true);
        assert.strictEqual(core.statDataFromTables(layout, tables).stat_data.组.评分, expected);
    }
});
test('类型契约：实际 SQLite JSON 数字字符串读回保留小数、整数、布尔、文本及范围', () => {
    const first = { 组: { 数: 1.25, 整数: 2, 布尔: true, 文本: '0001' } }, schema = '{组:z.object({数:z.number().min(0).max(5),整数:z.number().int(),布尔:z.boolean(),文本:z.string()})}';
    const result = core.convert(card(first, schema)), { layout, tables } = state(result), group = result.schema.find(g => g.name === '组');
    const script = `import json, sqlite3, sys
p=json.load(sys.stdin); db=sqlite3.connect(':memory:'); db.execute(p['ddl'])
cols=db.execute('pragma table_info('+p['table']+')').fetchall()
names=','.join('"'+c[1]+'"' for c in cols); q='insert into '+p['table']+' ('+names+') values ('+','.join('?' for c in cols)+')'
for row in p['rows']: db.execute(q,row)
db.execute('update '+p['table']+' set '+p['number']+'=?', (3.75,))
rejected=False
try: db.execute('update '+p['table']+' set '+p['number']+'=?', (6.25,))
except sqlite3.IntegrityError: rejected=True
print(json.dumps({'rows':db.execute('select * from '+p['table']).fetchall(),'rejected':rejected}))`;
    const sheet = Object.values(tables).find(t => t?.name === group.tableName);
    const out = JSON.parse(require('child_process').execFileSync(pythonExecutable, ['-c', script], { encoding: 'utf8', timeout: 15000, input: JSON.stringify({ ddl: sheet.sourceData.ddl, table: group.ident, number: group.columns.find(c=>c.zh==='数').ident, rows: sheet.content.slice(1) }) }));
    assert.strictEqual(out.rejected, true);
    sheet.content = [sheet.content[0], ...out.rows.map(row => row.map(v => typeof v === 'number' ? String(v) : v))];
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, { 组: { 数: 3.75, 整数: 2, 布尔: true, 文本: '0001' } });
});

'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
// Retained physical layouts are tested with frozen public metadata; current conversions use layout-planning.js.
const legacyLayoutFixture = require('./legacy-layout-fixture');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const { spawnSync } = require('child_process');

function card(bag = { "O'Brien": { text: '旧', keep: 7 } }) {
    return { name: 'JSON局部更新公开夹具', first_mes: '',
        extensions: { tavern_helper: { scripts: [{ name: '结构', content: `const S = z.object({ 状态: z.object({
            bag: z.record(z.string(), z.object({text: z.string(), keep: z.number()})).nullable(),
            empty: z.object({ n: z.number() }).nullable()
        }) }); registerMvuSchema(S);` }] } },
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify({ 状态: { bag, empty: null } }) }] },
    };
}
const stateSheet = result => Object.values(result.template).find(s => s.name === '状态表');

test("旧布局：JSON局部更新：停用模式参数统一使用 SQL 路径说明，布局数据不变", () => {
    const results = Object.fromEntries(['native', 'both', 'sqlite'].map(mode => [mode, publishedLayoutFixture(card(), { mode })]));
    for (const mode of ['both', 'sqlite']) {
        const sheet = stateSheet(results[mode]);
        assert.match(sheet.sourceData.note, /对象\/数组优先用 json_set/);
        assert.doesNotMatch(sheet.sourceData.note, /本次要求 SQL 脚本时/);
        assert.match(sheet.sourceData.note, /json_remove/);
        assert.match(sheet.sourceData.note, /json_patch 的 null 会删键/);
        assert.match(sheet.sourceData.note, /空单元格或 JSON null 容器先按规则初始化/);
        assert.doesNotMatch(sheet.sourceData.note, /整列以 JSON 写回/);
        assert.deepStrictEqual(sheet.content, stateSheet(results.native).content);
        assert.strictEqual(sheet.sourceData.ddl, stateSheet(results.native).sourceData.ddl);
        assert.strictEqual((results[mode].card.data || results[mode].card).extensions.mvu2shujuku.layout,
            (results.native.card.data || results.native.card).extensions.mvu2shujuku.layout);
    }
    assert.doesNotMatch(stateSheet(results.both).sourceData.note, /本次要求原生行操作时/);
    assert.match(stateSheet(results.native).sourceData.note, /json_set/);
    assert.match(stateSheet(results.both).sourceData.updateNode, /SQL示例: UPDATE.*json_replace/);
    assert.doesNotMatch(stateSheet(results.both).sourceData.note, /SQL 示例仅在本次输出要求 SQL 脚本时适用/);
    assert.match(stateSheet(results.sqlite).sourceData.updateNode, /json_replace/);
});

test("旧布局：JSON局部更新：生成的 SQL 示例正确转义路径，只替换目标字段并通过原 DDL", () => {
    const result = publishedLayoutFixture(card(), { mode: 'sqlite' }), sheet = stateSheet(result);
    const sql = sheet.sourceData.updateNode.split('\nSQL示例: ')[1];
    assert.match(sql, /O''Brien/);
    const output = spawnSync(require('./helpers').pythonExecutable, ['-c', `
import json, sqlite3, sys
data=json.load(sys.stdin); s=data['sheet']; db=sqlite3.connect(':memory:'); db.execute(s['sourceData']['ddl'])
t=s['sourceData']['ddl'].split()[2]
db.execute('INSERT INTO '+t+' VALUES ('+','.join('?' for _ in s['content'][0])+')', s['content'][1])
db.execute(data['sql'])
print(json.dumps(list(db.execute('SELECT * FROM '+t).fetchone()), ensure_ascii=False))
`], { input: JSON.stringify({ sheet, sql }), encoding: 'utf8', timeout: 30000 });
    assert.ifError(output.error);
    assert.strictEqual(output.status, 0, output.stderr);
    const updated = JSON.parse(output.stdout);
    assert.deepStrictEqual(JSON.parse(updated[sheet.content[0].indexOf('bag')]), { "O'Brien": { text: '新值', keep: 7 } });
    assert.strictEqual(updated[sheet.content[0].indexOf('empty')], 'null');
    sheet.content[1] = updated;
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    assert.deepStrictEqual(core.statDataFromTables(layout, result.template).stat_data.状态.bag,
        { "O'Brien": { text: '新值', keep: 7 } });
});

test("旧布局：JSON局部更新：空容器和无安全公开路径不虚构 SQL 键，也不以空对象覆盖原值", () => {
    for (const bag of [null, {}, { $secret: { text: '私有', keep: 1 } }, { '含"引号': { text: '值', keep: 1 } }]) {
        const sheet = stateSheet(publishedLayoutFixture(card(bag), { mode: 'sqlite' }));
        assert.doesNotMatch(sheet.sourceData.updateNode, /SQL示例:|可写键名|SET .* = '\{\}'/);
        assert.match(sheet.sourceData.note, /仅操作规则允许的路径/);
    }
});

test("旧布局：JSON局部更新：整组 JSON 保留路径守卫，无可写路径不增加 SQL JSON 说明，普通表扩展数据可写", () => {
    const result = publishedLayoutFixture({ name: '整组JSON', first_mes: '', character_book: { entries: [{
        comment: '[InitVar]', content: JSON.stringify({ 自由: {}, 普通: { n: 1 } }),
    }] } });
    const json = result.schema.find(g => g.kind === 'json');
    let templates = core.generateTemplate(result.schema, { mode: 'sqlite' });
    assert.doesNotMatch(Object.values(templates).find(s => s.name === json.tableName).sourceData.note, /json_set/);
    const ordinary = Object.values(templates).find(s => s.name === '普通表');
    assert.match(ordinary.sourceData.note, /扩展数据/);
    assert.match(ordinary.sourceData.note, /json_set/, '可写的扩展数据使用 JSON 局部更新说明');
    json.wildcardRules = [{ path: '自由.<项>.值', checks: ['正文变化时维护'] }];
    templates = core.generateTemplate(result.schema, { mode: 'sqlite' });
    const sheet = Object.values(templates).find(s => s.name === json.tableName);
    assert.doesNotMatch(sheet.sourceData.note, /未列出的字段一律只读/);
    assert.match(sheet.sourceData.note, /原变量规则/);
    assert.match(sheet.sourceData.note, /json_set/);
    assert.doesNotMatch(sheet.sourceData.updateNode, /可写键名|SQL示例/);
});

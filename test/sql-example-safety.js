'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const { spawnSync } = require('child_process');

function card(initial, schema) {
    return { name: 'SQL示例保真', first_mes: '', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(initial) }] },
        extensions: { tavern_helper: { scripts: [{ name: '结构', content: `const S=${schema};registerMvuSchema(S);` }] } } };
}
function execute(sheet, kind) {
    const sql = sheet.sourceData[kind].split('\nSQL示例: ')[1];
    assert.ok(sql, kind + ' 应保留可执行示例');
    assert.match(sheet.sourceData[kind], /不得直接照抄示例值/);
    const result = spawnSync('python3', ['-c', `
import json,sqlite3,sys
x=json.load(sys.stdin);s=x['sheet'];db=sqlite3.connect(':memory:')
db.execute(s['sourceData']['ddl']);t=s['sourceData']['ddl'].split()[2]
for row in s['content'][1:]:
 db.execute('INSERT INTO '+t+' VALUES ('+','.join('?' for _ in row)+')',row)
db.execute(x['sql'])
print(json.dumps([list(row) for row in db.execute('SELECT * FROM '+t)],ensure_ascii=False))
`], { input: JSON.stringify({ sheet, sql }), encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('SQL示例保真：UPDATE 实际执行遵守枚举、范围、布尔和可空编码', () => {
    for (const [initial, schema, expected] of [
        ['开始', 'z.enum(["开始","结束"])', '结束'],
        ['普通', 'z.enum(["普通","O\'Brien"])', "O'Brien"],
        [10, 'z.number().min(0).max(10)', 9],
        [true, 'z.boolean()', 0],
        [1.5, 'z.number()', 2.5],
        [null, 'z.number().min(2).max(3).nullable()', '2'],
        [null, 'z.enum(["开始","结束"]).nullable()', '"开始"'],
        [null, 'z.string().nullable()', 'null'],
    ]) {
        const result = core.convert(card({ 状态: { 值: initial } }, `z.object({状态:z.object({值:${schema}})})`), { mode: 'sqlite' });
        const sheet = Object.values(result.template).find(s => s.name === '状态表');
        const rows = execute(sheet, 'updateNode');
        assert.strictEqual(rows[0][sheet.content[0].indexOf('值')], expected, schema);
        assert.ok(!sheet.sourceData.updateNode.includes('kuozhanshuju ='), '不示范写隐藏列');
    }
});

test('SQL示例保真：数组插入和更新的 JSON 编码维持元素类型', () => {
    for (const [initial, schema, expected] of [
        [[null, 2], 'z.number().nullable()', 3],
        [[false, true], 'z.boolean()', true],
        [['旧文本'], 'z.string()', '新值'],
        [[null], 'z.number().nullable()', null],
    ]) {
        const result = core.convert(card({ 列表: initial }, `z.object({列表:z.array(${schema})})`), { mode: 'sqlite' });
        const sheet = Object.values(result.template).find(s => s.name === '列表表');
        assert.match(sheet.sourceData.note, /单元格保存完整 JSON 值/);
        for (const kind of ['updateNode', 'insertNode']) {
            const rows = execute(sheet, kind);
            const row = kind === 'insertNode' ? rows.at(-1) : rows[0];
            assert.deepStrictEqual(JSON.parse(row[1]), expected);
            if (kind === 'updateNode' && initial.length > 1) assert.deepStrictEqual(JSON.parse(rows[1][1]), initial[1], '保留其他行');
        }
    }
});

test('SQL示例保真：多层关联数组示例填写全部关联字段并完整定位', () => {
    // 直接验证生成器支持的布局契约，不依赖某张卡恰好如何推导数组。
    const col = (zh, ident, type = 'TEXT', value = '') => ({ zh, ident, type, value, path: [] });
    const group = { name: '标签', tableName: '人物_物品_标签表', ident: 'tags', kind: 'nestedArray',
        parentTable: '人物_物品表', parentKeyCol: '物品',
        ancestorKeyCols: [{ col: '人物', parentTable: '人物表', parentKeyCol: '姓名' }, { col: '物品', parentTable: '人物_物品表', parentKeyCol: '名称' }],
        columns: [col('人物', 'owner'), col('物品', 'item'), col('内容', 'value')], rows: [[1, '甲', '药', '旧']],
    };
    const sheet = Object.values(core.generateTemplate([group], { mode: 'sqlite' })).find(s => s.sourceData);
    assert.match(sheet.sourceData.insertNode, /所有关联字段「人物」、「物品」/);
    const rows = execute(sheet, 'insertNode');
    assert.deepStrictEqual(rows.at(-1).slice(1), ['甲', '药', '新值']);
    for (const kind of ['updateNode', 'deleteNode']) {
        assert.match(sheet.sourceData[kind], /WHERE owner = '甲' AND item = '药' AND row_id = 1/);
        execute(sheet, kind);
    }
});

test('SQL示例保真：空行表 INSERT 的默认值符合枚举和数值范围', () => {
    const group = { name: '记录', tableName: '记录表', ident: 'records', kind: 'rows', keyCol: '名称', rows: [],
        columns: [
            { zh: '名称', ident: 'name', type: 'TEXT', value: '', path: [] },
            { zh: '阶段', ident: 'stage', type: 'TEXT', value: '', enum: ['开始', '结束'], path: [] },
            { zh: '计数', ident: 'count', type: 'INTEGER', value: '', range: [2, 5], path: [] },
            { zh: '启用', ident: 'enabled', type: 'INTEGER', logicalType: 'boolean', value: false, path: [] },
        ],
    };
    const sheet = Object.values(core.generateTemplate([group], { mode: 'sqlite' })).find(s => s.sourceData);
    assert.deepStrictEqual(execute(sheet, 'insertNode')[0].slice(2), ['开始', 2, 0]);
});

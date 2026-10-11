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
    assert.doesNotMatch(sheet.sourceData.note, /SQL 示例仅在本次输出要求/);
    const result = spawnSync(require('./helpers').pythonExecutable, ['-c', `
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

test('SQL示例保真：双模式与 SQLite 的 UPDATE 实际执行遵守枚举、范围、布尔和可空编码', () => {
    for (const mode of ['both', 'sqlite']) for (const [initial, schema, expected] of [
        ['开始', 'z.enum(["开始","结束"])', '结束'],
        ['普通', 'z.enum(["普通","O\'Brien"])', "O'Brien"],
        [10, 'z.number().min(0).max(10)', 9],
        [true, 'z.boolean()', 0],
        [1.5, 'z.number()', 2.5],
        [null, 'z.number().min(2).max(3).nullable()', '2'],
        [null, 'z.enum(["开始","结束"]).nullable()', '"开始"'],
        [null, 'z.string().nullable()', 'null'],
    ]) {
        const result = core.convert(card({ 状态: { 值: initial } }, `z.object({状态:z.object({值:${schema}})})`), { mode });
        const sheet = Object.values(result.template).find(s => s.name === '状态表');
        const rows = execute(sheet, 'updateNode');
        assert.strictEqual(rows[0][sheet.content[0].indexOf('值')], expected, schema);
        assert.ok(!sheet.sourceData.updateNode.includes('kuozhanshuju ='), '不示范写隐藏列');
    }
});

test('旧布局SQL示例保真：数组插入和更新的 JSON 编码维持元素类型', () => {
    for (const [initial, schema, expected] of [
        [[null, 2], 'z.number().nullable()', 3],
        [[false, true], 'z.boolean()', true],
        [['旧文本'], 'z.string()', '新值'],
        [[null], 'z.number().nullable()', null],
    ]) {
        const result = require('./legacy-layout-fixture')(card({ 列表: initial }, `z.object({列表:z.array(${schema})})`), { mode: 'sqlite' });
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

test('SQL示例保真：空行表 INSERT 的短示例符合枚举和数值范围', () => {
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

test('SQL示例保真：长初值只存在数据行，新增示例按类型生成且可执行', () => {
    const marker = 'PUBLIC_PAYLOAD_MARKER_' + 'x'.repeat(200);
    for (const mode of ['both', 'sqlite']) {
        const result = core.convert(card({ 记录: { 甲: marker } },
            'z.object({记录:z.record(z.string(),z.string().nullable())})'), { mode });
        const sheet = Object.values(result.template).find(s => s.name === '记录表');
        assert.ok(sheet.content.some(row => row.some(value => String(value).includes(marker))), '真实初值保存在数据行');
        assert.ok(!Object.values(sheet.sourceData).some(value => String(value).includes(marker)), 'DDL、说明和示例均不重复初值');
        const header = sheet.content[0];
        assert.strictEqual(execute(sheet, 'insertNode').at(-1)[header.indexOf('内容')], 'null', '按实际物理值列读取合法 JSON null');
    }
});

// 按宿主字符串替换插入实际产品 SQL，再由 SQLite 验证值和约束，不能只查源模板。
test('SQL宿主边界：可空枚举 DDL、默认值与操作示例经过字符串替换后仍可执行', () => {
    const { DatabaseSync } = require('node:sqlite');
    const values = ["$'", '$&', '$`', '$$', '末尾$', "O'Brien"];
    const schema = 'z.object({状态:z.object({评分:z.number().min(0).max(5).nullable(),称号:z.enum(' + JSON.stringify(values) + ').nullable(),标记:z.string()})})';
    const result = core.convert(card({ 状态: { 评分: null, 称号: null, 标记: '末尾$' } }, schema), { mode: 'sqlite' });
    const sheet = Object.values(result.template).find(sheet => sheet.name === '状态表');
    const group = result.schema.find(group => group.tableName === sheet.name);
    const inject = sql => {
        const inserted = '头部\n$0\n尾部'.replace('$0', sql);
        assert.strictEqual(inserted, '头部\n' + sql + '\n尾部', '生成 SQL 必须逐字插入宿主提示');
        return inserted.slice(3, -3);
    };
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(inject(sheet.sourceData.ddl));
        db.exec('INSERT INTO ' + group.ident + ' DEFAULT VALUES');
        const ident = label => group.columns.find(column => column.zh === label).ident;
        assert.strictEqual(db.prepare('SELECT ' + ident('标记') + ' FROM ' + group.ident).get()[ident('标记')], '末尾$');
        for (const value of values) {
            db.prepare('UPDATE ' + group.ident + ' SET ' + ident('称号') + ' = ?').run(JSON.stringify(value));
            assert.strictEqual(JSON.parse(db.prepare('SELECT ' + ident('称号') + ' FROM ' + group.ident).get()[ident('称号')]), value);
        }
        assert.throws(() => db.prepare('UPDATE ' + group.ident + ' SET ' + ident('称号') + ' = ?').run('"非法"'), /CHECK/);
        db.prepare('UPDATE ' + group.ident + ' SET ' + ident('评分') + ' = ?').run('2.5');
        assert.throws(() => db.prepare('UPDATE ' + group.ident + ' SET ' + ident('评分') + ' = ?').run('5.1'), /CHECK/);
        const sql = sheet.sourceData.updateNode.split('\nSQL示例: ')[1];
        assert.ok(sql);
        db.exec(inject(sql));
    } finally { db.close(); }
});

test('SQL宿主边界：记录键与 JSON 叶路径含美元替换标记时示例保持原值', () => {
    const { DatabaseSync } = require('node:sqlite');
    for (const marker of ["$'", '$&', '$`', '$$', '末尾$']) {
        const key = '记录' + marker;
        const result = core.convert(card({ 记录: { [key]: { 字段: marker, 数量: 1 } } },
            'z.object({记录:z.record(z.string(),z.object({字段:z.string(),数量:z.number()}))})'), { mode: 'sqlite' });
        const sheet = Object.values(result.template).find(sheet => sheet.name === '记录表');
        const group = result.schema.find(group => group.tableName === sheet.name);
        const db = new DatabaseSync(':memory:');
        try {
            const insert = sql => { assert.strictEqual('头$0尾'.replace('$0', sql), '头' + sql + '尾'); return sql; };
            db.exec(insert(sheet.sourceData.ddl));
            const rows = sheet.content.slice(1);
            const bind = db.prepare('INSERT INTO ' + group.ident + ' VALUES (' + rows[0].map(() => '?').join(',') + ')');
            rows.forEach(row => bind.run(...row));
            for (const kind of ['updateNode', 'deleteNode']) {
                const sql = sheet.sourceData[kind].split('\nSQL示例: ')[1];
                assert.ok(sql);
                db.exec(insert(sql));
            }
            assert.strictEqual(db.prepare('SELECT count(*) AS n FROM ' + group.ident).get().n, 0);
        } finally { db.close(); }
    }
});

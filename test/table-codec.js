'use strict';
const vm = require('vm');
const createTableCodec = require('../src/table-codec');
const { test } = require('./runner');
const { core, assert, fs, path, bridgeSandbox } = require('./helpers');
const plain = value => JSON.parse(JSON.stringify(value));
const codec = createTableCodec(require('../src/vendor/mvu-yaml-libs').jsonrepair);

const scalarLayout = [{ kind: 'singleton', group: '状态', table: '状态表', cols: [
    ['数值', 'number', 7, ['状态', '数值']], ['开关', 'boolean', true, ['状态', '开关']],
    ['对象', 'object', {}, ['状态', '对象']], ['描述值', 'pair', '默认', ['状态', '描述值'], true, '说明'],
] }];
const scalarTables = { sheet_status: { name: '状态表', content: [
    ['row_id', '数值', '开关', '对象', '描述值'], [1, '12.5', 'false', '{"层":2}', '正文'],
] } };

test('共用编解码：独立模块还原列类型，display_data 与 stat_data 分离', () => {
    const result = codec.statDataFromTables(scalarLayout, scalarTables);
    assert.deepStrictEqual(result.stat_data, { 状态: { 数值: 12.5, 开关: false, 对象: { 层: 2 }, 描述值: ['正文', '说明'] } });
    result.display_data.状态.对象.层 = 9;
    assert.strictEqual(result.stat_data.状态.对象.层, 2);
    assert.deepStrictEqual(core.statDataFromTables(scalarLayout, scalarTables).stat_data, result.stat_data);
});

test('共用编解码：JSON 修复能力由调用方提供，无修复器也能读取合法 JSON', () => {
    assert.deepStrictEqual(codec.parseObject("{key:'value',}"), { key: 'value' });
    const strict = createTableCodec();
    assert.deepStrictEqual(strict.parseObject('{"key":1}'), { key: 1 });
    assert.deepStrictEqual(strict.parseObject('invalid'), {});
    assert.strictEqual(strict.convertCell('jsonScalar', 'null'), null);
    assert.strictEqual(strict.convertCell('jsonScalar', 'false'), false);
    assert.deepStrictEqual(createTableCodec(() => { throw new Error('模拟修复失败'); }).parseObject('invalid'), {});
});

test('共用编解码：工厂可在无 require、window 的隔离环境直接内联', () => {
    const inlineFactory = vm.runInNewContext('(' + createTableCodec.toString() + ')');
    assert.deepStrictEqual(plain(inlineFactory().statDataFromTables(scalarLayout, scalarTables)), codec.statDataFromTables(scalarLayout, scalarTables));
});

test('共用编解码：空表骨架、seedRows 和同名表首次匹配语义保持', () => {
    assert.deepStrictEqual(codec.statDataFromTables(scalarLayout, {}).stat_data.状态, { 数值: 7, 开关: true, 对象: {}, 描述值: ['默认', '说明'] });
    const table = scalarTables.sheet_status;
    const tables = { unrelated: { name: table.name, content: table.content }, sheet_first: {
        name: table.name, content: [table.content[0]], seedRows: [table.content[1]],
    }, sheet_duplicate: table };
    const projected = codec.statDataFromTables(scalarLayout, tables);
    assert.strictEqual(projected.stat_data.状态.数值, 7, '只读首个匹配表的 content，不能把 seedRows 或后续重名表当真值');
});

test('共用编解码：关系子表及嵌套数组只归入存在的父记录', () => {
    const layout = [
        { kind: 'rows', group: '人物', table: '人物表', keyCol: '键', cols: [['名字', 'text', '']], writePaths: [['人物']] },
        { kind: 'nestedRows', group: '人物', table: '物品表', parentKeyCol: '所属', keyCol: '键', childKey: '物品', cols: [['数量', 'number', 0]], writePaths: [['人物', '*', '物品']] },
        { kind: 'nestedArray', group: '人物', table: '标签表', parentKeyCol: '所属', valueCol: '内容', path: ['人物', '*', '标签'], cols: [['内容', 'jsonScalar', '']] },
    ];
    const tables = {
        sheet_people: { name: '人物表', content: [['row_id', '键', '名字'], [1, 'A', '甲'], [2, 'B', '乙']] },
        sheet_items: { name: '物品表', content: [['row_id', '所属', '键', '数量'], [1, 'A', '剑', '2'], [2, 'missing', '刀', '3']] },
        sheet_tags: { name: '标签表', content: [['row_id', '所属', '内容'], [1, 'A', 'false'], [2, 'A', '"001"'], [3, 'missing', 'true']] },
    };
    assert.deepStrictEqual(codec.statDataFromTables(layout, tables).stat_data, { 人物: {
        A: { 名字: '甲', 物品: { 剑: { 数量: 2 } }, 标签: [false, '001'] },
        B: { 名字: '乙', 物品: {}, 标签: [] },
    } });
});

test('共用编解码：实际生成的旧桥与扩展投影一致，回放空表也一致', () => {
    const input = { name: '共用投影测试', first_mes: '你好', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 状态: { 生命: 100, 开关: true }, 列表: [null, false, 0, '', { a: 1 }, [1, 2, 3]], 秘闻: { $meta: { extensible: true }, 第一条: '正文', 第二条: '另一条' } }) },
    ] } };
    const converted = core.convert(input);
    const { win, tables } = bridgeSandbox(converted, { extra: { setTimeout() { return 0; }, clearTimeout() {} } });
    const layout = JSON.parse((converted.card.data || converted.card).extensions.mvu2shujuku.layout);
    assert.deepStrictEqual(plain(win.getAllVariables()), core.statDataFromTables(layout, tables));
    for (const table of Object.values(tables)) if (table && table.content) table.content = [table.content[0]];
    assert.deepStrictEqual(plain(win.getAllVariables()), core.statDataFromTables(layout, tables));
});

test('共用编解码：生成扩展内联模块，无 Node 模块加载器也能投影', () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '../src/mvu2shujuku.js'), 'utf8');
    const index = core.assembleExtension({ coreSource })['index.js'];
    const ui = index.lastIndexOf('\n// ============================================================\n// MVU转数据库 · SillyTavern 原生扩展 UI');
    assert.ok(ui > 0);
    const sandbox = vm.createContext({ console });
    vm.runInContext(index.slice(0, ui), sandbox);
    assert.strictEqual(typeof sandbox.require, 'undefined');
    assert.deepStrictEqual(plain(sandbox.MVU2SHUJUKU_CORE.statDataFromTables(scalarLayout, scalarTables)), codec.statDataFromTables(scalarLayout, scalarTables));
});

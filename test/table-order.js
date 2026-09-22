'use strict';

const { test } = require('./runner');
const { core, assert } = require('./helpers');

function group(name, tableName, ident, extra = {}) {
    return {
        name,
        tableName,
        ident,
        kind: 'singleton',
        keyCol: '键名',
        keyValue: name,
        columns: [{ zh: '值', path: [name, '值'], value: '', desc: '', type: 'TEXT', ident: 'zhi' }],
        rows: [[1, name]],
        childTables: [],
        source: 'initvar',
        reminders: [],
        ...extra,
    };
}

function sheetNames(template) {
    return Object.values(template).filter(sheet => sheet && sheet.uid).map(sheet => sheet.name);
}

test('表格归组：同层数组子表按逻辑父组连续排列，且不改 schema/layout 投影', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '表格归组卡', description: '', first_mes: '你好',
            character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify({
                A: { x: 1, bag: [1, 2, 3] },
                B: { x: 1, bag: [4, 5, 6] },
            }) }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const converted = core.convert(card, { mode: 'both' });
    const names = sheetNames(converted.template);
    assert.deepStrictEqual(names, ['A表', 'A_bag表', 'B表', 'B_bag表']);
    assert.deepStrictEqual(converted.schema.map(g => g.tableName), ['A表', 'B表', 'A_bag表', 'B_bag表'], 'schema 原有顺序不能被模板排版改写');
    const layout = JSON.parse((converted.card.data || converted.card).extensions.mvu2shujuku.layout);
    const tables = Object.fromEntries(Object.entries(converted.template).filter(([uid]) => uid.startsWith('sheet_')));
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, {
        A: { x: 1, bag: [1, 2, 3] },
        B: { x: 1, bag: [4, 5, 6] },
    }, '模板排序不得影响 layout 或表格反投影');
});

test('表格归组：精确 parentTable/childTables 形成稳定祖孙 DFS，不按表名前缀猜测', () => {
    const schema = [
        group('A', 'A', 'a', { childTables: [{ tableName: 'A_bag' }] }),
        group('B', 'B', 'b', { childTables: [{ tableName: 'B_bag' }] }),
        group('bag', 'A_bag', 'a_bag', {
            parentTable: 'A', parentKeyCol: 'A_键名',
            writePaths: [['A', '*', 'bag']], childTables: [{ tableName: 'A_bag_effect' }], source: 'child-table',
        }),
        group('bag', 'B_bag', 'b_bag', {
            parentTable: 'B', parentKeyCol: 'B_键名',
            writePaths: [['B', '*', 'bag']], source: 'child-table',
        }),
        group('effect', 'A_bag_effect', 'a_bag_effect', {
            parentTable: 'A_bag', parentKeyCol: 'bag_键名',
            writePaths: [['A', '*', 'bag', '*', 'effect']], source: 'child-table',
        }),
        // 名称看似 A 的子表，却没有 parentTable、childTables 或逻辑路径证据。
        group('独立', 'A_almost_child', 'a_almost_child', { source: 'manual' }),
    ];
    const before = schema.map(item => ({
        tableName: item.tableName,
        ident: item.ident,
        rows: JSON.parse(JSON.stringify(item.rows)),
        childTables: JSON.parse(JSON.stringify(item.childTables)),
        writePaths: JSON.parse(JSON.stringify(item.writePaths || [])),
    }));
    const template = core.generateTemplate(schema, { mode: 'both' });
    assert.deepStrictEqual(sheetNames(template), ['A', 'A_bag', 'A_bag_effect', 'B', 'B_bag', 'A_almost_child']);
    assert.deepStrictEqual(schema.map(item => ({
        tableName: item.tableName,
        ident: item.ident,
        rows: item.rows,
        childTables: item.childTables,
        writePaths: item.writePaths || [],
    })), before, '生成排序不得就地改写 schema 的顺序、结构路径或行内容');
    for (const item of schema) {
        const sheet = template['sheet_' + item.ident];
        assert.strictEqual(sheet.uid, 'sheet_' + item.ident, '排序不得改变 UID');
        assert.deepStrictEqual(sheet.content.slice(1), [[1, item.name]], '排序不得改变行内容');
    }
});

test('表格归组：缺少显式父表元数据时按完整逻辑路径归组', () => {
    const schema = [
        group('甲', '任意物理名', 'jia', { writePaths: [['甲']] }),
        group('乙', '甲_名字相近但无关', 'yi', { writePaths: [['乙']] }),
        group('背包', '完全不同的表名', 'bag', { writePaths: [['甲', '背包']], source: 'manual' }),
    ];
    assert.deepStrictEqual(sheetNames(core.generateTemplate(schema)), ['任意物理名', '完全不同的表名', '甲_名字相近但无关']);
});

test('表格归组：路径父表歧义时稳定保留原顺序', () => {
    const schema = [
        group('甲', '甲一', 'jia_one', { writePaths: [['共享']] }),
        group('乙', '甲二', 'jia_two', { writePaths: [['共享']] }),
        group('子', '子表', 'child', { writePaths: [['共享', '子']], source: 'manual' }),
    ];
    assert.deepStrictEqual(sheetNames(core.generateTemplate(schema)), ['甲一', '甲二', '子表']);
});

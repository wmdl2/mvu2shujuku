'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function convert(stat, rules, extra = []) {
    const card = { name: '有限字段声明', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(stat) },
        { comment: '[mvu_update]变量更新规则', content: rules },
        ...extra,
    ] } };
    const result = core.convert(card, { targetSpVersion: '9.2.5' });
    return { ...result, layout: JSON.parse(result.card.extensions.mvu2shujuku.layout) };
}

test('有限绑定：同节点枚举占位符保持固定字段身份、初始化及差异写回', async () => {
    const stat = { 面板: { 阶级: 2, 气力: { 当前: 3, 上限: { _基础: 5, 加成: 1 } }, 精力: { 当前: 4, 上限: { _基础: 6, 加成: 2 } }, 标签: [] } };
    const rules = '变量更新规则:\n  面板:\n    ${池}:\n      池: 气力 | 精力\n      type: "{ 当前: number; 上限: { _基础: number; 加成: number } }"\n      check:\n        - 当前不得超过上限\n    标签:\n      type: Array<string>\n';
    const r = convert(stat, rules), group = r.schema.find(g => g.name === '面板');
    assert.strictEqual(group.kind, 'singleton');
    assert.strictEqual(group.rows.length, 1);
    assert.ok(!group.columns.some(c => ['当前', '池'].includes(c.zh)));
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    const next = structuredClone(stat); next.面板.气力.当前 = 2; next.面板.标签 = ['新', '旧'];
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
    assert.ok(Object.values(r.template).some(t => t.sourceData?.note?.includes('当前不得超过上限')));
});

test('有限绑定：点路径展开且绑定说明不成为业务子字段', () => {
    const stat = { 面板: { 属性: { 灵巧: 1, 坚韧: 2 } } };
    const rules = '变量更新规则:\n  面板.属性.${维度}:\n    维度: [灵巧, 坚韧]\n    check:\n      - 变更须有依据\n';
    const r = convert(stat, rules), si = core.parseMvuShapes({ character_book: { entries: [{ comment: '[mvu_update]变量更新规则', content: rules }] } });
    assert.ok(![...si.wildcardFields].some(p => p.endsWith('.维度')));
    assert.ok(!si.dynamicPaths.has('面板.属性'));
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    assert.ok(Object.values(r.template).some(t => t.sourceData?.note?.includes('变更须有依据')));
});

test('有限绑定：固定同形字段声明不猜成字典行，简单对象类型不提升子字段', () => {
    const stat = { 面板: { 气力: { 当前: 1 }, 精力: { 当前: 2 } } };
    const r = convert(stat, '变量更新规则:\n  面板:\n    ${气力|精力}:\n      type: "{ 当前: number }"\n');
    assert.strictEqual(r.schema.find(g => g.name === '面板').kind, 'singleton');
    assert.deepStrictEqual(r.schema.find(g => g.name === '面板').columns.filter(c => c.zh !== '_扩展数据').map(c => c.zh), ['气力_当前', '精力_当前']);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
});

test('有限绑定：未绑定占位符及显式开放元数据仍是动态记录', () => {
    const rules = '变量更新规则:\n  面板:\n    ${条目}:\n      type: "{ 当前: number }"\n';
    const r = convert({ 面板: { A: { 当前: 1 }, B: { 当前: 2 } } }, rules);
    assert.strictEqual(r.schema.find(g => g.name === '面板').kind, 'rows');
    const open = convert({ 面板: { $meta: { extensible: true }, 气力: { 当前: 1 } } }, '变量更新规则:\n  面板:\n    ${气力|精力}:\n      type: "{ 当前: number }"\n');
    assert.strictEqual(open.schema.find(g => g.name === '面板').kind, 'rows');
});

test('有限绑定：嵌套字典保留声明路径，不在父组生成同名字典；数组不误读为pair', async () => {
    const stat = { 面板: { 登记: { A: { 标签: ['甲', '乙'], 明细: { x: { 值: 1 } } } }, 明细: { 值: 7 }, 固定: { 标签: ['丙', '丁'] } } };
    const rules = '变量更新规则:\n  面板:\n    登记:\n      type: "{ [ID: string]: { 标签: string[]; 明细: { [条目: string]: { 值: number } } } }"\n    固定:\n      标签:\n        type: Array<string>\n';
    const r = convert(stat, rules);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    const next = structuredClone(stat);
    next.面板.登记.B = { 标签: ['戊', '己'], 明细: { x: { 值: 2 } } };
    next.面板.登记.A.明细.x.值 = 3;
    next.面板.固定.标签 = ['庚', '辛'];
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
});

test('有限绑定：记录值本身是开放字典或数组时整值存储，不补造描述字段', async () => {
    const stat = { 面板: { 资料: {}, 列表: {} } };
    const r = convert(stat, '变量更新规则:\n  面板:\n    资料:\n      type: "{ [ID: string]: { [属性: string]: string } }"\n    列表:\n      type: "{ [ID: string]: string[] }"\n');
    const next = { 面板: { 资料: { A: { first: '一', second: '二' }, B: {} }, 列表: { A: ['甲', '乙'], B: [] } } };
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
    const final = { 面板: { 资料: { A: { second: '三', third: '四' } }, 列表: { A: ['丙', '丁'] } } };
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, next, final)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, final);
});

test('有限绑定：已声明字段优先于旧前端fallback，不补空字段挡住回退读取', async () => {
    const stat = { 名单: {} };
    const r = convert(stat, '变量更新规则:\n  名单:\n    type: "{ [ID: string]: { 分数: number } }"', [
        { comment: '旧前端', enabled: false, content: '<% const value = getvar("stat_data.名单.甲.旧分数") ?? getvar("stat_data.名单.甲.分数"); %>' },
    ]);
    assert.ok(!r.schema.find(g=>g.name==='名单').columns.some(c=>c.zh==='旧分数'));
    const next = { 名单: { 甲: { 分数: 4 } } };
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
    const added = { 名单: { 甲: { 分数: 4, 旧分数: 2 } } };
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, next, added)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, added);
});

test('有限绑定：初始化字典及多层关系的物理行号独立连续，不按列数生成', () => {
    const card = require('./prompt-guidance-card')();
    const r = core.convert(card), layout = JSON.parse(r.card.data.extensions.mvu2shujuku.layout);
    for (const group of r.schema) assert.deepStrictEqual(group.rows.map(row=>row[0]), group.rows.map((_,i)=>i+1), group.tableName + ' schema');
    for (const table of Object.values(r.template)) if (table.content) {
        assert.deepStrictEqual(table.content.slice(1).map(row=>row[0]), table.content.slice(1).map((_,i)=>i+1), table.name);
    }
    const original = core.analyzeMvuInitMetadata(core.parseInitVar(card.data.character_book.entries[0].content)).data;
    assert.deepStrictEqual(core.statDataFromTables(layout, r.template).stat_data, original);
});

test('有限绑定：业务ID与行号别名改名并同步身份引用，逻辑路径不变', async () => {
    const stat = { 名单: { 甲: { ID: '甲编号', 行号: 7, 背包: { 同名: { 值: 1 } } } } };
    const r = convert(stat, '变量更新规则:\n  名单:\n    type: "{ [ID: string]: { ID: string; 行号: number; 背包: { [rowid: string]: { 值: number } } } }"');
    for (const table of Object.values(r.template)) if (table.content) assert.ok(!table.content[0].slice(1).some(name=>['id','rowid','row-id','row_id','行号'].includes(name.toLowerCase())));
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    const next = structuredClone(stat); next.名单.乙 = { ID: '乙编号', 行号: 8, 背包: { 同名: { 值: 2 } } }; next.名单.甲.背包.同名.值 = 3;
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
});

'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function input(stat, source, rules = '') {
    return { name: '声明路径回归', first_mes: '',
        character_book: { entries: [
            { comment: '[InitVar]', content: JSON.stringify(stat) },
            ...(rules ? [{ comment: '[mvu_update]变量更新规则', content: rules }] : []),
        ] },
        extensions: { tavern_helper: { scripts: [{ name: '结构', content: `const S=${source};registerMvuSchema(S);` }] } },
    };
}
function converted(card) {
    const r = core.convert(card, { targetSpVersion: '9.2.5' });
    return { ...r, layout: JSON.parse(r.card.extensions.mvu2shujuku.layout) };
}
const account = 'z.object({标题:z.string(),计数:z.number(),留言:z.record(z.string().describe("作者ID"),z.string().describe("留言正文"))})';

test('声明路径：顶层固定同形对象采用单例，固定身份不混入字典行列', async () => {
    const stat = { 频道: { 甲: { 标题: '甲文', 计数: 2, 留言: {} }, 乙: { 标题: '乙文', 计数: 3, 留言: {} } } };
    const r = converted(input(stat, `z.object({频道:z.object({甲:${account},乙:${account}})})`));
    const g = r.schema.find(g => g.name === '频道');
    assert.strictEqual(g.kind, 'singleton');
    assert.strictEqual(g.rows.length, 1);
    assert.deepStrictEqual(g.columns.filter(c => c.zh !== '_扩展数据').map(c => c.zh), ['甲_标题', '甲_计数', '乙_标题', '乙_计数']);
    assert.strictEqual(r.schema.filter(g => g.name === '留言').length, 2);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    const next = structuredClone(stat);
    next.频道.甲.计数 = 7;
    next.频道.甲.留言.同名 = '甲回复'; next.频道.乙.留言.同名 = '乙回复';
    const result = await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
});

test('声明路径：深层空记录从完整声明取键名、标量类型、对象字段与范围', async () => {
    const stat = { 数据: { 容器: { 积分: {}, 文本: {}, 库存: {} } } };
    const source = 'z.object({数据:z.object({容器:z.object({积分:z.record(z.string().describe("项目ID"),z.number().min(0).max(5)),文本:z.record(z.string().describe("文档ID"),z.string().describe("正文")),库存:z.record(z.string().describe("货号"),z.object({数量:z.number(),描述:z.string()}))})})})';
    const r = converted(input(stat, source));
    const scores = r.schema.find(g => g.name === '积分'), texts = r.schema.find(g => g.name === '文本'), stock = r.schema.find(g => g.name === '库存');
    assert.strictEqual(scores.keyCol, '项目ID');
    assert.strictEqual(scores.scalarValueCol, '数值');
    assert.deepStrictEqual(scores.columns.find(c => c.zh === '数值').range, [0, 5]);
    assert.strictEqual(texts.scalarValueCol, '描述');
    assert.strictEqual(texts.columns.find(c => c.zh === '描述').desc, '正文');
    assert.strictEqual(stock.keyCol, '货号');
    assert.strictEqual(stock.columns.find(c => c.zh === '数量').type, 'REAL');
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, stat);
    const next = { 数据: { 容器: { 积分: { A: 4 }, 文本: { B: '内容' }, 库存: { C: { 数量: 2, 描述: '物品' } } } } };
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, stat, next)).ok, true);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
    const updated = structuredClone(next);
    updated.数据.容器.积分.A = 5; updated.数据.容器.库存.C.数量 = 3;
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(r.template), r.layout, next, updated)).ok, true);
    // SQLite 的数值单元格也可能以字符串形式导出。
    for (const sheet of Object.values(r.template)) if (sheet.content) {
        for (const row of sheet.content.slice(1)) for (let i = 1; i < row.length; i++) if (typeof row[i] === 'number') row[i] = String(row[i]);
    }
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, updated);
});

test('声明路径：混合文字键、展平容器与固定对象下字典的集合规则均保留', () => {
    const stat = { 管理: { NPC记录: {}, 当前详情: { 文本: '' }, 固定: { 甲: { 标题: '', 计数: 0, 留言: {} } } } };
    const source = `z.object({管理:z.object({NPC记录:z.record(z.string(),z.string()),当前详情:z.object({文本:z.string()}),固定:z.object({甲:${account}})})})`;
    const rules = '变量更新规则:\n  管理:\n    NPC记录:\n      type: "{ [ID: string]: string }"\n      check:\n        - 仅在登记时增加记录\n    当前详情:\n      type: "{ 文本: string }"\n      check:\n        - 完成后清空详情\n  管理.固定.${甲|乙}.留言:\n    check:\n      - 留言按时间更新\n';
    const r = converted(input(stat, source, rules));
    const note = name => Object.values(r.template).find(t => t.name === name).sourceData.note;
    assert.ok(note('管理_NPC记录表').includes('仅在登记时增加记录'));
    assert.ok(note('管理表').includes('完成后清空详情'));
    assert.ok(note('管理_固定_甲_留言表').includes('留言按时间更新'));
    assert.ok(!r.card.character_book.entries.some(e => e.comment === '[mvu_update]变量更新规则'));
});

test('声明路径：无法定位的业务规则保留原条目，不能凭 YAML 可解析而删除', () => {
    const rules = '变量更新规则:\n  _独立约定:\n    check:\n      - 更新前先核对场景\n  状态:\n    数量:\n      check:\n        - 随交易更新\n';
    const r = converted(input({ 状态: { 数量: 1, 备注: '更新前先核对场景' } }, 'z.object({状态:z.object({数量:z.number(),备注:z.string()})})', rules));
    assert.ok(r.card.character_book.entries.some(e => e.content.includes('更新前先核对场景')));
    assert.ok(r.reportText.includes('保留原条目'));
});

test('声明路径：显式 MVU 开放元数据优先于固定 Zod 对象推导', () => {
    const stat = { 字典: { $meta: { extensible: true }, 甲: { 值: 1 } } };
    const r = converted(input(stat, 'z.object({字典:z.object({甲:z.object({值:z.number()})})})'));
    assert.strictEqual(r.schema.find(g => g.name === '字典').kind, 'rows');
});

test('声明路径：嵌套 MVU 固定元数据优先于 Zod record 推导', () => {
    const stat = { 面板: { 容器: { $meta: { extensible: false, required: ['甲'] }, 甲: { 值: 1 } } } };
    const r = converted(input(stat, 'z.object({面板:z.object({容器:z.record(z.string(),z.object({值:z.number()}))})})'));
    assert.strictEqual(r.schema.length, 1);
    assert.strictEqual(r.schema[0].kind, 'singleton');
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, { 面板: { 容器: { 甲: { 值: 1 } } } });
});

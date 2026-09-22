'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
const initial = {
    状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null],
    档案: { 数量: [3, '数量说明'], 记录: { 甲: { 分数: 2, 历史: [{ 值: null }] }, 乙: { 分数: 4, 历史: [] } },
        对象说明: [{ 开关: false, 备注: {} }, '对象的说明'] },
    列表: [['甲', '说明'], { 开关: [false, '开关说明'] }, [], null],
};
function source() {
    const card = require('./synthetic-card')();
    card.data.name = '完整JSON容器验收';
    card.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(initial);
    card.data.character_book.entries.push({ comment: '变量更新规则', content: `变量更新规则:
  档案:
    数量:
      range: 0~10
      check: 完成任务后才能增加数量
    记录:
      type: '{ [姓名: string]: { 分数: number; 历史: any[]; } }'
      check: 保留每个人的完整记录
` });
    return card;
}
function fixture(options = {}) {
    const result = core.convert(source(), { jsonContainers: true, vwdDescriptions: true, ...options });
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    return { result, layout, template: result.template };
}
test('完整JSON容器：合并子表且原始类型、对象 pair、数组说明无损，无额外状态列', () => {
    for (const mode of ['native', 'sqlite', 'both']) {
        const { result, layout, template } = fixture({ mode });
        assert.strictEqual(layout.length, Object.keys(initial).length);
        assert.ok(layout.every(e => e.kind === 'singleton' && e.valueCol === '内容' && e.cols.length === 1 && !e.vwd));
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
        assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data, initial);
        assert.ok(result.reportText.includes('完整 JSON 容器'));
    }
});
test('完整JSON容器：未声明可空的对象、数组在有值/null/空/缺失之间往返', async () => {
    const { layout, template } = fixture(), api = applyingApi(template);
    let before = clone(initial);
    const stable = { 状态: initial.状态, 背包: initial.背包 };
    for (const values of [{ 档案: null, 列表: null }, { 档案: {}, 列表: [] }, {},
        { 档案: { 记录: { 甲: null, 乙: {} }, 对象说明: [{ 新键: [] }, '更新对象说明'] }, 列表: [[true, '新说明'], {}] }]) {
        const next = { ...stable, ...values };
        await core.writeStatDiffToDb(api, layout, before, next, template);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, clone(template)).stat_data, next);
        assert.strictEqual(await core.writeStatDiffToDb(api, layout, next, next, template), 0);
        before = next;
    }
});
test('完整JSON容器：真实候选工厂保留动态记录/数组元素说明，不需要 EJS 说明覆盖入口', async () => {
    const { layout, template } = fixture(), snapshot = clone(template), next = clone(initial);
    next.档案.数量 = [6, '新的数量说明'];
    next.档案.记录.甲 = null;
    next.档案.记录.乙.称呼 = ['乙', '新字段说明'];
    next.档案.对象说明[1] = '';
    next.列表[1].开关 = [true, '新的开关说明'];
    delete next.背包;
    const factory = require('vm').runInNewContext('(' + require('../src/extension-runtime').createCandidateBuilder.toString() + ')');
    const candidate = await factory({ core }).buildUpdatedTemplateFromStat(layout, initial, next, template);
    assert.ok(candidate);
    assert.deepStrictEqual(core.statDataFromTables(layout, candidate).stat_data, next);
    assert.deepStrictEqual(template, snapshot);
});
test('完整JSON容器：保留原业务规则与 SQL 路径指导，旧关联表定位说明不混入', () => {
    const { template } = fixture();
    const sheet = Object.values(template).find(s => s.name === '档案表');
    assert.match(sheet.sourceData.note, /完成任务后才能增加数量/);
    assert.match(sheet.sourceData.note, /保留每个人的完整记录/);
    assert.match(sheet.sourceData.note, /json_set/);
    assert.match(sheet.sourceData.note, /内容/);
    assert.doesNotMatch(sheet.sourceData.note, /说明覆盖|父键|祖先键|FOREIGN KEY/);
    assert.doesNotMatch(sheet.sourceData.note, /数量说明|对象的说明/);
    assert.ok(JSON.parse(sheet.content[1][1]).档案 === undefined, '单元格就是容器本身，不重复包一层组名');
});
test('完整JSON容器：允许选定组，默认转换及明确关闭保持既有布局', () => {
    const card = source(), legacy = core.convert(card), off = core.convert(card, { jsonContainers: false });
    assert.deepStrictEqual(off.template, legacy.template);
    const { layout, template } = fixture({ jsonContainers: ['档案', '列表'] });
    assert.strictEqual(layout.find(e => e.group === '状态').valueCol, '');
    assert.strictEqual(layout.find(e => e.group === '背包').kind, 'array');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, initial);
});
test('完整JSON容器：刷新切换模式重建模板，普通刷新继续复用已有转换', () => {
    const before = core.convert(source());
    assert.strictEqual(core.refreshConversion(before, { jsonContainers: false }), before);
    const merged = core.refreshConversion(before, { jsonContainers: true });
    const layout = JSON.parse((merged.card.data || merged.card).extensions.mvu2shujuku.layout);
    assert.ok(Object.values(merged.template).filter(s => s.content).every(s => s.content[0].join(',') === 'row_id,内容'));
    assert.deepStrictEqual(core.statDataFromTables(layout, merged.template).stat_data, initial);
    assert.strictEqual(core.refreshConversion(merged), merged);
    const restored = core.refreshConversion(merged, { jsonContainers: false });
    assert.deepStrictEqual(restored.template, before.template);
});
test('完整JSON容器：大 JSON 初值只在数据行保存，DDL 默认不复制数据，既有完整列也适用', () => {
    const card = source();
    const value = { 数据: Array.from({ length: 200 }, (_, i) => ({ 索引: i, 文本: '仅在初始数据出现-' + i })) };
    card.data.character_book.entries[0].content = JSON.stringify(value);
    card.data.first_mes = '';
    for (const declared of [false, true]) {
        if (declared) card.data.extensions.tavern_helper.scripts.push({ name: '结构', content: 'registerMvuSchema(z.object({ 数据: z.array(z.any()).nullish() }));' });
        const r = core.convert(card, { jsonContainers: true });
        const layout = JSON.parse((r.card.data || r.card).extensions.mvu2shujuku.layout);
        const sheet = Object.values(r.template).find(s => s.name === '数据表');
        assert.match(sheet.sourceData.ddl, /DEFAULT ''/);
        assert.doesNotMatch(sheet.sourceData.ddl, /仅在初始数据出现/);
        assert.deepStrictEqual(core.statDataFromTables(layout, r.template).stat_data, value);
        assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data, value);
    }
});
test('完整JSON容器：SQLite 数字 pair 约束针对数组第零项，局部更新与空状态均可执行', () => {
    const { template } = fixture({ mode: 'sqlite' }), sheet = Object.values(template).find(s => s.name === '档案表');
    const cp = require('child_process').spawnSync('python3', ['-c', `
import json,sqlite3,sys
s=json.load(sys.stdin); db=sqlite3.connect(':memory:'); ddl=s['sourceData']['ddl']; db.execute(ddl)
t=ddl.split()[2]; col=ddl.splitlines()[2].strip().split()[0]
db.execute('INSERT INTO '+t+' VALUES (?,?)',s['content'][1])
db.execute('UPDATE '+t+' SET '+col+'=json_set('+col+',?,?)',('$."数量"[0]',6))
assert json.loads(db.execute('SELECT '+col+' FROM '+t).fetchone()[0])['数量']==[6,'数量说明']
try: db.execute('UPDATE '+t+' SET '+col+'=json_set('+col+',?,?)',('$."数量"[0]',11))
except sqlite3.DatabaseError: pass
else: raise AssertionError('range check did not apply to pair value')
for value in ['null','{}','']:
 db.execute('UPDATE '+t+' SET '+col+'=?',(value,))
 assert db.execute('SELECT '+col+' FROM '+t).fetchone()[0]==value
db.execute('DELETE FROM '+t); db.execute('INSERT INTO '+t+' DEFAULT VALUES')
assert db.execute('SELECT '+col+' FROM '+t).fetchone()[0]==''
print('OK')
`], { input: JSON.stringify(sheet), encoding: 'utf8', timeout: 30000 });
    assert.ifError(cp.error);
    assert.strictEqual(cp.status, 0, cp.stderr);
    assert.strictEqual(cp.stdout.trim(), 'OK');
});
module.exports = { initial, source, fixture };

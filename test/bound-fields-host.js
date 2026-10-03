'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
const initial = () => ({ 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 面板: {
    气力: { 当前: 3 }, 精力: { 当前: 4 }, 固定: { 标签: ['甲', '乙'] },
    登记: { A: { 明细: { x: { 值: 1 } }, 标签: ['丙', '丁'] } }, 资料: {},
} });
function source() {
    const card = require('./synthetic-card')(), stat = initial();
    card.data.name = '声明字段与完整路径验收';
    card.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\n开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(stat);
    card.data.character_book.entries.push({ id: 3, comment: '[mvu_update]变量更新规则', enabled: true, constant: true, content:
        '变量更新规则:\n  面板:\n    ${池}:\n      池: 气力 | 精力\n      type: "{ 当前: number }"\n    固定:\n      标签:\n        type: Array<string>\n    登记:\n      type: "{ [ID: string]: { 明细: { [K: string]: { 值: number } }; 标签: string[] } }"\n    资料:\n      type: "{ [ID: string]: { [属性: string]: string } }"\n' });
    return card;
}
function preflight() {
    const r = core.convert(source(), { mode: 'both' });
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.data.extensions.mvu2shujuku.layout), r.template).stat_data, initial());
    return { tables: r.schema.length };
}
module.exports = async function boundFieldsHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record }) {
    preflight();
    for (const mode of ['sqlite', 'native']) {
        await setStorageMode(page, mode);
        const state = await runtimeTest(page, source(), core, mode);
        await assertStorageMode(page, mode, '声明路径');
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.面板), initial().面板);
        const next = initial().面板;
        next.气力.当前 = 2; next.固定.标签 = ['戊', '己'];
        next.登记.A.明细.x.值 = 7;
        next.登记.B = { 明细: { x: { 值: 8 } }, 标签: ['庚', '辛'] };
        next.资料 = { A: { 任意: '值一' }, B: { 另一个: '值二' } };
        assert.strictEqual(await page.evaluate(async panel => { const data = window.Mvu.getMvuData(); data.stat_data.面板 = panel; return window.Mvu.replaceMvuData(data); }, next), true);
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.面板), next);
        record('declared-fields-write', { rows: 2, fixedArray: 2, fullRecord: 2 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.TavernHelper && window.MVU2SHUJUKU_CORE, {}, { timeout: 90000 });
        await openState(page, state); await waitCommittedGold(page, 37); await assertStorageMode(page, mode, '声明路径重载');
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.面板), next);
        record('declared-fields-reload', { mode });
        delete next.登记.A; delete next.资料.B;
        assert.strictEqual(await page.evaluate(async panel => { const data = window.Mvu.getMvuData(); data.stat_data.面板 = panel; return window.Mvu.replaceMvuData(data); }, next), true);
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.面板), next);
        record('declared-fields-delete', { remaining: 1 });
    }
    await setStorageMode(page, 'native');
};
module.exports.preflight = preflight;

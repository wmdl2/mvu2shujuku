'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
const initial = () => ({ 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 数值记录: {}, 布尔记录: {}, 可空记录: {}, 关系: {} });
function source() {
    const card = require('./synthetic-card')(), stat = initial();
    card.data.name = '通用字面键与标量契约验收';
    card.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\n开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(stat);
    card.data.extensions.tavern_helper.scripts.push({ type: 'script', name: '变量结构', enabled: true, content:
        'const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number()}),数值记录:z.record(z.string(),z.number()),布尔记录:z.record(z.string(),z.boolean()),可空记录:z.record(z.string(),z.string().nullable()),关系:z.record(z.string(),z.object({值:z.number(),子:z.record(z.string(),z.object({值:z.number()}))}))});registerMvuSchema(Schema);' });
    return card;
}
function preflight() {
    const r = core.convert(source(), { mode: 'both' });
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.data.extensions.mvu2shujuku.layout), r.template).stat_data, initial());
    assert.strictEqual(initial().背包.length, 4, '共享runtimeTest要求四项背包初值');
    return { tables: r.schema.length };
}
module.exports = async function converterContractHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record }) {
    preflight();
    for (const mode of ['sqlite', 'native']) {
        await setStorageMode(page, mode);
        const state = await runtimeTest(page, source(), core, mode);
        await assertStorageMode(page, mode, '通用转换契约');
        const next = initial(); next.状态.金币 = 37;
        next.数值记录 = { 保留: 1, '甲.乙': 2.5, '': 3, constructor: 4 };
        next.布尔记录 = { 保留: true, '甲.乙': false, '': true };
        next.可空记录 = Object.fromEntries([['保留', '保留'], ['__proto__', null], ['', '文本']]);
        next.关系 = { 保留: { 值: 1, 子: {} }, '甲.乙': { 值: 2, 子: { '': { 值: 3 } } } };
        const write = async value => {
            // Playwright 对对象参数/结果的反序列化会丢掉 __proto__；JSON 文本是夹具传输边界。
            assert.strictEqual(await page.evaluate(async json => {
                const stat = JSON.parse(json);
                const data = window.Mvu.getMvuData(); data.stat_data = stat; return window.Mvu.replaceMvuData(data);
            }, JSON.stringify(value)), true);
            assert.deepStrictEqual(JSON.parse(await page.evaluate(() => JSON.stringify(window.Mvu.getMvuData().stat_data))), value);
        };
        await write(next); record('contract-insert', { mode, keyForms: ['dot', 'empty', 'prototype', 'constructor'] });
        next.布尔记录['甲.乙'] = true; next.布尔记录[''] = false;
        next.数值记录['甲.乙'] = 7.5; next.可空记录.__proto__ = '原型字面值'; next.关系['甲.乙'].子[''].值 = 8;
        await write(next); record('contract-update', { mode });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.TavernHelper && window.MVU2SHUJUKU_CORE, {}, { timeout: 90000 });
        await openState(page, state); await waitCommittedGold(page, 37); await assertStorageMode(page, mode, '通用契约重载');
        assert.deepStrictEqual(JSON.parse(await page.evaluate(() => JSON.stringify(window.Mvu.getMvuData().stat_data))), next);
        record('contract-reload', { mode });
        const restored = initial(); restored.状态.金币 = 37;
        // 完整清空 rows 组仍遵循旧的“未加载空组保护”；此处验证明确删除具体记录。
        restored.数值记录 = { 保留: 1 }; restored.布尔记录 = { 保留: true }; restored.可空记录 = { 保留: '保留' };
        restored.关系 = { 保留: { 值: 1, 子: {} } };
        await write(restored); record('contract-delete', { mode });
    }
    await setStorageMode(page, 'native');
};
module.exports.preflight = preflight;

'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
const sample = require('./nullable-records');
function hostSource(mode) {
    const card = require('./synthetic-card')(), stat = sample.initial();
    stat.状态.生命 = 100; stat.状态.金币 = 10; stat.背包 = ['钥匙', 0, false, null];
    card.data.name = '可空记录验收-' + mode;
    card.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\n开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(stat);
    card.data.character_book.entries.push(sample.source().character_book.entries[1]);
    card.data.extensions.tavern_helper.scripts.push(...sample.source().extensions.tavern_helper.scripts);
    return card;
}
function preflight() {
    const source = hostSource('preflight'), result = core.convert(source, { mode: 'both', installMvuShim: true });
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const stat = core.statDataFromTables(layout, result.template).stat_data;
    assert.strictEqual(stat.状态.金币, 10); assert.strictEqual(stat.背包.length, 4);
    assert.deepStrictEqual(stat.角色, sample.initial().角色);
    assert.strictEqual(layout.filter(e => e.scalarValueCol).length, 5);
    return { tableCount: layout.length, nullableRecordTables: 5, gold: 10, bagLength: 4 };
}
module.exports = async function nullableRecordHost(h) {
    preflight();
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record } = h;
    for (const mode of ['sqlite', 'native']) {
        await setStorageMode(page, mode);
        const state = await runtimeTest(page, hostSource(mode), core, mode);
        await assertStorageMode(page, mode, '可空记录初始');
        const read = () => page.evaluate(() => {
            const s = window.Mvu.getMvuData().stat_data;
            return { 记录: s.记录, 列表记录: s.列表记录, 角色: s.角色, 状态: s.状态 };
        });
        const baseline = await read();
        const target = await page.evaluate(async () => {
            const i = window.SillyTavern.getContext().chat.length;
            await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '更新可空记录。' }]);
            return i;
        });
        for (const value of [null, {}, undefined, { 数量: 4, 文本: '新值', 明细: { 保留: 2 } }]) {
            const expected = structuredClone(baseline);
            for (const dict of [expected.记录, expected.状态.记录, expected.角色.甲.背包, expected.角色.甲.藏库.同名.效果]) {
                if (value === undefined) delete dict.同名; else dict.同名 = value;
            }
            if (value === undefined) delete expected.列表记录.空值;
            else expected.列表记录.空值 = value === null ? null : [];
            assert.strictEqual(await page.evaluate(async expected => {
                const next = window.Mvu.getMvuData(); Object.assign(next.stat_data, expected);
                return window.Mvu.replaceMvuData(next);
            }, expected), true);
            assert.deepStrictEqual(await read(), expected, '成功后立即读回');
            await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state);
            await waitCommittedGold(page, 37); await assertStorageMode(page, mode, '可空记录刷新');
            assert.deepStrictEqual(await read(), expected, '刷新后读回');
        }
        record('nullable-record-' + mode + '-states', { states: 4, refreshed: true, immediateRead: true, ancestorIdentity: true });
        await page.evaluate(index => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut ' + index + '-' + (window.SillyTavern.getContext().chat.length - 1)), target);
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.角色?.甲?.背包?.同名 === null);
        assert.deepStrictEqual(await read(), baseline);
        record('nullable-record-' + mode + '-rollback');
    }
    await setStorageMode(page, 'native');
};
module.exports.preflight = preflight;

module.exports.source = hostSource;

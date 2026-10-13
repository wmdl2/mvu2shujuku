'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../src/mvu2shujuku');

module.exports = async function messageHistoryHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record, work } = h;
    await setStorageMode(page, 'sqlite');
    const source = require('./synthetic-card')(), result = core.convert(source);
    const reuse = process.env.MVU_HISTORY_REUSE_STATE === '1';
    const state = reuse ? JSON.parse(fs.readFileSync(path.join(work, 'state.json'))) : await runtimeTest(page, source, core, 'message-history');
    if (reuse) {
        await openState(page, state);
        await page.waitForFunction(() => {
            try { return [44.25,44.5].includes(window.Mvu?.getMvuData().stat_data.状态.金币); } catch (_) { return false; }
        });
    }
    await assertStorageMode(page, 'sqlite', '历史只读接口真实SQLite');
    await page.waitForFunction(() => typeof window.AutoCardUpdaterAPI?.exportTableSnapshotsAtMessages === 'function');
    if (reuse && process.env.MVU_HISTORY_RECHECK_WRITES === '1') {
        for (const gold of [44.5, 44.25]) {
            const ok = await page.evaluate(async gold => {
                const snapshot = window.Mvu.getMvuData(); snapshot.stat_data.状态.金币 = gold;
                return await window.Mvu.replaceMvuData(snapshot);
            }, gold);
            assert.equal(ok, true, '最终构建当前回复批次试写');
            await waitCommittedGold(page,gold);
        }
    }
    const group = result.schema.find(item => item.name === '状态');
    const column = group.columns.find(item => item.zh === (group.valueCol || '金币'));
    assert(column, '从实际布局取金币列');
    const change = async value => {
        const expression = group.valueCol ? `json_set("${column.ident}",'$."金币"',${value})` : String(value);
        const sql = `UPDATE "${group.ident}" SET "${column.ident}"=${expression} WHERE row_id=1`;
        const response = await page.evaluate(sql => window.AutoCardUpdaterAPI.executeSqlMutation(sql), sql);
        assert(response && !response.errors?.length && response.success !== false, JSON.stringify(response));
        await page.waitForFunction(value => window.Mvu.getMvuData().stat_data.状态.金币 === value, value);
    };
    const addFloor = async () => page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        ctx.chat.push({ is_user: true, name: '用户', mes: '推进一轮。' },
            { is_user: false, name: '角色', mes: '公开历史测试。', swipe_id: 0 });
        await ctx.saveChat();
    });
    if (!reuse) { await change(12.5); await addFloor(); await change(22.75); await addFloor(); await change(44.25); }
    const bindHelper = async () => {
        // Use the actual public TH function as an author's global binding, then
        // wait for the product's normal window-discovery hook to take it over.
        await page.evaluate(() => { window.getChatMessages = window.TavernHelper.getChatMessages.bind(window.TavernHelper); });
        await page.waitForFunction(() => window.getChatMessages?.__mvu2shujuku === true);
    };
    await bindHelper();
    const inspect = async () => page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext(), api = window.AutoCardUpdaterAPI;
        const snapshots = await api.exportTableSnapshotsAtMessages([0, 2]);
        if (!snapshots.success) throw new Error(JSON.stringify(snapshots));
        const before = JSON.stringify(api.exportTableAsJson());
        const ejsValues = [];
        for (const message_id of [0, 2]) {
            const context = await window.EjsTemplate.prepareContext({ message_id, runType: 'render' }, message_id);
            ejsValues.push(await window.EjsTemplate.evalTemplate('<%= getvar("stat_data.状态.金币") %>', context));
        }
        const values = [0, 2].map(message_id => ({
            th: window.getVariables({ type: 'message', message_id }).stat_data.状态.金币,
            mvu: window.Mvu.getMvuData({ type: 'message', message_id }).stat_data.状态.金币,
        }));
        const messageValues = window.getChatMessages('0-2').filter(item => [0, 2].includes(item.message_id))
            .map(item => item.data.stat_data.状态.金币);
        const variables = ctx.chat[0].variables ||= [];
        const carrier = variables[Number(ctx.chat[0].swipe_id || 0)] ||= {};
        carrier.stat_data ||= {};
        carrier.stat_data['$历史脚本测试'] = '甲';
        const scriptBefore = window.Mvu.getMvuData({ message_id: 0 }).stat_data['$历史脚本测试'];
        delete carrier.stat_data['$历史脚本测试'];
        const scriptRemoved = !Object.hasOwn(window.Mvu.getMvuData({ message_id: 0 }).stat_data, '$历史脚本测试');
        return { values, ejsValues, messageValues, scriptBefore, scriptRemoved, current: window.Mvu.getMvuData().stat_data.状态.金币,
            unchanged: JSON.stringify(api.exportTableAsJson()) === before,
            kinds: ctx.chat.flatMap(message => {
                let isolated = message.TavernDB_ACU_IsolatedData;
                if (typeof isolated === 'string') isolated = JSON.parse(isolated);
                return Object.values(isolated || {}).flatMap(tag => (tag.storageFrame?.logEntries || [])
                    .flatMap(entry => (entry.operations || []).map(operation => operation.kind)));
            }) };
    });
    const check = value => {
        assert.deepStrictEqual(value.values, [{ th: 12.5, mvu: 12.5 }, { th: 22.75, mvu: 22.75 }]);
        assert.deepStrictEqual(value.ejsValues.map(Number), [12.5, 22.75]);
        assert.deepStrictEqual(value.messageValues, [12.5, 22.75]);
        assert.equal(value.scriptBefore, '甲'); assert(value.scriptRemoved);
        assert.equal(value.current, 44.25); assert(value.unchanged); assert(value.kinds.includes('sql_sheet_batch'));
    };
    const first = await inspect(); check(first);
    await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state);
    await page.waitForFunction(() => {
        try { return window.Mvu?.getMvuData().stat_data.状态.金币 === 44.25; } catch (_) { return false; }
    });
    await bindHelper();
    const restored = await inspect(); check(restored);
    record('message-history-sql-readonly', { first, restored });
};

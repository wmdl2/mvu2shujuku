'use strict';
// 定向诊断：比较普通 MVU 写入、SP 手动 CRUD 和消息更新实际归属的楼层。
// 只通过 real-host.js --only=rollback 显式运行；不启用动态 VWD，不修改真实聊天。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
module.exports = async function rollbackProbe(h) {
    const { page, runtimeTest, vwdCard, setStorageMode, assertStorageMode, openState,
        waitCommittedGold, replaceMvuDataWhenIdle, record, work, runId } = h;
    const evidence = [];
    const read = () => page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        const data = window.Mvu.getMvuData().stat_data;
        return { chatId: ctx.chatId, gold: data.状态.金币, pair: data.好感系统.乙称呼, bag: data.背包,
            messages: ctx.chat.map((m, index) => ({ index, isUser: !!m.is_user, frame: m.TavernDB_ACU_IsolatedData || null })) };
    });
    const summary = data => ({ gold: data.gold, pair: data.pair, bag: data.bag,
        frames: data.messages.filter(m => m.frame).map(m => ({ index: m.index,
            sha256: crypto.createHash('sha256').update(JSON.stringify(m.frame)).digest('hex') })) });
    const modes = (process.argv.find(a => a.startsWith('--rollback-modes='))?.split('=')[1] || 'native,sqlite').split(',');
    const cases = (process.argv.find(a => a.startsWith('--rollback-cases='))?.split('=')[1] || 'mvu-no-frame,sp-no-frame,mvu-with-frame,mvu-array,message,mvu-batch').split(',');
    assert.ok(modes.every(m => ['native', 'sqlite'].includes(m)));
    assert.ok(cases.every(c => ['mvu-no-frame', 'sp-no-frame', 'mvu-with-frame', 'mvu-array', 'message', 'mvu-batch'].includes(c)));
    for (const mode of modes) {
        await setStorageMode(page, mode);
        const state = await runtimeTest(page, vwdCard(), undefined, mode);
        await assertStorageMode(page, mode, '回退诊断初始模式');
        for (const kind of cases) {
            await openState(page, state);
            const chat = '回退诊断-' + mode + '-' + kind + '-' + Date.now();
            await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
            await waitCommittedGold(page, 10);
            const initial = await read();
            await page.evaluate(() => window.TavernHelper.createChatMessages([
                { role: 'user', message: '继续测试。' }, { role: 'assistant', message: '普通回复，没有填表操作。' },
            ]));
            await page.waitForFunction(() => window.SillyTavern.getContext().chat.length === 3);
            await waitCommittedGold(page, 10);
            const existingFrame = kind === 'mvu-with-frame' || kind === 'mvu-batch';
            if (existingFrame) {
                assert.strictEqual(await page.evaluate(() => window.AutoCardUpdaterAPI.importTableAsJson(
                    JSON.stringify(window.AutoCardUpdaterAPI.exportTableAsJson()))), true);
                await page.waitForFunction(() => !!window.SillyTavern.getContext().chat[2]?.TavernDB_ACU_IsolatedData);
            }
            const before = await read();
            assert.deepStrictEqual(before.messages.filter(m => m.frame).map(m => m.index),
                existingFrame ? [0, 2] : [0], '必须先确认新回复有没有表格记录');
            await page.evaluate(() => {
                const api = window.AutoCardUpdaterAPI;
                window.__rollbackCalls = [];
                for (const method of ['importTableAsJson', 'updateCell', 'updateRow', 'insertRow', 'deleteRow']) {
                    const original = api[method];
                    if (typeof original !== 'function') continue;
                    api[method] = function (...args) { window.__rollbackCalls.push(method); return original.apply(this, args); };
                }
            });
            let rejectedCalls;
            if (kind === 'mvu-batch') {
                // 让真实宿主在入口拒绝导入，验证不能先写一部分 CRUD 再尝试提交。
                const rejected = await page.evaluate(async () => {
                    const api = window.AutoCardUpdaterAPI, original = api.importTableAsJson;
                    api.importTableAsJson = () => original.call(api, '{invalid batch json');
                    try {
                        const data = window.Mvu.getMvuData();
                        data.stat_data.状态.金币 = 42; data.stat_data.背包.push('批次药品');
                        return await window.Mvu.replaceMvuData(data);
                    } finally { api.importTableAsJson = original; }
                });
                assert.strictEqual(rejected, false);
                await waitCommittedGold(page, 10);
                const afterRejected = await read();
                assert.deepStrictEqual(afterRejected, before, '提交被拒绝时值与历史帧均不应改变');
                rejectedCalls = await page.evaluate(() => window.__rollbackCalls.splice(0));
                assert.ok(rejectedCalls.length && rejectedCalls.every(method => method === 'importTableAsJson'));
            }
            if (kind === 'sp-no-frame') {
                assert.strictEqual(await page.evaluate(() => window.AutoCardUpdaterAPI.updateCell('状态表', 1, '金币', 42)), true);
            } else if (kind === 'message') {
                // 用新回复触发真实消息入口；setChatMessages 是编辑操作，不能代替收到回复。
                await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 2'));
                await waitCommittedGold(page, 10);
                await page.evaluate(() => window.TavernHelper.createChatMessages([
                    { role: 'assistant', message: '消息更新。<UpdateVariable>_.set("状态.金币",42);</UpdateVariable>' },
                ]));
            } else {
                const mutate = kind === 'mvu-batch' ? () => {
                    const data = window.Mvu.getMvuData();
                    data.stat_data.状态.金币 = 42; data.stat_data.背包.push('批次药品');
                    return window.Mvu.replaceMvuData(data);
                } : kind === 'mvu-array' ? () => {
                    const data = window.Mvu.getMvuData();
                    data.stat_data.状态.金币 = 42;
                    data.stat_data.背包 = ['更新物品', { n: 1 }, true];
                    return window.Mvu.replaceMvuData(data);
                } : () => {
                    const data = window.Mvu.getMvuData();
                    data.stat_data.状态.金币 = 42;
                    data.stat_data.好感系统.乙称呼 = ['小乙二', '当前称呼'];
                    return window.Mvu.replaceMvuData(data);
                };
                assert.strictEqual(await replaceMvuDataWhenIdle(page, mutate, kind), true);
            }
            await waitCommittedGold(page, 42);
            if (kind === 'mvu-no-frame' || kind === 'mvu-with-frame') {
                await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.好感系统.乙称呼[0] === '小乙二');
            }
            const written = await read();
            const firstCalls = await page.evaluate(() => window.__rollbackCalls);
            if (kind === 'mvu-with-frame') assert.deepStrictEqual(firstCalls, ['importTableAsJson'], '已有帧的跨表修改不拆分持久化');
            if (kind !== 'sp-no-frame') {
                assert.ok(written.messages[2].frame, 'MVU 写入必须保存到目标回复');
                assert.deepStrictEqual(written.messages[0].frame, before.messages[0].frame, 'MVU 写入不得修改开场历史帧');
            }
            if (kind === 'mvu-batch') {
                assert.deepStrictEqual(firstCalls, ['importTableAsJson'], '已有帧的跨表混合更新也只提交一次');
                assert.strictEqual(written.bag.at(-1), '批次药品');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await openState(page, { ...state, chat }); await waitCommittedGold(page, 42);
                await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.背包.at(-1) === '批次药品');
                await assertStorageMode(page, mode, '批次写入刷新后模式');
            }
            let continuedCalls = [];
            if (kind === 'mvu-no-frame') {
                assert.deepStrictEqual(firstCalls, ['importTableAsJson'], '新楼首次写入一次正式快照');
                await page.evaluate(() => { window.__rollbackCalls.length = 0; });
                for (const gold of [43, 42]) {
                    assert.strictEqual(await page.evaluate(gold => {
                        const data = window.Mvu.getMvuData(); data.stat_data.状态.金币 = gold;
                        return window.Mvu.replaceMvuData(data);
                    }, gold), true);
                    await waitCommittedGold(page, gold);
                }
                continuedCalls = await page.evaluate(() => window.__rollbackCalls);
                assert.deepStrictEqual(continuedCalls, ['updateCell', 'updateCell'], '本楼后续小修改保留差量');
            }
            await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 1-2'));
            await page.waitForFunction(() => window.SillyTavern.getContext().chat.length === 1);
            await page.waitForTimeout(2000);
            const deleted = await read();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openState(page, { ...state, chat });
            await page.waitForFunction(chat => window.SillyTavern.getContext().chatId === chat
                && window.SillyTavern.getContext().chat.length === 1
                && [10, 42].includes(window.Mvu?.getMvuData?.()?.stat_data?.状态?.金币), chat);
            const restoredGold = (await read()).gold;
            await waitCommittedGold(page, restoredGold);
            const expectedPair = initial.pair;
            await page.waitForFunction(expected => JSON.stringify(window.Mvu.getMvuData().stat_data.好感系统.乙称呼) === JSON.stringify(expected), expectedPair);
            const reloaded = await read();
            await assertStorageMode(page, mode, kind + ' 刷新后模式');
            assert.strictEqual(deleted.gold, reloaded.gold, '删楼和重载必须一致');
            if (kind !== 'sp-no-frame') {
                assert.deepStrictEqual(reloaded.pair, initial.pair);
                assert.strictEqual(reloaded.gold, 10, '写入本楼时删楼必须恢复开场值');
                if (kind === 'mvu-batch') assert.deepStrictEqual(reloaded.bag, initial.bag);
            }
            if (kind === 'sp-no-frame') assert.strictEqual(reloaded.gold, 42, 'SP 直接 CRUD 对照保留其原有语义');
            evidence.push({ mode, kind, initial, before, written, deleted, reloaded, firstCalls, continuedCalls, rejectedCalls });
            fs.writeFileSync(path.join(work, 'rollback-' + runId + '.json'), JSON.stringify(evidence, null, 2));
            record('rollback-' + mode + '-' + kind, { goldBefore: before.gold, goldWritten: written.gold,
                goldAfterDelete: deleted.gold, goldAfterReload: reloaded.gold,
                framesWritten: summary(written).frames.map(f => f.index), firstCalls, continuedCalls, rejectedCalls });
        }
    }
    await setStorageMode(page, 'native');
};

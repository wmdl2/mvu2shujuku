
'use strict';
// 公共合成卡；实际 MVU 回调、数据库提交、助手保存、后端落盘和重开。
const assert = require('assert');
const { gunzipSync } = require('zlib');
const card = require('./synthetic-card');
function waitSaved(page, expected) {
    return page.waitForResponse(response => {
        if (!response.url().endsWith('/api/chats/save') || !response.ok()) return false;
        try {
            const request = response.request(); let body = request.postDataBuffer();
            if (request.headers()['content-encoding'] === 'gzip') body = gunzipSync(body);
            return JSON.parse(body.toString('utf8')).chat.some(row => row.mes === expected);
        } catch (_) { return false; }
    }, { timeout: 45000 }).catch(error => error);
}
module.exports = async function messageUpdateHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record }) {
    const modes = (process.argv.find(a => a.startsWith('--reply-modes='))?.split('=')[1] || 'native,sqlite').split(',');
    for (const mode of modes) {
        await setStorageMode(page, mode);
        const source = card(); source.data.name = '公开正文回调验收-' + mode;
        const state = await runtimeTest(page, source, undefined, 'message-hook-' + mode);
        await assertStorageMode(page, mode);
        await page.evaluate(() => {
            window.__messageHookCalls = 0;
            SillyTavern.getContext().eventSource.on('mag_before_message_update', context => {
                window.__messageHookCalls++;
                context.variables.stat_data.状态.金币 += 2;
                context.message_content = '公开正文<summary>金币：' + context.variables.stat_data.状态.金币 + '</summary>';
            });
        });
        const openingExpected = '公开正文<summary>金币：40</summary>';
        const openingSaved = waitSaved(page, openingExpected);
        await page.evaluate(async () => {
            await TavernHelper.setChatMessages([{ message_id: 0, message: '<initvar>{"状态":{"生命":100,"金币":37},"背包":["钥匙",0,false,null]}</initvar>公开开场<UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>' }], { refresh: 'affected' });
        });
        await waitCommittedGold(page, 40);
        const openingResponse = await openingSaved;
        if (openingResponse instanceof Error) throw openingResponse;
        assert.strictEqual(await page.evaluate(() => SillyTavern.getContext().chat[0].mes), openingExpected);
        assert.strictEqual(await page.evaluate(() => window.__messageHookCalls), 1);
        record('message-hook-opening-' + mode, { gold: 40, bodySaved: true, hooks: 1 });
        const expected = '公开正文<summary>金币：43</summary>';
        const saved = waitSaved(page, expected);
        const id = await page.evaluate(async () => {
            await TavernHelper.createChatMessages([{ role: 'assistant', message: '公开原正文<status_current_variable>旧状态</status_current_variable><UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>' }]);
            const ctx = SillyTavern.getContext(), id = ctx.chat.length - 1;
            await ctx.eventSource.emit(ctx.event_types.MESSAGE_RECEIVED, id); return id;
        });
        await waitCommittedGold(page, 43);
        const response = await saved; if (response instanceof Error) throw response;
        assert.strictEqual(await page.evaluate(id => SillyTavern.getContext().chat[id].mes, id), expected);
        assert.strictEqual(await page.evaluate(() => window.__messageHookCalls), 2);
        await page.evaluate(async id => {
            const ctx = SillyTavern.getContext(); await ctx.eventSource.emit(ctx.event_types.MESSAGE_RECEIVED, id);
            await ctx.eventSource.emit(ctx.event_types.GENERATION_ENDED);
        }, id);
        await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state);
        await waitCommittedGold(page, 43); await assertStorageMode(page, mode);
        assert.strictEqual(await page.evaluate(id => SillyTavern.getContext().chat[id].mes, id), expected);
        assert.strictEqual(await page.evaluate(() => SillyTavern.getContext().chat[0].mes), openingExpected);
        record('message-hook-save-reload-' + mode, { gold: 43, bodySaved: true, originalUpdatesNotReplayed: true });
    }
};

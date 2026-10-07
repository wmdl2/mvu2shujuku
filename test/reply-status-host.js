'use strict';
// 隔离宿主：真实助手消息保存/重开及 EJS 展开；固定模拟回复，不声称真实模型质量。
const assert = require('assert');
const { gunzipSync } = require('zlib');
const card = require('./synthetic-card');
module.exports = async function replyStatusHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, record }) {
    const modes = (process.argv.find(a => a.startsWith('--reply-modes='))?.split('=')[1] || 'native,sqlite').split(',');
    for (const mode of modes) {
        await setStorageMode(page, mode);
        const source = card(); source.data.name = '公开状态展示验收-' + mode;
        source.data.character_book.entries.push({ id: 98, comment: '公开状态展示', enabled: true, constant: true,
            content: '<status_current_variable>\n' + (mode === 'native' ? '{{format_message_variable::stat_data}}' : '{{get_message_variable::stat_data}}') + '\n生命低于20时描述伤势。\n</status_current_variable>//以上内容不直接输出' });
        const state = await runtimeTest(page, source, undefined, 'reply-' + mode);
        await assertStorageMode(page, mode);
        const expanded = await page.evaluate(async () => {
            const ctx = SillyTavern.getContext(), character = ctx.characters[ctx.characterId];
            const entry = (character.data || character).character_book.entries.find(e => e.comment === '公开状态展示');
            return EjsTemplate.evalTemplate(entry.content);
        });
        assert.match(expanded, /status_current_variable/);
        assert.match(expanded, /金币: 37/);
        assert.match(expanded, /生命低于20时描述伤势/);
        record('reply-status-input-' + mode, { stateExpanded: true, businessPreserved: true });
        const text = '公开正文前\n<status_current_variable>状态:\n  金币: 37\n</status_current_variable>\n公开正文中<status_current_variables>第二份状态</status_current_variables>公开正文后';
        const expected = '公开正文前\n\n公开正文中公开正文后';
        const savedResponse = page.waitForResponse(response => {
            if (!response.url().endsWith('/api/chats/save') || !response.ok()) return false;
            try {
                const request = response.request();
                let body = request.postDataBuffer();
                if (request.headers()['content-encoding'] === 'gzip') body = gunzipSync(body);
                const rows = JSON.parse(body.toString('utf8')).chat;
                return Array.isArray(rows) && rows.some(row => String(row.mes || '').replace(/\n\n<StatusPlaceHolderImpl\/>$/, '') === expected);
            } catch (_) { return false; }
        }, { timeout: 20000 }).catch(error => error);
        const id = await page.evaluate(async text => {
            await TavernHelper.createChatMessages([{ role: 'assistant', message: text }]);
            const ctx = SillyTavern.getContext(), id = ctx.chat.length - 1;
            await ctx.eventSource.emit(ctx.event_types.MESSAGE_RECEIVED, id);
            return id;
        }, text);
        await page.waitForFunction(id => !SillyTavern.getContext().chat[id].mes.includes('status_current_variable'), id, { timeout: 20000 });
        const body = await page.evaluate(id => SillyTavern.getContext().chat[id].mes, id);
        assert.strictEqual(body.replace(/\n\n<StatusPlaceHolderImpl\/>$/, ''), expected);
        assert.strictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data.状态.金币), 37);
        const saveResult = await savedResponse;
        if (saveResult instanceof Error) throw saveResult;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openState(page, state);
        await page.waitForFunction(id => !!SillyTavern.getContext().chat[id], id);
        const saved = await page.evaluate(id => SillyTavern.getContext().chat[id].mes, id);
        assert.strictEqual(saved.replace(/\n\n<StatusPlaceHolderImpl\/>$/, ''), expected);
        await assertStorageMode(page, mode);
        record('reply-status-save-reload-' + mode, { cleaned: true, outsideTextPreserved: true, gold: 37 });
    }
};

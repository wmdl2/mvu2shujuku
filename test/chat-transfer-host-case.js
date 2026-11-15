'use strict';
const assert = require('assert/strict');
const fs = require('fs'), path = require('path');
const core = require('../src/mvu2shujuku');

// Run through real-host.js with MVU_HOST_SCENARIO_FILE pointing to this file.
module.exports = async function ({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record, work }) {
    let consenting = false;
    const consentTimer = setInterval(async () => {
        if (consenting || page.isClosed()) return;
        consenting = true;
        try {
            const popup = page.locator('.popup:visible').filter({ hasText: '酒馆助手可用的嵌入式脚本' }).last();
            if (await popup.count()) await popup.getByRole('button', { name: '确认', exact: true }).click({ timeout: 1000 });
            const lore = page.locator('.popup:visible').filter({ hasText: 'This character has an embedded World/Lorebook.' }).last();
            if (await lore.count()) await lore.getByRole('button', { name: 'No', exact: true }).click({ timeout: 1000 });
        } catch (_) { /* A concurrently closed native consent is harmless. */ }
        finally { consenting = false; }
    }, 250);
    try {
    let state, before;
    const sourceNames = [];
    const fixtureFile = path.join(work, 'chat-transfer-source-fixture.json');
    if (process.env.MVU_CHAT_TRANSFER_RESUME_SOURCE === '1') {
        const saved = JSON.parse(fs.readFileSync(fixtureFile)); state = saved.state; before = saved.before; sourceNames.push(...saved.sourceNames);
        await openState(page, state); await assertStorageMode(page, 'sqlite', '聊天迁移恢复源夹具');
    } else {
    await setStorageMode(page, 'sqlite');
    const close = page.locator('#acu-app-v2 .acu-v2-app__close');
    if (await close.isVisible()) await close.click();
    const old = require('./synthetic-card')(); old.data.name = '迁移来源旧卡';
    state = await runtimeTest(page, old, core, 'chat-transfer-source');
    await assertStorageMode(page, 'sqlite', '聊天迁移');
    for (const [label, gold] of [['A', 37], ['B', 81]]) {
        if (label === 'B') {
            await page.evaluate(name => SillyTavern.getContext().openCharacterChat(name), '来源B-' + Date.now());
            await waitCommittedGold(page, 10);
        }
        await page.evaluate(async ({ label, gold }) => {
            await TavernHelper.createChatMessages([{ role: 'user', message: '用户正文-' + label }, { role: 'assistant', message: '角色正文-' + label }]);
            const index = SillyTavern.getContext().chat.length - 1;
            const text = '角色正文-' + label + '\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/状态/金币","value":999}]</JSONPatch></UpdateVariable>';
            await TavernHelper.setChatMessages([{ message_id: index, swipe_id: 1, swipes: ['不迁移的旧候选-' + label, text] }]);
        }, { label, gold });
        await waitCommittedGold(page, 999);
        await page.evaluate(async ({ label, gold }) => {
            const value = Mvu.getMvuData(); value.stat_data.状态.金币 = gold;
            if (!await Mvu.replaceMvuData(value)) throw Error('来源状态保存失败');
            TavernHelper.insertOrAssignVariables({ fixture_aux: '辅助值-' + label }, { type: 'message', message_id: -1 });
            await SillyTavern.getContext().saveChat();
        }, { label, gold });
        await waitCommittedGold(page, gold);
        sourceNames.push(await page.evaluate(() => SillyTavern.getContext().chatId + '.jsonl'));
    }
    before = await page.evaluate(async ({ avatar, names }) => {
        const ctx = SillyTavern.getContext(), data = {};
        for (const file of names) {
            const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) });
            data[file] = (await r.json()).result;
        }
        return data;
    }, { avatar: state.avatar, names: sourceNames });
        fs.writeFileSync(fixtureFile, JSON.stringify({ state, sourceNames, before }, null, 2));
    }
    if (process.env.MVU_CHAT_TRANSFER_NATIVE_SOURCE === '1') {
        // Saved native MVU state can be read without opening its author scripts.
        const plain = require('./synthetic-card')(); plain.data.name = '普通MVU迁移源-' + Date.now();
        plain.data.extensions.tavern_helper.scripts = [];
        const files = Object.values(before).map((text, i) => {
            const chat = core.getChatTransferFactory()().selected(core.getChatTransferFactory()().parse(text));
            for (const row of [chat.header.chat_metadata, ...chat.messages])
                for (const key of Object.keys(row)) if (key.startsWith('TavernDB_ACU_')) delete row[key];
            chat.messages.at(-1).variables[0].stat_data = { 状态: { 生命: 100, 金币: i ? 81 : 37 }, 背包: ['钥匙', 0, false, null] };
            chat.messages.at(-1).variables[0].schema = core.getMvuSchemaFactory()(require('../src/vendor/schema-engine-libs').lodash)
                .generateSchema(JSON.parse(JSON.stringify(chat.messages.at(-1).variables[0].stat_data)));
            core.getChatTransferFactory()().nativeMvu(chat); // Fail locally before starting a browser migration.
            return core.getChatTransferFactory()().stringify(chat);
        });
        const native = await page.evaluate(async ({ plain, files }) => {
            const ctx = SillyTavern.getContext();
            const cardForm = new FormData(); cardForm.append('avatar', new Blob([JSON.stringify(plain)], { type: 'application/json' }), 'native.json'); cardForm.append('file_type', 'json');
            const imported = await (await fetch('/api/characters/import', { method: 'POST', headers: ctx.getRequestHeaders({ omitContentType: true }), body: cardForm })).json();
            if (!imported.file_name) throw Error('原生源夹具导入失败');
            const avatar = imported.file_name + '.png', names = [], before = {};
            await ctx.getCharacters();
            await ctx.selectCharacterById(ctx.characters.findIndex(row => row.avatar === avatar));
            for (let index = 0; index < files.length; index++) {
                const form = new FormData(); form.append('avatar', new Blob([files[index]], { type: 'application/jsonl' }), 'chat.jsonl');
                form.append('file_type', 'jsonl'); form.append('avatar_url', avatar); form.append('character_name', '普通源-' + index + '-' + Date.now());
                form.append('user_name', ctx.name1 || '用户');
                const result = await (await fetch('/api/chats/import', { method: 'POST', headers: ctx.getRequestHeaders({ omitContentType: true }), body: form })).json();
                if (!result.res || result.fileNames?.length !== 1) throw Error('原生聊天夹具导入失败');
                const file = result.fileNames[0]; names.push(file);
                before[file] = (await (await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) })).json()).result;
            }
            await ctx.getCharacters(); return { avatar, names, before };
        }, { plain, files });
        state = { avatar: native.avatar }; sourceNames.splice(0, sourceNames.length, ...native.names); before = native.before;
    }
    const updated = require('./synthetic-card')(); updated.data.name = '名称不同的新版迁移卡-' + Date.now();
    updated.data.character_book.name = '新版迁移独立规则-' + Date.now();
    const initial = { 状态: { 生命: 100, 金币: 10, 魔力: 30 }, 背包: ['钥匙', 0, false, null] };
    updated.data.character_book.entries[0].content = JSON.stringify(initial);
    updated.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n新版开场。';
    updated.data.extensions.tavern_helper.scripts.push({ name: '结构声明', enabled: true,
        content: 'const S=z.object({状态:z.object({生命:z.number(),金币:z.number(),魔力:z.number()}),背包:z.array(z.any())});registerMvuSchema(S);' });
    await page.evaluate(() => document.querySelector('input[name="mvu2shujuku-source"][value="file"]').click());
    await page.locator('#mvu2shujuku-file').setInputFiles({ name: '新版.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(updated)) });
    await page.locator('#mvu2shujuku-convert-file').evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('.mvu2shujuku-result')?.innerText.includes('转换完成'), {}, { timeout: 60000 });
    await page.locator('#mvu2shujuku-chat-transfer details').evaluate(details => { details.open = true; });
    await page.locator('[data-chat-enable]').evaluate(check => check.click());
    await page.locator('[data-chat-source]').selectOption(state.avatar, { force: true });
    await page.waitForFunction(names => names.every(name => [...document.querySelectorAll('[data-chat-list] input')]
        .some(node => node.getAttribute('aria-label') === name)), sourceNames);
    await page.locator('[data-chat-list] input').evaluateAll((nodes, names) => {
        for (const node of nodes) if (names.includes(node.getAttribute('aria-label')) && !node.checked) node.click();
    }, sourceNames);
    await page.locator('#mvu2shujuku-save-card').evaluate(button => button.click());
    const confirm = page.getByRole('button', { name: '迁移兼容聊天', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.popup')].some(p => p.getClientRects().length &&
        /批量聊天迁移预检|聊天迁移未完成|聊天迁移结果/.test(p.innerText)), {}, { timeout: 180000 });
    const preview = await page.locator('.popup:visible').filter({ hasText: /批量聊天迁移预检|聊天迁移未完成|聊天迁移结果/ }).last().innerText();
    fs.writeFileSync(path.join(work, 'chat-transfer-preview.txt'), preview);
    assert(preview.includes('批量聊天迁移预检'), preview);
    assert(preview.includes('部分兼容')); assert(preview.includes('/状态/魔力'));
    await confirm.click();
    await page.waitForFunction(() => [...document.querySelectorAll('.popup')].some(p => p.getClientRects().length && /聊天迁移结果|聊天迁移未完成/.test(p.innerText)), {}, { timeout: 180000 });
    const summary = await page.locator('.popup:visible').filter({ hasText: /聊天迁移结果|聊天迁移未完成/ }).last().innerText();
    fs.writeFileSync(path.join(work, 'chat-transfer-summary.txt'), summary);
    assert(summary.includes('已迁移 2 / 2'), summary);
    const target = await page.evaluate(() => ({ avatar: SillyTavern.getContext().characters[SillyTavern.getContext().characterId].avatar, chat: SillyTavern.getContext().chatId }));
    const files = await page.evaluate(async avatar => {
        const ctx = SillyTavern.getContext(); const r = await fetch('/api/characters/chats', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, simple: true }) }); return r.json();
    }, target.avatar);
    const checked = [];
    const ok = page.locator('.popup:visible .popup-button-ok'); if (await ok.count()) await ok.click();
    for (const file of files) {
        const copied = await page.evaluate(async ({ avatar, file }) => {
            const ctx = SillyTavern.getContext();
            const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) });
            return JSON.parse((await r.json()).result.split('\n')[0]).chat_metadata?.mvu2shujuku_chat_transfer?.status === 'complete';
        }, { avatar: target.avatar, file: file.file_name });
        if (!copied) continue;
        await openState(page, { avatar: target.avatar, chat: file.file_id });
        const expectedGold = await page.evaluate(() => SillyTavern.getContext().chat.at(-1).mes.includes('角色正文-A') ? 37 : 81);
        await waitCommittedGold(page, expectedGold);
        const info = await page.evaluate(() => {
            const ctx = SillyTavern.getContext(), marker = ctx.chatMetadata.mvu2shujuku_chat_transfer;
            if (marker?.status !== 'complete') return null;
            return { marker, gold: Mvu.getMvuData().stat_data.状态.金币, mana: Mvu.getMvuData().stat_data.状态.魔力,
                last: ctx.chat.at(-1).mes, swipe: ctx.chat.at(-1).swipe_id, swipes: ctx.chat.at(-1).swipes, aux: ctx.chat.at(-1).variables[0].fixture_aux };
        });
        if (!info) continue;
        const label = info.last.includes('角色正文-A') ? 'A' : 'B';
        assert.equal(info.gold, label === 'A' ? 37 : 81); assert.equal(info.mana, 30);
        assert.equal(info.swipe, 0); assert.equal(info.swipes.length, 1); assert.equal(info.aux, '辅助值-' + label);
        checked.push({ label, gold: info.gold, mana: info.mana });
    }
    assert.equal(checked.length, 2);
    const after = await page.evaluate(async ({ avatar, names }) => {
        const ctx = SillyTavern.getContext(), data = {};
        for (const file of names) { const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) }); data[file] = (await r.json()).result; }
        return data;
    }, { avatar: state.avatar, names: sourceNames });
    assert.deepEqual(after, before, '原聊天文件被迁移流程改变');
    record('chat-transfer-batch-source-intact', { checked, sourceNames, sourceAvatar: state.avatar, targetAvatar: target.avatar });
    } finally { clearInterval(consentTimer); }
};

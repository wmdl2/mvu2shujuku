'use strict';
const assert = require('assert/strict');
const fs = require('fs'), path = require('path');
const core = require('../src/mvu2shujuku');

// Run through real-host.js with MVU_HOST_SCENARIO_FILE pointing to this file.
module.exports = async function ({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record, work }) {
    const delayedList = process.env.MVU_CHAT_TRANSFER_ASYNC_LIST === '1';
    const listEvidence = { empty: 0, staleMissing: 0, staleDeleted: 0 };
    if (delayedList) {
        let avatar, remaining = 0, deleted = false, previousRows = [];
        await page.route('**/api/characters/import', async route => {
            const body = route.request().postDataBuffer(), response = await route.fetch(), saved = await response.json();
            if (body?.length < 65536 && body.includes(Buffer.from('mvu2shujukuReader'))) {
                avatar = saved.file_name + '.png'; remaining = 3; deleted = false;
            }
            await route.fulfill({ response, json: saved });
        });
        await page.route('**/api/characters/delete', async route => {
            const body = route.request().postDataJSON(), response = await route.fetch();
            if (body.avatar_url === avatar) { deleted = true; remaining = 2; }
            await route.fulfill({ response });
        });
        await page.route('**/api/characters/all', async route => {
            const response = await route.fetch(), rows = await response.json();
            let payload = rows;
            if (avatar && remaining > 0) {
                if (deleted) { payload = previousRows; listEvidence.staleDeleted++; }
                else if (remaining > 1) { payload = []; listEvidence.empty++; }
                else { payload = rows.filter(card => card.avatar !== avatar); listEvidence.staleMissing++; }
                remaining--;
            }
            if (!deleted) previousRows = rows;
            await route.fulfill({ response, json: payload });
        });
    }
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
            chat.messages.at(-1).variables[0].stat_data = { 背包: ['钥匙', 0, false, null], 状态: { 金币: i ? 81 : 37, 生命: 100 } };
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
    const sourceOpens = [], timings = [];
    page.on('request', request => {
        if (!request.url().endsWith('/api/chats/get')) return;
        const body = request.postDataJSON();
        if (body.avatar_url === state.avatar) sourceOpens.push(body.file_name);
    });
    page.on('console', message => {
        if (message.text().includes('[M2SJK]聊天迁移耗时'))
            message.args().at(-1).jsonValue().then(value => timings.push(value)).catch(() => {});
    });
    const updated = require('./synthetic-card')();
    updated.data.name = process.env.MVU_CHAT_TRANSFER_SAME_NAMES === '1'
        ? await page.evaluate(avatar => SillyTavern.getContext().characters.find(card => card.avatar === avatar).name.replace(/_数据库$/, ''), state.avatar)
        : '名称不同的新版迁移卡-' + Date.now();
    updated.data.character_book.name = '新版迁移独立规则-' + Date.now();
    const preserveHistory = process.env.MVU_CHAT_TRANSFER_PRESERVE_HISTORY === '1';
    const initial = { 状态: { 生命: 100, 金币: 10, ...(preserveHistory ? {} : { 魔力: 30 }) }, 背包: ['钥匙', 0, false, null] };
    updated.data.character_book.entries[0].content = JSON.stringify(initial);
    updated.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n新版开场。';
    if (!preserveHistory) updated.data.extensions.tavern_helper.scripts.push({ name: '结构声明', enabled: true,
        content: 'const S=z.object({状态:z.object({生命:z.number(),金币:z.number(),魔力:z.number()}),背包:z.array(z.any())});registerMvuSchema(S);' });
    await page.evaluate(() => document.querySelector('input[name="mvu2shujuku-source"][value="file"]').click());
    await page.locator('#mvu2shujuku-file').setInputFiles({ name: '新版.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(updated)) });
    await page.locator('#mvu2shujuku-convert-file').evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('.mvu2shujuku-result')?.innerText.includes('转换完成'), {}, { timeout: 60000 });
    const transfer = page.locator('#mvu2shujuku-chat-transfer');
    await transfer.locator('details').evaluate(details => { details.open = true; });
    await transfer.locator('[data-chat-enable]').evaluate(check => check.click());
    await transfer.locator('[data-chat-source]').selectOption(state.avatar, { force: true });
    await page.waitForFunction(names => names.every(name => [...document.querySelectorAll('#mvu2shujuku-chat-transfer [data-chat-list] input')]
        .some(node => node.getAttribute('aria-label') === name)), sourceNames);
    await transfer.locator('[data-chat-list] input').evaluateAll((nodes, names) => {
        for (const node of nodes) if (names.includes(node.getAttribute('aria-label')) && !node.checked) node.click();
    }, sourceNames);
    await page.locator('#mvu2shujuku-save-card').evaluate(button => button.click());
    const confirm = page.getByRole('button', { name: '迁移兼容聊天', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.popup')].some(p => p.getClientRects().length &&
        /批量聊天迁移预检|聊天迁移未完成|聊天迁移结果/.test(p.innerText)), {}, { timeout: 180000 });
    const preview = await page.locator('.popup:visible').filter({ hasText: /批量聊天迁移预检|聊天迁移未完成|聊天迁移结果/ }).last().innerText();
    fs.writeFileSync(path.join(work, 'chat-transfer-preview.txt'), preview);
    assert(preview.includes('批量聊天迁移预检'), preview);
    if (process.env.MVU_CHAT_TRANSFER_SAME_NAMES === '1') {
        const names = await page.evaluate(sourceAvatar => {
            const context = SillyTavern.getContext(), source = context.characters.find(card => card.avatar === sourceAvatar),
                target = context.characters[context.characterId];
            return { source: source.name, target: target.name, targetAvatar: target.avatar };
        }, state.avatar);
        assert.equal(names.source, names.target);
        assert.notEqual(names.targetAvatar, state.avatar);
        assert(preview.includes('来源角色：' + names.source + '（' + state.avatar + '）'), preview);
        assert(preview.includes('目标角色：' + names.target + '（' + names.targetAvatar + '）'), preview);
    }
    if (preserveHistory) {
        assert(preview.includes('原数据库历史及已有表的填表进度随副本保留'), preview);
        assert(preview.includes('MVU 状态可完整导入'), preview);
    } else { assert(preview.includes('MVU 状态部分兼容')); assert(preview.includes('/状态/魔力')); }
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
        assert(info.marker.coverage?.keys?.length > 0, '迁入MVU表须有导入覆盖基线');
        assert.equal(info.marker.coverage.aiFloor, 2);
        const label = info.last.includes('角色正文-A') ? 'A' : 'B';
        if (preserveHistory) {
            assert.equal(info.marker.databaseHistory, 'preserved');
            const originals = core.getChatTransferFactory()().parse(Object.entries(before).find(([, text]) => text.includes('角色正文-' + label))[1]);
            const saved = await page.evaluate(async ({ avatar, file }) => {
                const ctx = SillyTavern.getContext();
                const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) });
                return (await r.json()).result;
            }, { avatar: target.avatar, file: file.file_name });
            const final = core.getChatTransferFactory()().parse(saved);
            let retained = 0;
            originals.messages.forEach((row, index) => {
                const entries = row.TavernDB_ACU_IsolatedData?.['']?.storageFrame?.logEntries || [];
                const actual = final.messages[index].TavernDB_ACU_IsolatedData?.['']?.storageFrame?.logEntries || [];
                for (const entry of entries) { assert(actual.some(item => JSON.stringify(item) === JSON.stringify(entry))); retained++; }
            });
            assert(retained > 0, '夹具必须有真实原数据库日志，才能证明没有重建掉原历史');
        }
        assert.equal(info.gold, label === 'A' ? 37 : 81); assert.equal(info.mana, preserveHistory ? undefined : 30);
        assert.equal(info.swipe, 0); assert.equal(info.swipes.length, 1); assert.equal(info.aux, '辅助值-' + label);
        await page.evaluate(async () => {
            const next = Mvu.getMvuData(); next.stat_data.状态.金币++;
            if (!await Mvu.replaceMvuData(next)) throw Error('迁移后的正常写入失败');
        });
        await waitCommittedGold(page, info.gold + 1);
        await openState(page, { avatar: target.avatar, chat: file.file_id });
        await waitCommittedGold(page, info.gold + 1);
        await page.evaluate(async gold => {
            const next = Mvu.getMvuData(); next.stat_data.状态.金币 = gold;
            if (!await Mvu.replaceMvuData(next)) throw Error('迁移后的正常恢复写入失败');
        }, info.gold);
        await waitCommittedGold(page, info.gold);
        checked.push({ label, gold: info.gold, mana: info.mana });
    }
    assert.equal(checked.length, 2);
    const after = await page.evaluate(async ({ avatar, names }) => {
        const ctx = SillyTavern.getContext(), data = {};
        for (const file of names) { const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) }); data[file] = (await r.json()).result; }
        return data;
    }, { avatar: state.avatar, names: sourceNames });
    assert.deepEqual(after, before, '原聊天文件被迁移流程改变');
    assert.deepEqual(sourceOpens, [], '迁移期间不能打开原聊天');
    record('chat-transfer-batch-source-intact', { checked, sourceNames, sourceAvatar: state.avatar, targetAvatar: target.avatar });
    await page.locator('#mvu2shujuku-clear').evaluate(button => button.click());
    const manager = page.locator('#mvu2shujuku-chat-manager');
    await manager.locator('details').evaluate(details => { details.open = true; });
    await manager.locator('[data-chat-refresh]').evaluate(button => button.click());
    await manager.locator('[data-chat-target]').selectOption(target.avatar, { force: true });
    await manager.locator('[data-chat-source]').selectOption(state.avatar, { force: true });
    await page.waitForFunction(names => names.every(name => [...document.querySelectorAll('#mvu2shujuku-chat-manager [data-chat-list] input')]
        .some(node => node.getAttribute('aria-label') === name)), sourceNames);
    await manager.locator('[data-chat-list] input').evaluateAll((nodes, names) => {
        for (const node of nodes) if (names.includes(node.getAttribute('aria-label')) && !node.checked) node.click();
    }, sourceNames);
    await manager.locator('[data-chat-run]').evaluate(button => button.click());
    await page.getByRole('button', { name: '迁移兼容聊天', exact: true }).click({ timeout: 60000 });
    const resultPopup = page.locator('.popup:visible').filter({ hasText: '聊天迁移结果' }).last();
    await resultPopup.waitFor({ timeout: 90000 });
    assert((await resultPopup.innerText()).includes('已迁移 2 / 2'));
    assert.equal(await manager.locator('[data-chat-list] input:checked').count(), 0, '成功项应取消勾选');
    assert.deepEqual(sourceOpens, []);
    fs.writeFileSync(path.join(work, 'chat-transfer-timings.json'), JSON.stringify(timings, null, 2));
    record('chat-transfer-standing-entry', { withoutConversionResult: true, sourceOpens, selectedAfterSuccess: 0, timings });
    await resultPopup.locator('.popup-button-ok').click();
    await manager.locator('[data-chat-list] input').evaluateAll((nodes, name) => {
        for (const node of nodes) if (node.getAttribute('aria-label') === name) node.click();
    }, sourceNames[0]);
    await manager.locator('[data-chat-run]').evaluate(button => button.click());
    await page.getByRole('button', { name: '取消迁移', exact: true }).click({ timeout: 60000 });
    const cancelled = page.locator('.popup:visible').filter({ hasText: '聊天迁移结果' }).last();
    await cancelled.waitFor({ timeout: 60000 });
    assert((await cancelled.innerText()).includes('已迁移 0 / 1'));
    assert.deepEqual(sourceOpens, [], '取消清理也不得返回原聊天');
    const cancelledSource = await page.evaluate(async ({ avatar, names }) => {
        const ctx = SillyTavern.getContext(), data = {};
        for (const file of names) {
            const r = await fetch('/api/chats/export', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, is_group: false, file, exportfilename: file, format: 'jsonl' }) });
            data[file] = (await r.json()).result;
        }
        return data;
    }, { avatar: state.avatar, names: sourceNames });
    assert.deepEqual(cancelledSource, before);
    record('chat-transfer-cancel-source-intact', { sourceOpens, originalFilesUnchanged: true });
    if (delayedList) {
        assert(listEvidence.empty > 0 && listEvidence.staleMissing > 0 && listEvidence.staleDeleted > 0);
        record('chat-transfer-async-list-readiness', listEvidence);
    }
    } finally { clearInterval(consentTimer); }
};

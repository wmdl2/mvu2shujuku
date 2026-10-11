'use strict';
// 使用真实扩展按钮、酒馆 JSONL 备份、酒馆助手变量 API 与数据库 SQLite 提交。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/mvu2shujuku');
const transfer = require('../src/state-transfer')();

function fixture() {
    const source = require('./synthetic-card')();
    source.data.name = '状态迁移公开验收-' + Date.now();
    source.data.alternate_greetings = [];
    const initial = core.parseInitVar(source.data.character_book.entries[0].content);
    initial.$独立缓存 = { 游标: 7 };
    initial.状态.$内部 = { 名称: '乙' };
    initial.名单 = [{ 名字: '同名', $缓存: '甲' }, { 名字: '同名', $缓存: '乙' }];
    source.data.character_book.entries[0].content = JSON.stringify(initial);
    source.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n公开迁移测试。';
    const extraSource = require('./synthetic-card')();
    extraSource.data.first_mes = ''; extraSource.data.alternate_greetings = [];
    extraSource.data.character_book.entries = [{ id: 1, comment: '[InitVar]', enabled: true, constant: true, keys: [], content: '{"迁移额外":{"内容":"源额外值"}}' }];
    const generated = core.convert(extraSource);
    const extraKey = Object.keys(generated.template).find(key => generated.template[key]?.name === '迁移额外表');
    assert(extraKey, '额外表必须由真实 Schema 与 DDL 生成');
    const extra = { [extraKey]: generated.template[extraKey] };
    extra[extraKey].sourceData.note = '额外表作者说明，不得被存档替换';
    extra[extraKey].updateConfig.updateFrequency = 0;
    function convert(input, options = {}) {
        const r = core.convert(input, options);
        const merged = core.mergeTemplates(r.template, extra, [extraKey]);
        return core.convert(input, { ...options, template: merged.template });
    }
    const r = convert(source);
    const layout = JSON.parse(r.card.data.extensions.mvu2shujuku.layout);
    const storage = require('../src/stat-storage')({ readLayout: () => layout, readPolicy: () => r.card.data.extensions.mvu2shujuku.statStorage });
    assert.deepStrictEqual(storage.combine(core.statDataFromTables(layout, r.template).stat_data, storage.split(initial).native), initial);
    assert.strictEqual(transfer.archive({ mvu: { stat_data: initial }, tables: r.template, layout }).extraTables.length, 1);
    return { source, initial, extra, extraKey, convert };
}
module.exports = async function stateTransferHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record, work }) {
    const f = fixture();
    await setStorageMode(page, 'sqlite');
    const closeDatabase = page.locator('#acu-app-v2 .acu-v2-app__close');
    if (await closeDatabase.isVisible()) await closeDatabase.click();
    const resumeSecond = process.env.MVU_TRANSFER_RESUME_SECOND === '1';
    const reuseBase = resumeSecond || process.env.MVU_TRANSFER_REUSE_BASE === '1';
    const convertedA = reuseBase ? JSON.parse(fs.readFileSync(path.join(work, 'state.json'))) : await runtimeTest(page, f.source, { convert: f.convert }, 'migration');
    if (reuseBase) await openState(page, convertedA);
    await assertStorageMode(page, 'sqlite', '状态迁移');
    if (reuseBase && process.env.MVU_TRANSFER_VERSION_ONLY === '1') {
        // 每个版本都实际迁移 37→55.5，不能把重复导入同一值当成持久写入证据。
        await page.evaluate(async () => {
            const data = Mvu.getMvuData(); data.stat_data.状态.金币 = 37;
            const result = await Mvu.replaceMvuData(data);
            if (result === false || result?.success === false) throw new Error('版本验收目标复位失败');
        });
        await waitCommittedGold(page, 37);
    }
    async function panel() {
        await page.locator('#extensions-settings-button').click();
        const header = page.locator('#mvu2shujuku-settings .inline-drawer-header');
        if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await header.click();
    }
    async function exportState(label) {
        if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await panel();
        await page.waitForFunction(() => !document.querySelector('#mvu2shujuku-export-state').disabled);
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('#mvu2shujuku-export-state').click()]);
        const file = fs.readFileSync(await download.path(), 'utf8');
        fs.writeFileSync(path.join(work, 'migration-' + label + '.json'), file);
        return JSON.parse(file);
    }
    async function importState(archive, label, accept = true) {
        if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await panel();
        const before = await page.evaluate(() => JSON.parse(JSON.stringify(SillyTavern.getContext().chat)));
        fs.writeFileSync(path.join(work, 'migration-' + label + '-before.json'), JSON.stringify(await page.evaluate(() => ({
            chat: SillyTavern.getContext().chat, metadata: SillyTavern.getContext().chatMetadata, tables: AutoCardUpdaterAPI.exportTableAsJson(),
        }))));
        await page.locator('#mvu2shujuku-state-file').setInputFiles({ name: 'state.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
        const popup = page.locator('dialog.popup').filter({ hasText: '导入状态预览' });
        await popup.waitFor({ timeout: 15000 });
        assert(await page.locator('#mvu2shujuku-export-state').isDisabled(), '预览时防重复操作');
        if (!accept) {
            await popup.locator('.popup-button-cancel').click();
            await page.waitForFunction(() => document.querySelector('#mvu2shujuku-state-progress').textContent.includes('已取消'));
            assert.deepStrictEqual(await page.evaluate(() => JSON.parse(JSON.stringify(SillyTavern.getContext().chat))), before);
            return;
        }
        const backupPromise = page.waitForEvent('download', { timeout: 30000 });
        await popup.locator('.popup-button-ok').click();
        const backup = await Promise.race([backupPromise, page.waitForFunction(() => document.querySelector('#mvu2shujuku-state-progress')?.textContent?.includes('操作失败'), {}, { timeout: 30000 })
            .then(async () => { throw new Error(await page.locator('#mvu2shujuku-state-progress').textContent()); })]);
        assert(backup.suggestedFilename().endsWith('-覆盖前备份.jsonl'));
        const backupText = fs.readFileSync(await backup.path(), 'utf8');
        fs.writeFileSync(path.join(work, 'migration-' + label + '-backup.jsonl'), backupText);
        const backupRows = backupText.trim().split('\n').map(JSON.parse).slice(1);
        assert.deepStrictEqual(backupRows, before, '备份为覆盖前全聊天和全分支');
        await page.waitForFunction(() => {
            const text = document.querySelector('#mvu2shujuku-state-progress').textContent;
            return /导入完成|操作失败/.test(text);
        }, {}, { timeout: 30000 });
        const text = await page.locator('#mvu2shujuku-state-progress').textContent();
        assert(text.includes('导入完成'), text);
        record('state-transfer-' + label, { status: text, backup: backup.suggestedFilename() });
    }
    async function nativeTarget(label, scope = 'message') {
        const card = require('./synthetic-card')();
        card.data.name = f.source.data.name + '-普通-' + label;
        card.data.first_mes = '普通 MVU 存储 API 验收。';
        card.data.alternate_greetings = []; card.data.character_book.entries = [];
        const avatar = await page.evaluate(async card => {
            const ctx = SillyTavern.getContext(), form = new FormData();
            form.append('avatar', new File([JSON.stringify(card)], 'native.json', { type: 'application/json' })); form.append('file_type', 'json');
            const response = await fetch('/api/characters/import', { method: 'POST', headers: { 'X-CSRF-Token': ctx.getRequestHeaders()['X-CSRF-Token'] }, body: form });
            if (!response.ok) throw new Error('native import ' + response.status);
            return (await response.json()).file_name + '.png';
        }, card);
        await page.evaluate(async avatar => {
            const ctx = SillyTavern.getContext(); await ctx.getCharacters();
            await ctx.selectCharacterById(ctx.characters.findIndex(ch => ch.avatar === avatar));
        }, avatar);
        await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
        const initial = transfer.clone(f.initial); initial.状态.金币 = 1; initial.$独立缓存.游标 = 1;
        await page.evaluate(async ({ initial, extra, extraKey, scope }) => {
            const ctx = SillyTavern.getContext();
            const schema = window.MVU2SHUJUKU_CORE.getMvuSchemaFactory()(window.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__.lodash).generateSchema(JSON.parse(JSON.stringify(initial)));
            const raw = { stat_data: initial, schema, initialized_lorebooks: { 目标书: ['已完成'] }, 辅助变量: '保留' };
            TavernHelper.replaceVariables(raw, scope === 'chat' ? { type: 'chat' } : { type: 'message', message_id: 0 });
            const template = { mate: { type: 'chatSheets', version: 2 }, ...extra };
            template[extraKey].content[1][1] = '目标旧值';
            const result = await AutoCardUpdaterAPI.initGameSession({}, { injectTemplate: true, loadPreset: false, templateData: template, templatePresetName: '迁移额外模板', resetExistingTableData: true });
            if (result?.success === false) throw new Error(result.message);
            await ctx.saveChat();
        }, { initial, extra: f.extra, extraKey: f.extraKey, scope });
        return { avatar, chat: await page.evaluate(() => SillyTavern.getContext().chatId) };
    }
    const convertedArchive = reuseBase ? JSON.parse(fs.readFileSync(path.join(work, 'migration-converted-source.json'))) : await exportState('converted-source');
    assert.strictEqual(convertedArchive.stat_data.$独立缓存.游标, 7);
    assert.strictEqual(convertedArchive.stat_data.状态.$内部.名称, '乙');
    let nativeA = { chat: '已验证的普通消息目标' };
    let nativeArchive, updated;
    f.source.data.name = convertedArchive.source.character;
    if (resumeSecond) {
        nativeArchive = JSON.parse(fs.readFileSync(path.join(work, 'migration-native-decimal-source.json')));
        updated = JSON.parse(fs.readFileSync(path.join(work, 'migration-converted-updated.json')));
    } else {
    if (reuseBase) {
        f.source.data.name = convertedArchive.source.character;
        nativeA = await page.evaluate(name => {
            const card = SillyTavern.getContext().characters.find(c => c.name === name + '-普通-甲');
            if (!card) throw new Error('复用的普通目标角色不存在');
            return { avatar: card.avatar, chat: card.chat };
        }, convertedArchive.source.character);
        await openState(page, nativeA);
    } else nativeA = await nativeTarget('甲');
    await importState(convertedArchive, 'converted-to-native');
    nativeArchive = await exportState('native-source');
    assert.deepStrictEqual(nativeArchive.stat_data, convertedArchive.stat_data);
    assert.strictEqual(nativeArchive.extraTables[0].content[1][1], '源额外值');
    assert.deepStrictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'message', message_id: 0 }).initialized_lorebooks), { 目标书: ['已完成'] });
    assert.strictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'message', message_id: 0 }).辅助变量), '保留');
    await page.evaluate(() => {
        const raw = TavernHelper.getVariables({ type: 'message', message_id: 0 }); raw.stat_data.状态.金币 = 55.5; raw.stat_data.名单.reverse();
        TavernHelper.replaceVariables(raw, { type: 'message', message_id: 0 });
    });
    nativeArchive = await exportState('native-decimal-source');
    await openState(page, convertedA);
    await importState(nativeArchive, 'native-to-converted');
    await waitCommittedGold(page, 55.5);
    updated = await exportState('converted-updated');
    assert.deepStrictEqual(updated.stat_data, nativeArchive.stat_data);
    }
    // 版本兼容批次只补真实表格导入与重载；四向及交互完整流程已有独立证据。
    if (process.env.MVU_TRANSFER_VERSION_ONLY === '1') {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.TavernHelper && window.AutoCardUpdaterAPI && window.__mvu2shujukuRuntime, {}, { timeout: 90000 });
        await openState(page, convertedA); await waitCommittedGold(page, 55.5);
        assert.deepStrictEqual((await exportState('version-after-reload')).stat_data, nativeArchive.stat_data);
        record('state-transfer-version-reload', { gold: 55.5, fullStateEqual: true });
        return;
    }
    const sourceB = transfer.clone(f.source); sourceB.data.name += '-JSON布局';
    const convertedB = resumeSecond ? await page.evaluate(name => {
        const card = SillyTavern.getContext().characters.find(c => c.name === name + '_数据库');
        if (!card) throw new Error('复用的 JSON 布局目标不存在');
        return { avatar: card.avatar, chat: card.chat };
    }, sourceB.data.name) : await runtimeTest(page, sourceB, { convert: input => f.convert(input, { jsonContainers: true }) }, 'migration-json');
    if (resumeSecond) await openState(page, convertedB);
    await importState(updated, 'converted-to-converted');
    assert.deepStrictEqual((await exportState('converted-json-target')).stat_data, nativeArchive.stat_data);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.TavernHelper && window.AutoCardUpdaterAPI && window.__mvu2shujukuRuntime, {}, { timeout: 90000 });
    await openState(page, convertedB); await waitCommittedGold(page, 55.5);
    assert.deepStrictEqual((await exportState('converted-after-reload')).stat_data, nativeArchive.stat_data);
    const nativeB = await nativeTarget('乙');
    await importState(nativeArchive, 'native-to-native');
    assert.deepStrictEqual((await exportState('native-target')).stat_data, nativeArchive.stat_data);
    await importState(convertedArchive, 'cancel', false);
    record('state-transfer-cancel', { chat: nativeB.chat, stateUnchanged: true });
    // 预览后的并发编辑必须中止，不能将新状态覆盖回旧档案。
    await page.locator('#mvu2shujuku-state-file').setInputFiles({ name: 'stale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(convertedArchive)) });
    const popup = page.locator('dialog.popup').filter({ hasText: '导入状态预览' }); await popup.waitFor();
    await page.evaluate(() => {
        const raw = TavernHelper.getVariables({ type: 'message', message_id: 0 }); raw.stat_data.状态.金币 = 77;
        TavernHelper.replaceVariables(raw, { type: 'message', message_id: 0 });
    });
    await popup.locator('.popup-button-ok').click();
    await page.waitForFunction(() => document.querySelector('#mvu2shujuku-state-progress').textContent.includes('操作失败'));
    assert.strictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'message', message_id: 0 }).stat_data.状态.金币), 77);
    record('state-transfer-stale-preview', { preservedNewValue: 77, nativeSource: nativeA.chat });
    fs.writeFileSync(path.join(work, 'migration-native-target.json'), JSON.stringify(nativeB));
    const nativeChat = await nativeTarget('聊天变量', 'chat');
    await importState(nativeArchive, 'native-chat-scope');
    const chatArchive = await exportState('native-chat-target');
    assert.strictEqual(chatArchive.source.scope, 'chat');
    assert.deepStrictEqual(chatArchive.stat_data, nativeArchive.stat_data);
    assert.strictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'chat' }).辅助变量), '保留');
    record('state-transfer-chat-scope', nativeChat);
};
module.exports.preflight = fixture;

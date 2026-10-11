'use strict';
const assert = require('node:assert'), fs = require('node:fs'), path = require('node:path');
module.exports = async function ({ page, runtimeTest, setStorageMode, assertStorageMode, openState, record, work }) {
    await setStorageMode(page, 'sqlite');
    const close = page.locator('#acu-app-v2 .acu-v2-app__close'); if (await close.isVisible()) await close.click();
    const source = JSON.parse(fs.readFileSync(path.join(work, 'migration-native-decimal-source.json')));
    const original = JSON.parse(fs.readFileSync(path.join(work, 'migration-converted-source.json'))).source.character;
    const state = await page.evaluate(name => {
        const card = SillyTavern.getContext().characters.find(c => c.name === name + '-普通-聊天变量');
        if (!card) throw new Error('已创建的聊天变量目标不存在');
        return { avatar: card.avatar, chat: card.chat };
    }, original);
    const zodOnly = process.env.MVU_TRANSFER_ZOD_ONLY === '1';
    if (!zodOnly) {
    await openState(page, state);
    await page.evaluate(async initial => {
        const vars = TavernHelper.getVariables({ type: 'chat' }); vars.stat_data = initial;
        vars.schema = window.MVU2SHUJUKU_CORE.getMvuSchemaFactory()(window.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__.lodash).generateSchema(JSON.parse(JSON.stringify(initial)));
        TavernHelper.replaceVariables(vars, { type: 'chat' }); await SillyTavern.getContext().saveChat();
    }, source.stat_data);
    await assertStorageMode(page, 'sqlite', '聊天变量与失败回退');
    }
    if (!zodOnly) {
    await page.locator('#extensions-settings-button').click();
    if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await page.locator('#mvu2shujuku-settings .inline-drawer-header').click();
    }
    async function importFile(file, accept = true, backup = true, native = true) {
        await page.locator('#mvu2shujuku-state-file').setInputFiles({ name: 'state.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
        const popup = page.locator('dialog.popup').filter({ hasText: '导入状态预览' }); await popup.waitFor({ timeout: 20000 });
        if (native) assert((await popup.textContent()).includes('聊天变量（沿用原卡位置）'));
        if (!backup) await popup.locator('#mvu2shujuku-state-backup').uncheck();
        if (file.__expectPartial) { assert((await popup.textContent()).includes('无法完整导入')); assert.strictEqual(await popup.locator('.popup-button-ok').textContent(), '仅导入兼容字段'); }
        const box = await popup.locator('.popup-button-ok').boundingBox();
        const buttonText = (await popup.locator('.popup-button-ok').textContent()).trim();
        assert(box.width >= Math.min(70, buttonText.length * 8) && box.height < 60, '确认按钮不能挤成竖排');
        const download = backup && accept ? page.waitForEvent('download', { timeout: 30000 }).catch(() => null) : Promise.resolve(null);
        await popup.locator(accept ? '.popup-button-ok' : '.popup-button-cancel').click();
        await page.waitForFunction(() => /导入完成|操作失败|已取消/.test(document.querySelector('#mvu2shujuku-state-progress')?.textContent || ''), {}, { timeout: 30000 });
        return { status: await page.locator('#mvu2shujuku-state-progress').textContent(), download: await download };
    }
    let downloads = 0; const countDownload = () => { downloads++; }; page.on('download', countDownload);
    if (!zodOnly) {
    const success = await importFile(source);
    assert(success.status.includes('导入完成'), success.status); assert(success.download, '覆盖前必须下载备份');
    const actual = await page.evaluate(() => TavernHelper.getVariables({ type: 'chat' }));
    assert.deepStrictEqual(actual.stat_data, source.stat_data); assert.strictEqual(actual.辅助变量, '保留');
    record('state-transfer-chat-scope', { scope: 'chat', state, backup: success.download.suggestedFilename() });
    const saved = await page.evaluate(() => ({ vars: TavernHelper.getVariables({ type: 'chat' }), tables: AutoCardUpdaterAPI.exportTableAsJson() }));
    const changed = JSON.parse(JSON.stringify(source)); changed.stat_data.状态.金币 = 88.75;
    changed.extraTables[0].content[1][1] = '失败不应留下此值';
    let saveCount = 0, injected = false, interceptionError;
    await page.route('**/api/chats/save', async route => {
        try {
            saveCount++;
            if ((route.request().postData() || '').includes('失败不应留下此值')) { injected = true; await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"isolated save failure"}' }); }
            else await route.continue();
        } catch (e) { interceptionError = e; await route.abort().catch(() => {}); }
    });
    let failed;
    try { failed = await importFile(changed); }
    finally { await page.unroute('**/api/chats/save'); }
    if (interceptionError) throw interceptionError;
    assert(injected, '必须命中实际覆盖提交的保存请求');
    assert(failed.status.includes('操作失败'), failed.status); assert(failed.download, '写入失败也已有完整备份');
    const after = await page.evaluate(() => ({ vars: TavernHelper.getVariables({ type: 'chat' }), tables: AutoCardUpdaterAPI.exportTableAsJson() }));
    assert.deepStrictEqual(after.vars, saved.vars);
    const table = Object.values(after.tables).find(t => t?.name === '迁移额外表');
    const before = Object.values(saved.tables).find(t => t?.name === '迁移额外表');
    assert.deepStrictEqual(table.content, before.content);
    record('state-transfer-save-failure', { status: failed.status, injectedSave: saveCount, originalValue: after.vars.stat_data.状态.金币 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.TavernHelper && window.AutoCardUpdaterAPI && window.__mvu2shujukuRuntime, {}, { timeout: 90000 });
    await openState(page, state);
    assert.deepStrictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'chat' })), saved.vars);
    record('state-transfer-failure-reload', { originalValue: saved.vars.stat_data.状态.金币 });
    // 沿用上一个已验证的原生 chat 目标，不另建保存引擎。
    await page.evaluate(async () => {
        const vars = TavernHelper.getVariables({ type: 'chat' }); vars.stat_data.状态.新增能力 = 9;
        vars.schema = window.MVU2SHUJUKU_CORE.getMvuSchemaFactory()(window.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__.lodash).generateSchema(JSON.parse(JSON.stringify(vars.stat_data)));
        TavernHelper.replaceVariables(vars, { type: 'chat' }); await SillyTavern.getContext().saveChat();
    });
    await page.locator('#extensions-settings-button').click();
    if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await page.locator('#mvu2shujuku-settings .inline-drawer-header').click();
    const partial = JSON.parse(JSON.stringify(source)); partial.extraTables = []; partial.__expectPartial = true;
    partial.stat_data.状态.金币 = 12.5; partial.stat_data.状态.生命 = '类型已改变'; partial.stat_data.状态.旧字段 = '不猜改名';
    const nativeDownloads = downloads, noBackup = await importFile(partial, true, false);
    assert(noBackup.status.includes('兼容字段导入完成'), noBackup.status); assert.strictEqual(downloads, nativeDownloads);
    const partialVars = await page.evaluate(() => TavernHelper.getVariables({ type: 'chat' }));
    assert.strictEqual(partialVars.stat_data.状态.新增能力, 9); assert.strictEqual(partialVars.stat_data.状态.金币, 12.5);
    assert.strictEqual(partialVars.stat_data.状态.生命, saved.vars.stat_data.状态.生命); assert(!Object.hasOwn(partialVars.stat_data.状态, '旧字段'));
    record('state-transfer-partial-without-backup', { status: noBackup.status, downloads: downloads - nativeDownloads });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.TavernHelper && window.AutoCardUpdaterAPI && window.__mvu2shujukuRuntime, {}, { timeout: 90000 }); await openState(page, state);
    assert.deepStrictEqual(await page.evaluate(() => TavernHelper.getVariables({ type: 'chat' })), partialVars);
    record('state-transfer-partial-chat-reload', { gold: partialVars.stat_data.状态.金币 });
    }
    const moduleUrl = new URL('/fixture-transfer-schema.js', page.url()).href; let routeError;
    await page.route(moduleUrl, async route => {
        try { await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export function registerMvuSchema(schema) {}' }); }
        catch (e) { routeError = e; await route.abort().catch(() => {}); }
    });
    const schemaSource = require('./synthetic-card')(); schemaSource.data.name = '迁移纯校验验收-' + Date.now(); schemaSource.data.alternate_greetings = [];
    schemaSource.data.extensions.tavern_helper.scripts.push({ type: 'script', name: '纯字段规则', enabled: true, content:
        `import {registerMvuSchema} from ${JSON.stringify(moduleUrl)}; const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number().min(0).max(100),新增能力:z.number().default(9),格式:z.string().default('正常'),可选备注:z.string().optional(),允许变型:z.union([z.number(),z.string()]).default(1)}),背包:z.array(z.any())}).passthrough(); $(()=>registerMvuSchema(Schema));` });
    const initialSchema = require('../src/mvu2shujuku').parseInitVar(schemaSource.data.character_book.entries[0].content); initialSchema.状态.可选备注 = '目标备注';
    schemaSource.data.character_book.entries[0].content = JSON.stringify(initialSchema); schemaSource.data.first_mes = '<initvar>' + JSON.stringify(initialSchema) + '</initvar>\n迁移字段测试。';
    const convertedState = await runtimeTest(page, schemaSource, undefined, 'transfer-pure'); if (routeError) throw routeError;
    await assertStorageMode(page, 'sqlite', '迁移纯校验');
    const closeAgain = page.locator('#acu-app-v2 .acu-v2-app__close'); if (await closeAgain.isVisible()) await closeAgain.click();
    await page.locator('#extensions-settings-button').click();
    if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await page.locator('#mvu2shujuku-settings .inline-drawer-header').click();
    const beforePartial = await page.evaluate(() => Mvu.getMvuData().stat_data);
    const invalid = { stat_data: { 状态: { 生命: 72, 金币: 200, 格式: 123, 旧字段: '不猜改名' }, 背包: ['新物品'] }, __expectPartial: true };
    const beforeDownloads = downloads, sqlPartial = await importFile(invalid, true, false, false);
    assert(sqlPartial.status.includes('兼容字段导入完成'), sqlPartial.status); assert.strictEqual(downloads, beforeDownloads);
    const expected = JSON.parse(JSON.stringify(beforePartial)); expected.状态.生命 = 72; delete expected.状态.可选备注; expected.背包 = ['新物品'];
    assert.deepStrictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data), expected);
    record('state-transfer-zod-partial', { status: sqlPartial.status, rangeRejected: 200, retained: beforePartial.状态.金币 });
    await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, convertedState);
    await page.waitForFunction(() => { try { return Mvu.getMvuData().stat_data.状态.生命 === 72; } catch (_) { return false; } });
    assert.deepStrictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data), expected);
    record('state-transfer-zod-partial-reload', expected.状态);
    await page.locator('#extensions-settings-button').click();
    if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await page.locator('#mvu2shujuku-settings .inline-drawer-header').click();
    const full = { stat_data: JSON.parse(JSON.stringify(expected)) }; full.stat_data.状态.允许变型 = '新内容'; full.stat_data.状态.金币 = 22.5;
    const complete = await importFile(full, true, true, false); assert(complete.status.startsWith('状态导入完成'), complete.status); assert(complete.download);
    assert.deepStrictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data), full.stat_data);
    record('state-transfer-full-union', { status: complete.status, originalUnionAccepted: true });
    page.off('download', countDownload); await page.unroute(moduleUrl);
};

'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
// Isolated manual-import regression, run through real-host.js's scenario entry.
module.exports = async ({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, work, record }) => {
    const fixture = require('./state-transfer-host').preflight();
    await setStorageMode(page, 'sqlite');
    const close = page.locator('#acu-app-v2 .acu-v2-app__close');
    if (await close.isVisible()) await close.click();
    const state = await runtimeTest(page, fixture.source, { convert: fixture.convert }, 'coverage-state');
    await assertStorageMode(page, 'sqlite', '覆盖基线');
    if (process.env.MVU_COVERAGE_REPORTED_VERSION) {
        const reported = process.env.MVU_COVERAGE_REPORTED_VERSION;
        await page.route('**/scripts/extensions/third-party/sp-database/manifest.json*', async route => {
            const response = await route.fetch(), manifest = await response.json();
            manifest.version = reported;
            await route.fulfill({ response, json: manifest });
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.TavernHelper && window.AutoCardUpdaterAPI && window.__mvu2shujukuRuntime);
        await openState(page, state); await waitCommittedGold(page, 37);
        const detected = await page.evaluate(async () => {
            const extensions = await import('/scripts/extensions.js');
            return window.__MVU2SHUJUKU_SP_VERSION_FACTORY__({ readExtensions: () => extensions })();
        });
        assert.equal(detected, 'naiv' + reported);
        record('state-transfer-version-label-independent', { reported, actualSource: '1.3.5', detected });
    }
    if (!await page.locator('#mvu2shujuku-export-state').isVisible()) {
        await page.locator('#extensions-settings-button').click();
        if (!await page.locator('#mvu2shujuku-export-state').isVisible()) await page.locator('#mvu2shujuku-settings .inline-drawer-header').click();
    }
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#mvu2shujuku-export-state').click()]);
    const archive = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    const coverage = () => page.evaluate(() => {
        const iso = AutoCardUpdaterAPI.getTableHistoryContext().isolationKey;
        return SillyTavern.getContext().chat.flatMap((row, index) => {
            const frame = row.TavernDB_ACU_IsolatedData?.[iso]?.storageFrame;
            return [...Object.entries(frame?.checkpoint?.scheduleSummary || {}),
                ...Object.entries(frame?.perSheetCheckpoints || {}).map(([key, cp]) => [key, cp.scheduleSummary || {}])]
                .filter(([, summary]) => summary.lastImportBaselineAiFloor > 0)
                .map(([key, summary]) => index + ':' + key + ':' + summary.lastImportBaselineAiFloor);
        }).sort();
    });
    async function importState(value) {
        await page.locator('#mvu2shujuku-state-file').setInputFiles({ name: 'state.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
        const popup = page.locator('dialog.popup').filter({ hasText: '导入状态预览' });
        await popup.waitFor(); await popup.locator('#mvu2shujuku-state-backup').uncheck();
        await popup.locator('.popup-button-ok').click();
        await page.waitForFunction(() => /导入完成|操作失败/.test(document.querySelector('#mvu2shujuku-state-progress')?.textContent || ''));
        return page.locator('#mvu2shujuku-state-progress').textContent();
    }
    archive.stat_data.状态.金币 = 55.5;
    archive.stat_data = Object.fromEntries(Object.entries(archive.stat_data).reverse());
    const status = await importState(archive); assert(status.includes('导入完成'), status);
    await waitCommittedGold(page, 55.5);
    const beforeCoverage = await coverage(); assert(beforeCoverage.length > 0);
    await openState(page, state); await waitCommittedGold(page, 55.5);
    assert.deepEqual(await coverage(), beforeCoverage);
    await page.evaluate(async () => { await TavernHelper.createChatMessages([{ role: 'assistant', message: '覆盖保存失败测试' }]); await SillyTavern.getContext().saveChat(); });
    const targetFloor = await page.evaluate(() => SillyTavern.getContext().chat.filter(row => !row.is_user).length);
    archive.stat_data.状态.金币 = 66.25;
    let injected = false;
    await page.route('**/api/chats/save', async route => {
        const expression = new RegExp('"lastImportBaselineAiFloor"\\s*:\\s*' + targetFloor + '(?:[,}])');
        if (!injected && expression.test(route.request().postData() || '')) {
            injected = true;
            await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"coverage save failure"}' });
        } else await route.continue();
    });
    let failure;
    try { failure = await importState(archive); } finally { await page.unroute('**/api/chats/save'); }
    assert(injected); assert(failure.includes('操作失败'), failure);
    await waitCommittedGold(page, 55.5); assert.deepEqual(await coverage(), beforeCoverage);
    await openState(page, state); await waitCommittedGold(page, 55.5); assert.deepEqual(await coverage(), beforeCoverage);
    record('state-transfer-coverage-save-rollback', { savedGold:55.5, failedSaveInjected:true, progressRestored:true });
    // A real later write plus a controlled stale export must never be undone.
    await page.evaluate(() => {
        const api = AutoCardUpdaterAPI, original = api.importTableAsJson;
        window.__coverageRestoreImport = () => { api.importTableAsJson = original; };
        api.importTableAsJson = async function (text, options) {
            if (options?.persist !== false) window.__coverageCandidate = JSON.parse(text);
            return original.call(api, text, options);
        };
    });
    archive.stat_data.状态.金币 = 77.5; injected = false;
    await page.route('**/api/chats/save', async route => {
        const expression = new RegExp('"lastImportBaselineAiFloor"\\s*:\\s*' + targetFloor + '(?:[,}])');
        if (!injected && expression.test(route.request().postData() || '')) {
            injected = true;
            await page.evaluate(async () => {
                const frozen = window.__coverageCandidate;
                const value = Mvu.getMvuData(); value.stat_data.状态.金币 = 99;
                if (!await Mvu.replaceMvuData(value)) throw Error('并发写入夹具失败');
                const api = AutoCardUpdaterAPI, original = api.exportTableAsJson;
                window.__coverageRestoreExport = () => { api.exportTableAsJson = original; };
                api.exportTableAsJson = () => frozen;
            });
            await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"coverage concurrent failure"}' });
        } else await route.continue();
    });
    try { failure = await importState(archive); }
    finally {
        await page.unroute('**/api/chats/save');
        await page.evaluate(() => { window.__coverageRestoreExport?.(); window.__coverageRestoreImport?.(); });
    }
    assert(injected); assert(failure.includes('操作失败'), failure); assert(failure.includes('未强制回退表格'), failure);
    await openState(page, state); await waitCommittedGold(page, 99);
    record('state-transfer-coverage-concurrent-preserved', { laterWrite:99, staleRuntimeSimulated:true });
};

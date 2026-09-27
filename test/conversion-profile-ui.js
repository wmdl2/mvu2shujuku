#!/usr/bin/env node
'use strict';
// 完整扩展包 + 浏览器宿主替身；验证真实配置/合表按钮，不启动 SillyTavern 服务。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const work = process.env.MVU_PROFILE_UI_TEST_DIR || path.join(root, '.tools/conversion-profile-ui');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const core = require('../src/mvu2shujuku');
const view = require('../src/result-view')();
const indexFile = path.resolve(process.argv[2] || path.join(root, 'index.js'));
const clone = value => JSON.parse(JSON.stringify(value));

async function main() {
    fs.mkdirSync(work, { recursive: true });
    const card = require('./frontend-card')();
    const base = core.convert(card).template;
    const baseSheets = Object.values(base).filter(s => s && s.name);
    assert.strictEqual(baseSheets.length, 3);
    const externalCard = clone(card);
    const init = JSON.stringify({ 外部: { 记录: '来源中的新值' } });
    externalCard.data.first_mes = '<initvar>' + init + '</initvar>';
    externalCard.data.character_book.entries[0].content = init;
    const external = core.convert(externalCard).template;
    const uid = Object.keys(external).find(k => k.startsWith('sheet_'));
    const externalName = external[uid].name;
    const tableConfigs = Object.fromEntries(baseSheets.map(s => [s.name, view.captureConfig(s)]));
    tableConfigs[baseSheets[0].name].updateFrequency = 7;
    tableConfigs[externalName] = { updateFrequency: 9, injectIntoWorldbook: false };
    const ref = { source: { value: 'global' }, uid, name: externalName, fingerprint: core.stableHash(external[uid]) };
    const profiles = {
        完整配置: { format: 'mvu2shujuku-conversion-profile', version: 1, name: '完整配置', tableConfigs, externalTables: [ref] },
        部分配置: { format: 'mvu2shujuku-conversion-profile', version: 1, name: '部分配置',
            tableConfigs: { [baseSheets[0].name]: { updateFrequency: 6 }, 不存在甲: {}, 不存在乙: {} }, externalTables: [] },
    };
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ acceptDownloads: true });
        page.setDefaultTimeout(12000);
        const errors = [], decisions = [], confirmations = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => {
            try {
                assert.strictEqual(dialog.type(), 'confirm');
                assert.ok(decisions.length, '出现了未预期的确认弹窗：' + dialog.message());
                confirmations.push(dialog.message());
                if (decisions.shift()) await dialog.accept(); else await dialog.dismiss();
            } catch (error) { errors.push(error.message); await dialog.dismiss().catch(() => {}); }
        });
        await page.setContent('<div id="extensions_settings"></div>');
        await page.evaluate(({ profiles, external }) => {
            window.__profileTest = { profiles, external, messages: [], writes: 0, reads: 0, saves: 0 };
            const state = window.__profileTest;
            const context = { extensionSettings: { mvu2shujuku: { asPng: 'json', mode: 'both', conversionProfiles: profiles } },
                characters: [], chat: [], eventTypes: {}, eventSource: { on() {}, off() {} },
                saveSettingsDebounced() { state.saves++; } };
            window.SillyTavern = { getContext: () => context };
            window.AutoCardUpdaterAPI = {
                importTemplateFromData() { state.writes++; return true; },
                getTableTemplate() { state.reads++; return structuredClone(state.external); },
                getPluginVersion() { return '9.2.5'; },
            };
            window.toastr = Object.fromEntries(['info', 'warning', 'error', 'success'].map(type => [type,
                text => state.messages.push({ type, text: String(text) })]));
        }, { profiles, external });
        await page.addScriptTag({ content: fs.readFileSync(indexFile, 'utf8') });
        await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
        await page.locator('#mvu2shujuku-file').setInputFiles({ name: '公开配置测试.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) });
        const convert = async name => {
            await page.locator('#mvu2shujuku-profile-select').selectOption(name);
            const count = await page.evaluate(() => window.__profileTest.messages.length);
            await page.locator('#mvu2shujuku-convert-file').click();
            await page.waitForFunction(count => window.__profileTest.messages.slice(count).some(m => m.text.startsWith('转换完成，共 ')), count);
        };
        let downloadId = 0;
        const downloadTemplate = async () => {
            const promise = page.waitForEvent('download');
            await page.locator('#mvu2shujuku-downloads button').filter({ hasText: /模板/ }).click();
            const download = await promise;
            const target = path.join(work, 'template-' + (++downloadId) + '.json');
            await download.saveAs(target);
            return JSON.parse(fs.readFileSync(target, 'utf8'));
        };
        const sheetNamed = (template, name) => Object.values(template).find(s => s && s.name === name);
        await convert('完整配置');
        assert.strictEqual(await page.locator('.mvu2shujuku-table-row').count(), 4);
        let template = await downloadTemplate();
        assert.strictEqual(sheetNamed(template, baseSheets[0].name).updateConfig.updateFrequency, 7);
        assert.strictEqual(sheetNamed(template, externalName).updateConfig.updateFrequency, 9);
        assert.strictEqual(sheetNamed(template, externalName).exportConfig.injectIntoWorldbook, false);

        decisions.push(true);
        await convert('部分配置');
        template = await downloadTemplate();
        assert.strictEqual(sheetNamed(template, baseSheets[0].name).updateConfig.updateFrequency, 6);
        // 下载会保存已应用的配置；恢复公开夹具后再测试拒绝，避免误用被更新后的配置。
        await page.evaluate(profile => { window.__profileTest.profiles.部分配置 = profile; }, profiles.部分配置);
        decisions.push(false);
        await convert('部分配置');
        template = await downloadTemplate();
        assert.strictEqual(sheetNamed(template, baseSheets[0].name).updateConfig.updateFrequency, baseSheets[0].updateConfig.updateFrequency);
        assert.deepStrictEqual(await page.evaluate(() => window.__profileTest.profiles.部分配置), profiles.部分配置);
        const savedName = await page.locator('#mvu2shujuku-profile-select').inputValue();
        assert.notStrictEqual(savedName, '部分配置');
        assert.deepStrictEqual(await page.evaluate(name => window.__profileTest.profiles[name].externalTables, savedName), []);

        await page.locator('.mvu2shujuku-merge-section').evaluate(node => { node.open = true; });
        await page.locator('#mvu2shujuku-merge-source').selectOption('global');
        await page.locator('#mvu2shujuku-merge-load').click();
        const check = page.locator('#mvu2shujuku-merge-tables input[type="checkbox"]');
        await check.check();
        await page.evaluate(() => {
            const core = window.MVU2SHUJUKU_CORE, original = core.refreshConversion;
            core.refreshConversion = function (...args) {
                core.refreshConversion = original;
                throw new Error('测试注入：刷新失败');
            };
        });
        await page.locator('#mvu2shujuku-merge-apply').click();
        await page.waitForFunction(() => window.__profileTest.messages.some(m => m.text.includes('测试注入：刷新失败')));
        assert.strictEqual(await page.locator('.mvu2shujuku-table-row').count(), 3);
        await downloadTemplate();
        assert.deepStrictEqual(await page.evaluate(name => window.__profileTest.profiles[name].externalTables, savedName), []);
        await page.locator('#mvu2shujuku-merge-apply').click();
        await page.waitForFunction(() => document.querySelectorAll('.mvu2shujuku-table-row').length === 4);
        template = await downloadTemplate();
        assert.ok(sheetNamed(template, externalName));
        assert.deepStrictEqual(await page.evaluate(name => window.__profileTest.profiles[name].externalTables, savedName), [ref]);
        assert.strictEqual(await page.evaluate(() => window.__profileTest.writes), 0);
        assert.deepStrictEqual(decisions, []);
        assert.strictEqual(confirmations.length, 2);
        assert.deepStrictEqual(errors, []);
        const summary = { scenarios: ['配置自动应用', '异常匹配确认接受', '拒绝保留基础模板及原配置', '手动合表失败保留结果与引用', '手动合表成功保存来源引用'], confirmations: confirmations.length, hostWrites: 0, browserErrors: errors, indexFile: path.basename(indexFile) };
        fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        console.log(JSON.stringify(summary));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

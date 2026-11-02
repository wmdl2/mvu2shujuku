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
    const font = process.env.MVU_TEST_FONT;
    const fontCss = font ? '@font-face{font-family:TestChinese;src:url(data:font/ttf;base64,' + fs.readFileSync(font).toString('base64') + ')}' : '';
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    let page;
    try {
        page = await browser.newPage({ acceptDownloads: true });
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
        await page.addStyleTag({ content: fontCss + 'body{margin:0;background:#202020;color:#ddd;font:14px TestChinese,sans-serif}button,input,select,textarea{font:inherit}*{box-sizing:border-box}' + core.extensionStyle() });
        await page.addScriptTag({ content: fs.readFileSync(indexFile, 'utf8') });
        await page.evaluate(() => {
            const core = window.MVU2SHUJUKU_CORE, convert = core.convertWithRemoteSchemas;
            window.__profileTest.conversions = 0;
            core.convertWithRemoteSchemas = async (...args) => {
                window.__profileTest.conversions++;
                return convert(...args);
            };
        });
        assert.strictEqual(await page.locator('#mvu2shujuku-convert-file').isDisabled(), true);
        const drop = async name => page.evaluate(({ name, card }) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([JSON.stringify(card)], name, { type: 'application/json' }));
            document.querySelector('#mvu2shujuku-file').closest('.mvu2shujuku-card')
                .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }, { name, card });
        await drop('拒绝.txt');
        assert.strictEqual(await page.locator('#mvu2shujuku-file').evaluate(node => node.files.length), 0);
        await drop('公开配置测试.json');
        assert.strictEqual(await page.locator('input[name="mvu2shujuku-source"][value="file"]').isChecked(), true);
        assert.strictEqual(await page.locator('#mvu2shujuku-convert-file').isDisabled(), false);
        assert.strictEqual(await page.evaluate(() => window.__profileTest.conversions), 0, '拖入不应自动转换');
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
        assert.match(await page.locator('.mvu2shujuku-version').textContent(), new RegExp(core.VERSION.replace(/\./g, '\\.')));
        const order = await page.locator('.mvu2shujuku-result').evaluate(node => [...node.children].map(child =>
            child.id === 'mvu2shujuku-actions' ? 'actions' : child.classList.contains('mvu2shujuku-report-summary') ? 'report'
                : child.classList.contains('mvu2shujuku-param-editor') ? 'settings' : child.classList.contains('mvu2shujuku-merge-section') ? 'merge' : null).filter(Boolean));
        assert.deepStrictEqual(order, ['report', 'settings', 'merge', 'actions']);
        await page.locator('.mvu2shujuku-full-report').evaluate(node => { node.open = true; });
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => { window.__copiedReport = text; } } }));
        await page.locator('.mvu2shujuku-copy-report').click();
        assert.strictEqual(await page.evaluate(() => window.__copiedReport), await page.locator('.mvu2shujuku-report').inputValue());
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
        // All conversion-level options need explicit reconversion, including when merging/exporting.
        await page.locator('#mvu2shujuku-settings details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        const notice = page.locator('.mvu2shujuku-reconvert-notice');
        for (const [selector, label] of [
            ['#mvu2shujuku-json-containers', '完整 JSON 容器'], ['#mvu2shujuku-ddl-check', 'DDL CHECK'],
            ['#mvu2shujuku-ejs-translate', '简单 EJS 翻译'], ['#mvu2shujuku-placeholder', '状态栏刷新'],
        ]) {
            const control = page.locator(selector), before = await control.isChecked();
            await control.setChecked(!before);
            assert.strictEqual(await notice.isVisible(), true);
            assert.ok((await notice.innerText()).includes(label));
            await control.setChecked(before);
            assert.strictEqual(await notice.isVisible(), false);
        }
        await page.locator('#mvu2shujuku-shim').selectOption('no');
        assert.match(await notice.innerText(), /MVU 兼容层/);
        await page.locator('#mvu2shujuku-shim').selectOption('auto');
        assert.strictEqual(await notice.isVisible(), false);
        await page.locator('#mvu2shujuku-png').selectOption('png');
        assert.strictEqual(await notice.isVisible(), false, '输出格式无需重新转换');
        assert.match(await page.locator('[data-file-kind="card"]').textContent(), /PNG/);
        await page.locator('#mvu2shujuku-png').selectOption('json');
        const row = page.locator('.mvu2shujuku-table-row').first();
        await row.locator('.mvu2shujuku-param-select').selectOption('contextDepth');
        await row.locator('.mvu2shujuku-param-value').fill('11');
        await row.locator('.mvu2shujuku-param-value').blur();
        assert.match(await row.locator('.mvu2shujuku-row-summary').innerText(), /上下文.*11/);
        const edited = await downloadTemplate();
        await page.locator('#mvu2shujuku-ddl-check').uncheck();
        assert.match(await notice.innerText(), /DDL CHECK/);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator('#mvu2shujuku-settings').evaluate(node => { node.style.width = '314px'; });
        const narrow = await page.locator('#mvu2shujuku-settings').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
        assert.ok(narrow.scroll <= narrow.width + 1, JSON.stringify(narrow));
        await page.locator('#mvu2shujuku-settings details').evaluateAll(nodes => nodes.forEach(node => {
            node.open = node.classList.contains('mvu2shujuku-attention') || node.classList.contains('mvu2shujuku-param-editor');
        }));
        await page.evaluate(() => document.fonts.ready);
        for (const theme of [
            { name: 'dark', fg: '#dddddd', bg: '#202020', tint: '#242424', border: '#555555', accent: '#79bbd1' },
            { name: 'light', fg: '#252525', bg: '#ffffff', tint: '#f7f8fa', border: '#bbbbbb', accent: '#167a9c' },
            { name: 'custom', fg: '#fff4fb', bg: '#2e1830', tint: '#3c213c', border: '#aa6f9b', accent: '#f2a3dd' },
        ]) {
            await page.evaluate(theme => {
                const root = document.documentElement;
                for (const [name, value] of Object.entries({ BodyColor: theme.fg, BlurTintColor: theme.tint, BorderColor: theme.border, QuoteColor: theme.accent })) {
                    root.style.setProperty('--SmartTheme' + name, value);
                }
                document.body.style.backgroundColor = theme.bg;
                document.body.style.color = theme.fg;
            }, theme);
            const geometry = await page.locator('#mvu2shujuku-settings').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
            assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify({ theme: theme.name, ...geometry }));
            await page.screenshot({ path: path.join(work, 'workflow-' + theme.name + '.png'), fullPage: true });
        }
        const downloadArtifact = async kind => {
            const pending = page.waitForEvent('download');
            await page.locator('#mvu2shujuku-downloads button[data-file-kind="' + kind + '"]').click();
            const file = await pending;
            const target = path.join(work, 'artifact-' + (++downloadId) + '-' + kind + '.txt');
            await file.saveAs(target);
            return fs.readFileSync(target, 'utf8');
        };
        const downloadedCard = JSON.parse(await downloadArtifact('card'));
        const cardData = downloadedCard.data || downloadedCard;
        const templateEntry = cardData.character_book.entries.find(entry => entry.keys.includes('__ACU_TEMPLATE_DATA__'));
        assert.deepStrictEqual(JSON.parse(Buffer.from(templateEntry.content, 'base64').toString('utf8')), edited);
        const downloadedBridge = await downloadArtifact('bridge');
        assert.ok(cardData.extensions.tavern_helper.scripts.some(script => script.content === downloadedBridge));
        assert.deepStrictEqual(await downloadTemplate(), edited);
        assert.strictEqual(await row.locator('.mvu2shujuku-param-value').inputValue(), '11');
        const conversionsBeforeCancel = await page.evaluate(() => window.__profileTest.conversions);
        decisions.push(false);
        await notice.locator('button').click();
        assert.strictEqual(await page.evaluate(() => window.__profileTest.conversions), conversionsBeforeCancel);
        assert.strictEqual(await row.locator('.mvu2shujuku-param-value').inputValue(), '11');
        assert.strictEqual(await notice.isVisible(), true);
        assert.match(confirmations[confirmations.length - 1], /未保存的表格修改/);
        // 保存真实实现：创建接口暂停期间验证弹窗、禁用与再次派发事件的门禁。
        await page.evaluate(() => {
            const ctx = SillyTavern.getContext();
            const state = window.__saveProgressTest = { creates: 0, popups: [], stored: null };
            // Browser host substitute: exercise the real save/storage adapters, supplying the
            // worldbook module and HTTP responses that a full SillyTavern host would provide.
            ctx.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
            const storageFactory = window.MVU2SHUJUKU_CORE.getWorldbookStorageFactory();
            const books = {}, worldModule = {
                convertCharacterBook: book => ({ entries: Object.fromEntries(book.entries.map(entry =>
                    [entry.id, { content: entry.content, disable: !entry.enabled }])), originalData: structuredClone(book) }),
                worldInfoCache: new Map(), updateWorldInfoList: async () => {},
            };
            window.MVU2SHUJUKU_CORE.getWorldbookStorageFactory = () => deps => storageFactory({
                ...deps, loadModule: async () => worldModule,
            });
            ctx.POPUP_TYPE = { TEXT: 1 };
            ctx.callGenericPopup = html => { state.popups.push(html); };
            ctx.createCharacterData = async (_form, _avatar, card) => {
                state.creates++;
                state.stored = structuredClone(card.data || card);
                await new Promise(resolve => { state.release = resolve; });
                return 'saved-progress.png';
            };
            ctx.getCharacters = async () => [{ ...state.stored, avatar: 'saved-progress.png' }];
            ctx.writeExtensionField = async (_index, key, value) => { state.stored.extensions[key] = structuredClone(value); };
            window.fetch = async (url, options) => {
                const body = options && options.body ? JSON.parse(options.body) : {};
                if (url === '/api/settings/get') return { ok: true, json: async () => ({ world_names: Object.keys(books) }) };
                if (url === '/api/worldinfo/edit') { books[body.name] = structuredClone(body.data); return { ok: true }; }
                if (url === '/api/worldinfo/get') return { ok: true, json: async () => structuredClone(books[body.name]) };
                if (url === '/api/characters/get') return { ok: true, json: async () => ({ data: structuredClone(state.stored) }) };
                throw new Error('意外请求：' + url);
            };
        });
        const saveButton = page.locator('#mvu2shujuku-save-card');
        await saveButton.click();
        await page.waitForFunction(() => window.__saveProgressTest.creates === 1);
        const stored = await page.evaluate(() => window.__saveProgressTest.stored);
        const savedTemplateEntry = stored.character_book.entries.find(entry => entry.keys.includes('__ACU_TEMPLATE_DATA__'));
        assert.deepStrictEqual(JSON.parse(Buffer.from(savedTemplateEntry.content, 'base64').toString('utf8')), edited);
        assert.strictEqual(await saveButton.isDisabled(), true);
        assert.strictEqual(await page.locator('#mvu2shujuku-convert-file').isDisabled(), true);
        await page.locator('.mvu2shujuku-operation-overlay').waitFor({ state: 'visible' });
        assert.match(await page.locator('.mvu2shujuku-operation-overlay').innerText(), /正在保存角色卡.*写入角色卡/s);
        await page.evaluate(() => document.querySelector('#mvu2shujuku-save-card').dispatchEvent(new Event('click')));
        assert.strictEqual(await page.evaluate(() => window.__saveProgressTest.creates), 1);
        await page.evaluate(() => window.__saveProgressTest.release());
        await page.waitForFunction(() => window.__saveProgressTest.popups.some(s => s.includes('保存完成')));
        assert.strictEqual(await page.locator('.mvu2shujuku-operation-overlay').count(), 0);
        assert.strictEqual(await saveButton.isDisabled(), false);
        assert.strictEqual(await page.locator('#mvu2shujuku-convert-file').isDisabled(), false);
        assert.strictEqual(await page.locator('#mvu2shujuku-save-status').textContent(), '已保存到酒馆');
        await row.locator('.mvu2shujuku-param-value').fill('12');
        await row.locator('.mvu2shujuku-param-value').blur();
        assert.match(await page.locator('#mvu2shujuku-save-status').textContent(), /有未保存的修改/);
        await page.evaluate(() => {
            SillyTavern.getContext().createCharacterData = async () => { throw new Error('公开 UI 保存失败'); };
        });
        await saveButton.click();
        await page.locator('[data-worldbook-action="update"]').click();
        await page.waitForFunction(() => window.__saveProgressTest.popups.some(s => s.includes('公开 UI 保存失败')));
        assert.strictEqual(await page.locator('.mvu2shujuku-operation-overlay').count(), 0);
        assert.strictEqual(await saveButton.isDisabled(), false);
        assert.match(await page.locator('#mvu2shujuku-save-status').textContent(), /有未保存的修改/, '失败不能沿用上次保存成功的标记');
        await page.locator('#mvu2shujuku-profile-select').selectOption('');
        decisions.push(true);
        await notice.locator('button').click();
        await page.waitForFunction(count => window.__profileTest.conversions === count + 1, conversionsBeforeCancel);
        await page.locator('.mvu2shujuku-operation-overlay').waitFor({ state: 'hidden' });
        assert.strictEqual(await notice.isVisible(), false);
        decisions.push(true); // 新结果导出时，明确同意替换同名配置。
        assert.notDeepStrictEqual(await downloadTemplate(), edited, '确认后才应用新规则并生成新结果');
        await page.waitForFunction(() => document.querySelector('#mvu2shujuku-profile-select').value !== '');
        assert.deepStrictEqual(decisions, []);
        assert.deepStrictEqual(errors, []);
        const summary = { scenarios: ['配置自动应用', '异常匹配确认接受', '拒绝保留基础模板及原配置', '手动合表失败保留结果与引用', '手动合表成功保存来源引用'], confirmations: confirmations.length, hostWrites: 0, browserErrors: errors, indexFile: path.basename(indexFile) };
        summary.saveProgress = { duplicateCreates: 0, successCleanup: true, failureCleanup: true, failedSaveKeepsDirty: true };
        summary.workflow = { dropSelectsWithoutConverting: true, copiesReport: true, resultOrder: order, optionsStayFrozenAcrossExportsAndSave: true, cancelKeepsEdits: true, confirmedReconvertAppliesOptions: true };
        fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        console.log(JSON.stringify(summary));
    } catch (error) {
        if (page && !page.isClosed()) {
            const state = await page.evaluate(() => ({
                messages: window.__profileTest && window.__profileTest.messages,
                save: window.__saveProgressTest && { creates: window.__saveProgressTest.creates, popups: window.__saveProgressTest.popups },
                result: document.querySelector('.mvu2shujuku-result')?.innerText,
            })).catch(e => ({ captureError: e.message }));
            fs.writeFileSync(path.join(work, 'failure.json'), JSON.stringify({ error: error.stack, state }, null, 2) + '\n');
            await page.screenshot({ path: path.join(work, 'failure.png'), fullPage: true }).catch(() => {});
        }
        throw error;
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

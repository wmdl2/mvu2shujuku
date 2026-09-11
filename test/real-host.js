#!/usr/bin/env node
'use strict';
// 独立实机验收，不由 run-tests 自动执行。使用公开合成卡与隔离用户目录。
// Node 22；上游源码/已安装依赖默认取工作区参考资料，可用 MVU_REFERENCE_ROOT 指定。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const assert = require('assert');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const work = process.env.MVU_HOST_TEST_DIR || path.join(root, '.tools/real-host');
const data = path.join(work, 'data');
const port = Number(process.env.MVU_HOST_TEST_PORT || 18173);
const url = 'http://127.0.0.1:' + port;
const spCommit = process.env.MVU_SP_TEST_COMMIT || '5c53f795832b194ec4baa74135e8ebd950122438';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const core = require('../src/mvu2shujuku');
const syntheticCard = require('./synthetic-card');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
let storageMode = 'native';
function record(name, detail) {
    results.push({ name, storageMode, detail });
    console.log('PASS', name, JSON.stringify(detail || {}));
    const report = JSON.stringify({ runId, spCommit, results }, null, 2);
    fs.writeFileSync(path.join(work, 'results.json'), report);
    fs.writeFileSync(path.join(work, 'results-' + runId + '.json'), report);
}
function install() {
    console.log('准备隔离酒馆与固定版本扩展…');
    fs.mkdirSync(work, { recursive: true });
    const stampFile = path.join(work, 'installed.json');
    const installed = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile)) : {};
    const extensions = path.join(data, 'default-user/extensions');
    fs.mkdirSync(extensions, { recursive: true });
    const obsoleteDirectory = path.join(extensions, 'prompt-template');
    const archivedDirectory = path.join(work, 'unused-prompt-template');
    if (fs.existsSync(obsoleteDirectory) && !fs.existsSync(archivedDirectory)) fs.renameSync(obsoleteDirectory, archivedDirectory);
    for (const [repo, name] of [['JS-Slash-Runner', 'tavern-helper'], ['ST-Prompt-Template', 'ST-Prompt-Template']]) {
        const dest = path.join(extensions, name);
        const revision = cp.execFileSync('git', ['-C', path.join(refs, repo), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() + '|assets-v2';
        if (installed[name] === revision && fs.existsSync(path.join(dest, 'manifest.json'))) continue;
        fs.mkdirSync(dest, { recursive: true });
        for (const item of ['dist', 'i18n', 'locales', 'lib', 'libs', 'include', 'settings.html']) {
            const source = path.join(refs, repo, item);
            if (fs.existsSync(source)) fs.cpSync(source, path.join(dest, item), { recursive: true });
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(refs, repo, 'manifest.json')));
        manifest.auto_update = false;
        fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest));
        installed[name] = revision;
    }
    const sp = path.join(extensions, 'sp-database');
    fs.mkdirSync(sp, { recursive: true });
    if (installed.sp !== spCommit || !fs.existsSync(path.join(sp, 'index.js'))) {
        const archive = cp.execFileSync('git', ['-C', path.join(refs, 'shujuku'), 'archive', spCommit, 'index.js', 'manifest.json', 'dist'], { maxBuffer: 128 * 1024 * 1024 });
        cp.execFileSync('tar', ['-xf', '-', '-C', sp], { input: archive });
        installed.sp = spCommit;
    }
    fs.writeFileSync(stampFile, JSON.stringify(installed, null, 2));
    cp.execFileSync(process.execPath, [path.join(root, 'build-extension.js'), path.join(extensions, 'mvu2shujuku')]);
}
async function reachable() {
    return new Promise(resolve => {
        const request = http.get(url, response => { response.resume(); resolve(true); });
        request.on('error', () => resolve(false));
        request.setTimeout(1000, () => { request.destroy(); resolve(false); });
    });
}
async function waitGold(page, gold) {
    await page.waitForFunction(value => window.Mvu?.getMvuData?.()?.stat_data?.状态?.金币 === value, gold, { timeout: 45000 });
}
async function waitCommittedGold(page, gold) {
    await page.waitForFunction(value => Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).some(table =>
        table?.name === '状态表' && Number(table.content?.[1]?.[table.content?.[0]?.indexOf('金币')]) === value), gold, { timeout: 45000 });
    await waitGold(page, gold);
    await page.waitForTimeout(2000);
}
async function openState(page, state) {
    await page.waitForFunction(avatar => window.SillyTavern?.getContext().characters?.some(ch => ch.avatar === avatar), state.avatar, { timeout: 90000 });
    await page.evaluate(async state => {
        const ctx = window.SillyTavern.getContext();
        await ctx.selectCharacterById(ctx.characters.findIndex(ch => ch.avatar === state.avatar));
        if (window.SillyTavern.getContext().chatId !== state.chat) await window.SillyTavern.getContext().openCharacterChat(state.chat);
    }, state);
}
async function runtimeTest(page) {
    const card = core.convert(syntheticCard(), { mode: 'both', installMvuShim: true }).card;
    const imported = await page.evaluate(async card => {
        const { token } = await (await fetch('/csrf-token')).json();
        const form = new FormData();
        form.append('avatar', new File([JSON.stringify(card)], 'public-test.json', { type: 'application/json' }));
        form.append('file_type', 'json');
        const response = await fetch('/api/characters/import', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: form });
        if (!response.ok) throw new Error('import HTTP ' + response.status);
        return response.json();
    }, card);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const avatar = imported.file_name + '.png';
    await page.waitForFunction(avatar => window.SillyTavern?.getContext().characters.some(ch => ch.avatar === avatar), avatar, { timeout: 90000 });
    await page.evaluate(avatar => { const ctx = window.SillyTavern.getContext(); return ctx.selectCharacterById(ctx.characters.findIndex(ch => ch.avatar === avatar)); }, avatar);
    await page.waitForFunction(() => window.Mvu?.getMvuData?.()?.stat_data?.背包?.length === 4 && window.SillyTavern.getContext().chat.some(m => m.TavernDB_ACU_IsolatedData), {}, { timeout: 90000 });
    await waitCommittedGold(page, 10);
    const state = { avatar, chat: await page.evaluate(() => window.SillyTavern.getContext().chatId) };
    record('new-chat', await page.evaluate(() => window.Mvu.getMvuData().stat_data));
    assert.strictEqual(await page.evaluate(async () => {
        const value = window.Mvu.getMvuData(); value.stat_data.状态.金币 = 37;
        value.stat_data.背包 = ['新钥匙', 1, false, null, { 奖励: 1 }];
        return window.Mvu.replaceMvuData(value);
    }), true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.TavernHelper && window.MVU2SHUJUKU_CORE, {}, { timeout: 90000 });
    await openState(page, state); await waitCommittedGold(page, 37);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.背包), ['新钥匙', 1, false, null, { 奖励: 1 }]);
    record('write-reload', state);
    fs.writeFileSync(path.join(work, 'state.json'), JSON.stringify(state));
    return state;
}
async function historyTest(page, state) {
    await openState(page, state); await waitCommittedGold(page, 37);
    const second = 'MVU公开第二聊天-' + Date.now();
    await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), second);
    await waitCommittedGold(page, 10);
    assert.strictEqual(await page.evaluate(async () => { const next = window.Mvu.getMvuData(); next.stat_data.状态.金币 = 77; return window.Mvu.replaceMvuData(next); }), true);
    await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), state.chat); await waitCommittedGold(page, 37);
    await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), second); await waitCommittedGold(page, 77);
    record('chat-isolation', { A: 37, B: 77 });
    await page.evaluate(async () => { const st = await import('/script.js'); await st.swipe_right(); });
    await waitCommittedGold(page, 20);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.背包), []);
    record('greeting-swipe', { gold: 20, bag: [] });
    await page.evaluate(() => window.TavernHelper.createChatMessages([{ role: 'assistant', message: '快速删除。<UpdateVariable>_.set("状态.金币",29);</UpdateVariable>' }]));
    await waitGold(page, 29); // 刻意在合并窗口中删除，不等待提交。
    await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 1'));
    await waitCommittedGold(page, 20); record('delete-pending', { gold: 20 });
    await page.evaluate(() => window.TavernHelper.createChatMessages([{ role: 'assistant', message: '持久化后删除。<UpdateVariable>_.set("状态.金币",31);</UpdateVariable>' }]));
    await waitCommittedGold(page, 31);
    assert.strictEqual(await page.evaluate(() => !!window.SillyTavern.getContext().chat[1]?.TavernDB_ACU_IsolatedData), true, '消息更新必须持久化在本楼');
    await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 1'));
    await waitCommittedGold(page, 20); record('delete-committed', { gold: 20 });
}
async function regenerateTest(page, state) {
    await openState(page, state);
    await page.evaluate(() => window.SillyTavern.getContext().openCharacterChat('MVU公开重生成-' + Date.now()));
    await waitCommittedGold(page, 10);
    await page.evaluate(() => window.TavernHelper.createChatMessages([{ role: 'user', message: '继续测试。' }, { role: 'assistant', message: '原回复。<UpdateVariable>_.set("状态.金币",23);</UpdateVariable>' }]));
    await waitCommittedGold(page, 23);
    let requests = 0;
    const pattern = '**/api/backends/chat-completions/generate';
    await page.route(pattern, async route => {
        requests += 1;
        await sleep(2500);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'isolated-fixture', object: 'chat.completion', model: 'isolated-fixture', choices: [{ index: 0, message: { role: 'assistant', content: '重生成回复。<UpdateVariable>_.add("状态.金币",5);</UpdateVariable>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
    });
    try {
        await page.evaluate(async () => {
            const st = await import('/script.js'), oa = await import('/scripts/openai.js');
            oa.oai_settings.chat_completion_source = 'custom'; oa.oai_settings.custom_url = location.origin + '/fixture';
            oa.oai_settings.custom_model = 'isolated-fixture'; oa.oai_settings.stream_openai = false;
            st.changeMainAPI('openai'); st.setOnlineStatus('isolated-fixture'); await st.Generate('regenerate');
        });
        await waitCommittedGold(page, 15);
        assert.strictEqual(requests, 1);
        record('regenerate', { baseline: 10, replaced: 23, regenerated: 15, backend: 'Playwright fixed response', requests });
        await page.evaluate(async () => { const st = await import('/script.js'); await st.Generate('regenerate'); });
        await waitCommittedGold(page, 15);
        assert.strictEqual(requests, 2);
        assert.strictEqual(await page.evaluate(() => !!window.SillyTavern.getContext().chat.at(-1)?.TavernDB_ACU_IsolatedData), true);
        record('regenerate-identical', { baseline: 10, regenerated: 15, requests });
    } finally { await page.unroute(pattern); }
}
async function uiTest(page) {
    await page.locator('#extensions-settings-button').click();
    await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
    await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
    await page.locator('#mvu2shujuku-file').setInputFiles({ name: 'public-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(syntheticCard())) });
    await page.locator('#mvu2shujuku-convert-file').click();
    const parameter = page.locator('.mvu2shujuku-param-grid .mvu2shujuku-param-value').first();
    await parameter.waitFor({ timeout: 30000 });
    await parameter.fill('7');
    const buttons = page.locator('#mvu2shujuku-downloads button');
    console.log('DOWNLOAD_BUTTONS', await buttons.allTextContents());
    const [bridge] = await Promise.all([page.waitForEvent('download'), buttons.filter({ hasText: '数据桥源码' }).click()]);
    const bridgeText = fs.readFileSync(await bridge.path(), 'utf8');
    new vm.Script(bridgeText); assert.ok(bridgeText.includes('registerCard'));
    record('bridge-download', { file: bridge.suggestedFilename(), bytes: Buffer.byteLength(bridgeText) });
    const [downloaded] = await Promise.all([page.waitForEvent('download'), buttons.filter({ hasText: /-DB\.json/ }).first().click()]);
    const card = JSON.parse(fs.readFileSync(await downloaded.path(), 'utf8'));
    assert.ok(card.data.name.endsWith('_数据库'));
    const entry = card.data.character_book.entries.find(entry => entry.keys?.includes('__ACU_TEMPLATE_DATA__'));
    const template = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'));
    assert.ok(Object.values(template).some(sheet => sheet?.updateConfig?.updateFrequency === 7), '参数修改必须进入下载卡内模板');
    record('json-file-roundtrip', { file: downloaded.suggestedFilename(), name: card.data.name });
    const profile = syntheticCard().data.name;
    await page.waitForFunction(name => [...document.querySelectorAll('#mvu2shujuku-profile-select option')].some(option => option.value === name), profile);
    await parameter.fill('9');
    await page.locator('#mvu2shujuku-profile-select').selectOption(profile);
    await page.locator('#mvu2shujuku-convert-file').click();
    await page.waitForFunction(() => document.querySelector('.mvu2shujuku-param-grid .mvu2shujuku-param-value')?.value === '7');
    record('conversion-profile-reuse', { profile, updateFrequency: 7 });
    const before = await page.evaluate(() => window.SillyTavern.getContext().characters.length);
    await page.locator('#mvu2shujuku-save-card').click();
    await page.waitForFunction(count => window.SillyTavern.getContext().characters.length > count, before, { timeout: 60000 });
    const savedPopup = page.locator('dialog[open]').filter({ hasText: '角色卡已保存' });
    await savedPopup.waitFor({ timeout: 60000 });
    await savedPopup.locator('.popup-button-ok').click();
    await savedPopup.waitFor({ state: 'hidden' });
    record('save-card', { count: before + 1 });
    await page.screenshot({ path: path.join(work, 'ui.png') });
}
async function sqliteTest(page) {
    await page.evaluate(() => window.AutoCardUpdaterAPI.openSettings());
    const advancedMode = page.getByRole('button', { name: '切换到高手模式', exact: true });
    if (await advancedMode.count()) await advancedMode.click();
    await page.getByRole('radio', { name: '高级设置', exact: true }).click();
    await page.getByRole('radiogroup', { name: '存储模式', exact: true }).getByRole('radio', { name: 'SQL', exact: true }).click();
    // SQL getter 还依赖聊天 runtime 发布；欢迎页没有聊天，不能在此等待 getter。
    await page.waitForTimeout(1500);
    storageMode = 'sqlite';
    const state = await runtimeTest(page);
    await page.waitForFunction(() => typeof window.AutoCardUpdaterAPI.querySql === 'function' || typeof window.AutoCardUpdaterAPI.executeSqlQuery === 'function', {}, { timeout: 120000 });
    record('storage-mode-switch', { mode: storageMode });
    await historyTest(page, state);
    await regenerateTest(page, state);
    await page.evaluate(() => window.AutoCardUpdaterAPI.openSettings());
    await page.getByRole('radio', { name: '高级设置', exact: true }).click();
    await page.getByRole('radiogroup', { name: '存储模式', exact: true }).getByRole('radio', { name: '原生', exact: true }).click();
    await page.waitForFunction(() => typeof window.AutoCardUpdaterAPI.querySql !== 'function' && typeof window.AutoCardUpdaterAPI.executeSqlQuery !== 'function', {}, { timeout: 60000 });
    storageMode = 'native'; record('storage-mode-restored', { mode: storageMode });
}
async function main() {
    install();
    const reuseServer = process.argv.includes('--reuse-server');
    const keepServer = process.argv.includes('--keep-server');
    const running = await reachable();
    if (running && !reuseServer) throw new Error('测试端口已被占用；请使用 MVU_HOST_TEST_PORT 指定空闲端口');
    if (!running && reuseServer) throw new Error('指定复用的测试服务器未启动');
    const log = fs.openSync(path.join(work, 'server.log'), 'a');
    const server = running ? null : cp.spawn(process.execPath, ['server.js', '--port', String(port), '--browserLaunchEnabled', 'false', '--dataRoot', data, '--configPath', path.join(work, 'config.yaml')], { cwd: path.join(refs, 'SillyTavern'), stdio: ['ignore', log, log], detached: keepServer });
    if (server) fs.writeFileSync(path.join(work, 'server.pid'), String(server.pid));
    let browser;
    try {
        const start = Date.now(); let lastNotice = start;
        while (!await reachable()) {
            if (server && server.exitCode !== null) throw new Error('测试酒馆退出，请检查 ' + path.join(work, 'server.log'));
            if (Date.now() - start > 600000) throw new Error('测试酒馆启动超时');
            if (Date.now() - lastNotice > 30000) { console.log('等待隔离酒馆启动…'); lastNotice = Date.now(); }
            await sleep(1000);
        }
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => { errors.push(error.message); console.log('PAGEERROR', error.message); });
        page.on('console', message => { if (message.type() === 'error') console.log('BROWSER_ERROR', message.text().slice(0, 700)); });
        page.on('response', response => { if (response.status() >= 400) console.log('HTTP_ERROR', response.status(), response.url()); });
        page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? dialog.defaultValue() : undefined));
        await page.route('**/api/settings/get', async route => { const response = await route.fetch(); const settings = await response.json(); settings.enable_extensions_auto_update = false; await route.fulfill({ response, json: settings }); });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        let onboardingDone = false;
        const onboarding = (async () => {
            while (!onboardingDone) {
                if (await page.locator('.popup-input:visible').count()) {
                    await page.locator('.popup-input:visible').fill('公开验收用户');
                    await page.locator('.popup-button-ok:visible').click();
                }
                await sleep(500);
            }
        })();
        try {
            await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.TavernHelper && window.EjsTemplate && window.MVU2SHUJUKU_CORE, {}, { timeout: 120000 });
        } catch (error) {
            console.log('STARTUP_STATE', await page.evaluate(() => ({ acu: !!window.AutoCardUpdaterAPI, helper: !!window.TavernHelper, ejs: !!window.EjsTemplate, converter: !!window.MVU2SHUJUKU_CORE, text: document.body.innerText.slice(0, 2000) })));
            throw error;
        } finally { onboardingDone = true; await onboarding; }
        await page.waitForTimeout(4000);
        if (await page.locator('.popup-input:visible').count()) { await page.locator('.popup-input:visible').fill('公开验收用户'); await page.locator('.popup-button-ok:visible').click(); }
        await page.locator('.popup-input:visible').waitFor({ state: 'hidden', timeout: 30000 });
        await page.waitForFunction(() => window.SillyTavern.getContext().characters.length > 0, {}, { timeout: 60000 });
        console.log('HOST_READY', await page.evaluate(() => document.body.innerText.slice(0, 90)));
        try {
            const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
            const saved = path.join(work, 'state.json');
            const state = only && fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved)) : await runtimeTest(page);
            if (!only || only === 'history') await historyTest(page, state);
            if (!only || only === 'regenerate') await regenerateTest(page, state);
            if (!only || only === 'ui') await uiTest(page);
            if (!only || only === 'sqlite') await sqliteTest(page);
            assert.deepStrictEqual(errors, []);
            record('browser-errors', errors);
        } catch (error) {
            fs.writeFileSync(path.join(work, 'failure.json'), JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText.slice(0, 2500), stat: window.Mvu?.getMvuData?.()?.stat_data, chat: window.SillyTavern?.getContext().chat })), null, 2));
            await page.screenshot({ path: path.join(work, 'failure.png') });
            throw error;
        }
    } finally {
        if (browser) await browser.close();
        if (server) {
            if (keepServer) { server.unref(); console.log('保留隔离测试服务器 PID', server.pid); }
            else server.kill();
        }
        fs.closeSync(log);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

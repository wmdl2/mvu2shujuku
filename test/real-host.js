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
const vwdCard = require('./vwd-card');
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
async function runtimeTest(page, source = syntheticCard(), convertCore = core, modeLabel = '') {
    const card = convertCore.convert(source, { mode: 'both', installMvuShim: true }).card;
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
    record('new-chat' + (modeLabel ? '-' + modeLabel : ''), await page.evaluate(() => window.Mvu.getMvuData().stat_data));
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
async function publicApiTest(page, state) {
    await openState(page, state);
    const chat = 'MVU公开API语义-' + Date.now();
    await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
    await waitCommittedGold(page, 10);
    const observed = await page.evaluate(async () => {
        const mvu = window.Mvu;
        const ordinaryArray = mvu.getMvuVariable({stat_data: {items: [10, 20]}}, 'items');
        const data = mvu.getMvuData();
        let listenerDone = false;
        // TH 的 iframe eventOn 最终注册在宿主 eventSource（TH 4.9.5 event.ts）。
        // 主窗口既没有公开 TavernHelper.eventOn，也可能只有 DOM eventOn 兜底。
        const eventSource = window.SillyTavern.getContext().eventSource;
        const listener = async (stat, path) => {
            if (path !== '状态["金币"]') return;
            await new Promise(resolve => setTimeout(resolve, 30));
            stat.状态.生命 = 73;
            listenerDone = true;
        };
        eventSource.on(mvu.events.SINGLE_VARIABLE_UPDATED, listener);
        let ok;
        try { ok = await mvu.setMvuVariable(data, '状态["金币"]', 41, {is_recursive: true}); }
        finally { eventSource.removeListener(mvu.events.SINGLE_VARIABLE_UPDATED, listener); }
        const doneWhenReturned = listenerDone;
        const bracketRead = mvu.getMvuVariable(data, '状态["金币"]');
        if (!ok || !doneWhenReturned) throw new Error('公共 API 未等待 TH 业务监听器完成: ' + JSON.stringify({ok, doneWhenReturned}));
        if (await mvu.replaceMvuData(data) !== true) throw new Error('公共 API 写回失败');
        return {ordinaryArray, bracketRead, doneWhenReturned};
    });
    assert.deepStrictEqual(observed, {ordinaryArray: [10, 20], bracketRead: 41, doneWhenReturned: true});
    await waitCommittedGold(page, 41);
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.TavernHelper && window.MVU2SHUJUKU_CORE, {}, {timeout: 90000});
    await openState(page, {...state, chat});
    await waitCommittedGold(page, 41);
    assert.strictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态.生命), 73);
    record('public-api-async-persistence', observed);
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
    const source = require('./frontend-card')();
    await page.locator('#extensions-settings-button').click();
    await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
    await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
    await page.locator('#mvu2shujuku-file').setInputFiles({ name: 'public-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
    await page.locator('#mvu2shujuku-convert-file').click();
    const parameter = page.locator('.mvu2shujuku-param-grid .mvu2shujuku-param-value').first();
    await parameter.waitFor({ timeout: 30000 });
    const frontend = require('./frontend-host');
    const editedTables = await frontend.exerciseEditor(page);
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
    frontend.verifyTemplate(template, editedTables);
    record('frontend-selected-settings', { uids: editedTables.uids, report: editedTables.report });
    record('json-file-roundtrip', { file: downloaded.suggestedFilename(), name: card.data.name });
    const profile = source.data.name;
    await page.waitForFunction(name => [...document.querySelectorAll('#mvu2shujuku-profile-select option')].some(option => option.value === name), profile);
    await parameter.fill('9');
    await page.locator('#mvu2shujuku-profile-select').selectOption(profile);
    await page.locator('#mvu2shujuku-convert-file').click();
    await page.waitForFunction(() => document.querySelector('.mvu2shujuku-param-grid .mvu2shujuku-param-value')?.value === '7');
    record('conversion-profile-reuse', { profile, updateFrequency: 7 });
    record('frontend-injection-profile-and-mobile', await frontend.verifyProfileAndLayout(page, editedTables, work));
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
// SP 在 AI 填表进行中会拒绝外部表格写入（isAutoUpdatingCard 门禁），表现为
// replaceMvuData 返回 false 且不落库。这不是 VWD 拒绝，而是宿主填充锁还没释放；
// 与扩展自身的合并层一样按重试处理，不要用固定 sleep 猜时间。
async function replaceMvuDataWhenIdle(page, mutate, label) {
    for (let i = 0; i < 60; i++) {
        const ok = await page.evaluate(mutate);
        if (ok) return true;
        await page.waitForTimeout(500);
    }
    throw new Error((label || '写库') + ' 持续失败：宿主 AI 填表锁未释放或写入被拒绝');
}
// SP 的 triggerUpdate 在上一轮填表未结束时会直接返回 false；先等空闲再触发一次。
async function triggerFillWhenIdle(page, label) {
    for (let i = 0; i < 40; i++) {
        const result = await page.evaluate(() => window.AutoCardUpdaterAPI.triggerUpdate());
        if (result) return result;
        await page.waitForTimeout(500);
    }
    throw new Error((label || '填表') + ' 触发失败：SP 持续报告已有更新任务在进行中');
}
// VWD 返工后的实机验收：默认关闭必须让宿主持有与交接前相同的结构与写入行为。
// 实验能力（元数据列、vwd 槽位、说明拒绝）不在宿主启用，因此这里不产生覆盖数据；
// 实验路径的契约由 Node 合成回归覆盖（test/vwd-descriptions.js）。native 与 SQLite 各一次。
async function vwdTest(page) {
    // 默认用当前实现转换；--vwd-baseline 时改用冻结基线转换，用来对照同一场景在
    // 交接前实现上的表现（例如 SQLite 能否 hydrate 旧式 pair 单元格）。
    const useBaseline = process.argv.includes('--vwd-baseline');
    const convertCore = useBaseline
        ? require('../.tools/vwd-handoff-2026-09-15/baseline/src/mvu2shujuku.js')
        : core;
    const source = vwdCard();
    const state = await runtimeTest(page, source, convertCore);
    // 明确按默认（关闭）转换：实验开关是进程内状态，不能依赖其它脚本没打开过。
    core.setVwdExperimental(false);
    const conversion = convertCore.convert(source, { mode: 'both' });
    const layout = JSON.parse((conversion.card.data || conversion.card).extensions.mvu2shujuku.layout);
    assert.strictEqual(layout.find(e => e.group === '好感系统').vwd, undefined, '默认转换不应带 vwd 槽位');
    const tpl = Object.values(conversion.template).find(t => t.name === '好感系统表');
    assert.ok(!tpl.content[0].includes('$说明覆盖'), '默认转换不应新增内部说明列');
    assert.doesNotMatch(tpl.sourceData.note, /\u0000VWD/, '默认 note 不应含内部插槽');
    assert.strictEqual((tpl.sourceData.note.match(/当前称呼/g) || []).length, 2, '两个字段的静态说明都应保留');

    const readSheet = () => page.evaluate(() => {
        const sheet = Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(s => s && s.name === '好感系统表');
        return { header: sheet.content[0], row: sheet.content[1] };
    });
    const probe = await page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        const ch = ctx.characters.find(c => c && c.avatar === ctx.characters[ctx.characterId]?.avatar)
            || ctx.characters.find(c => String((c.data || c).name || '').indexOf('VWD') === 0);
        const marker = (ch && (ch.data || ch).extensions && (ch.data || ch).extensions.mvu2shujuku) || {};
        const lay = marker.layout ? JSON.parse(marker.layout) : [];
        const runtime = Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(s => s && s.name === '好感系统表');
        const tplNow = window.AutoCardUpdaterAPI.getTableTemplate({ scope: 'chat' });
        const tsheet = tplNow ? Object.values(tplNow).find(s => s && s.name === '好感系统表') : null;
        return {
            avatar: ch && ch.avatar,
            markerVwd: lay.filter(e => e.vwd).map(e => ({ group: e.group, meta: e.vwd.metaCol })),
            anyVwd: lay.some(e => e.vwd),
            runtimeHeader: runtime ? runtime.content[0] : null,
            noteHasSlot: tsheet ? String(tsheet.sourceData.note || '').includes('VWD') : null,
        };
    });
    assert.strictEqual(probe.anyVwd, false, '宿主布局不应带 vwd 槽位');
    assert.ok(!probe.runtimeHeader.includes('$说明覆盖'), '宿主运行时表不应出现内部说明列');
    assert.strictEqual(probe.noteHasSlot, false, '宿主 note 不应含内部插槽');
    record('vwd-default-off-structure', probe);

    // 旧式 pair 写入修复后，pair 列只把“当前值”交给宿主，单元格里不再出现数组，
    // 因此 SQLite 可以正常 hydrate。native 与 SQLite 都跑完整写入 + 刷新验证。
    // SQLite 覆盖必须**先切模式再导入卡**（与 sqliteTest 同一顺序）：已有 native
    // 聊天再切模式会走数据迁移，失败时会静默回退，不能用来验证 SQLite 写入。
    for (const mode of ['native', 'sqlite']) {
        let modeState = state;
        if (mode === 'sqlite') {
            await setStorageMode(page, 'sqlite');
            modeState = await runtimeTest(page, source, convertCore, 'sqlite');
        }
        await assertStorageMode(page, mode, mode + ' 存储模式');
        await openState(page, modeState);
        const chat = 'VWD默认关闭-' + mode + '-' + Date.now();
        await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
        await waitCommittedGold(page, 10);

        const baseline = await page.evaluate(() => window.Mvu.getMvuData().stat_data.好感系统);
        assert.deepStrictEqual(baseline, {
            甲称呼: ['小甲', '当前称呼'], 乙称呼: ['小乙', '当前称呼'], 描述: ['暂无', ''], 数字: 3,
        }, mode + ' 初始读回应保持 pair 形状与静态说明');

        const consoleErrors = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        const requestsBefore = await captureFill(page, 'vwd-before-' + mode + '-' + runId + '.txt');
        assert.match(requestsBefore.prompt, /- 乙称呼：当前称呼/, mode + ' 提示词应保留静态说明');
        assert.doesNotMatch(requestsBefore.prompt, /说明覆盖|shuomingfugai|kuozhanshuju/, mode + ' 不应出现 VWD 内部列');

        // 改说明：默认关闭时不引入拒绝策略（说明按原 pair 语义写入），且不产生说明覆盖。
        const descWrite = await replaceMvuDataWhenIdle(page, () => {
            const data = window.Mvu.getMvuData();
            data.stat_data.好感系统.乙称呼 = ['小乙', '已完成委托，好感上限提高'];
            return window.Mvu.replaceMvuData(data);
        }, mode + ' 改说明写入');
        assert.strictEqual(descWrite, true, mode + ' 默认关闭时说明变化不应被 VWD 拒绝');
        const afterDesc = await readSheet();
        assert.ok(!afterDesc.header.includes('$说明覆盖'), mode + ' 全程不应出现内部说明列');

        // 只改值：写库成功、刷新后仍在。
        const valueWrite = await replaceMvuDataWhenIdle(page, () => {
            const data = window.Mvu.getMvuData();
            data.stat_data.好感系统.乙称呼 = ['小乙二', '当前称呼'];
            // 同一批中更新已有数字/布尔 pair，并新增一条记录，防止只覆盖单例更新。
            data.stat_data.配对记录.甲.数值 = [3, '数值说明'];
            data.stat_data.配对记录.甲.开关 = [true, '开关说明'];
            data.stat_data.配对记录.乙 = { 数值: [2, '数值说明'], 开关: [true, '开关说明'], 称呼: ['乙', '称呼说明'] };
            return window.Mvu.replaceMvuData(data);
        }, mode + ' 只改值写入');
        assert.strictEqual(valueWrite, true, mode + ' 只改值的普通写入必须成功');
        await page.waitForFunction(() => {
            const v = window.Mvu?.getMvuData?.()?.stat_data?.好感系统?.乙称呼;
            return !!v && String(v[0]).includes('小乙二');
        }, {}, { timeout: 60000 });

        // 刷新：写入的值从数据库恢复，且不出现内部说明列。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openState(page, modeState);
        await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
        await waitCommittedGold(page, 10);
        await page.waitForFunction(() => {
            const v = window.Mvu?.getMvuData?.()?.stat_data?.好感系统?.乙称呼;
            return !!v && String(v[0]).includes('小乙二');
        }, {}, { timeout: 60000 });
        const reloaded = await page.evaluate(() => window.Mvu.getMvuData().stat_data.好感系统);
        const finalSheet = await readSheet();
        assert.ok(!finalSheet.header.includes('$说明覆盖'), mode + ' 刷新后仍不应出现内部说明列');
        assert.strictEqual(finalSheet.header.length, 6, mode + ' 表头应与交接前一致（row_id + 4 列 + 扩展数据）');
        // pair 列应只落当前值：单元格是标量文本，读回恢复 [值, 静态说明]。
        assert.strictEqual(finalSheet.row[finalSheet.header.indexOf('乙称呼')], '小乙二',
            mode + ' pair 列必须只写当前值，不得是整段数组的拼接文本');
        assert.deepStrictEqual(reloaded.乙称呼, ['小乙二', '当前称呼'], mode + ' 刷新后应恢复值 + 静态说明');
        const pairRows = await page.evaluate(() => {
            const sheet = Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(s => s && s.name === '配对记录表');
            return { readback: window.Mvu.getMvuData().stat_data.配对记录, content: sheet && sheet.content };
        });
        assert.deepStrictEqual(pairRows.readback, {
            甲: { 数值: 3, 开关: true, 称呼: ['甲', '称呼说明'] },
            乙: { 数值: 2, 开关: true, 称呼: ['乙', '称呼说明'] },
        }, mode + ' 已有行和新增行的 pair 值在刷新后必须准确恢复');
        assert.ok(Array.isArray(pairRows.content) && pairRows.content.length === 3);
        for (const row of pairRows.content.slice(1)) for (const cell of row) {
            assert.ok(typeof cell === 'string' || typeof cell === 'number', mode + ' 物理行不能遗留数组或布尔值');
        }
        record('pair-records-' + mode, pairRows);
        // SQLite 模式下确认没有回退：hydrate 失败会打印 SyncBridge/storage 错误。
        if (mode === 'sqlite') {
            await assertStorageMode(page, 'sqlite', '刷新后 SQLite 模式');
            const hydrationErrors = consoleErrors.filter(t => /sqlite_hydrate_failed|val\.replace is not a function|fallback 到原生/.test(t));
            assert.deepStrictEqual(hydrationErrors, [], 'SQLite 不得因单元格编码而回退原生');
        }
        record('vwd-' + (useBaseline ? 'baseline-' : '') + mode, {
            descWrite,
            valueWrite,
            cellAfterReload: finalSheet.row[finalSheet.header.indexOf('乙称呼')],
            readAfterReload: reloaded.乙称呼,
            prompts: requestsBefore.count,
            sqlReady: mode === 'sqlite' ? true : undefined,
        });
    }
    await setStorageMode(page, 'native');
}
// 用本地固定响应触发一次填表并回收实际请求正文。
async function captureFill(page, dumpName) {
    const requests = [];
    const pattern = '**/api/backends/chat-completions/generate';
    await page.evaluate(async () => {
        const st = await import('/script.js'), oa = await import('/scripts/openai.js');
        oa.oai_settings.chat_completion_source = 'custom'; oa.oai_settings.custom_url = location.origin + '/fixture';
        oa.oai_settings.custom_model = 'isolated-fixture'; oa.oai_settings.stream_openai = false;
        st.changeMainAPI('openai'); st.setOnlineStatus('isolated-fixture');
        await window.TavernHelper.createChatMessages([{ role: 'user', message: '继续。' }, { role: 'assistant', message: '好的。' }]);
    });
    let failure = null;
    await page.route(pattern, async route => {
        try {
            requests.push(route.request().postDataJSON());
            await route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ id: 'vwd-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '<content>继续。</content>' }, finish_reason: 'stop' }] }),
            });
        } catch (error) { failure = error; }
    });
    try {
        await triggerFillWhenIdle(page, 'VWD 固定响应填表');
        assert.ok(requests.length, '应实际产生填表请求');
    } finally { await page.unroute(pattern); }
    assert.ifError(failure);
    const prompt = requests.map(request => String(request.messages.map(m => m.content || '').join('\n'))).join('\n');
    fs.writeFileSync(path.join(work, dumpName), prompt);
    return { prompt, count: requests.length, models: requests.map(request => request.model) };
}
async function setStorageMode(page, mode) {
    await page.evaluate(() => window.AutoCardUpdaterAPI.openSettings());
    const advancedMode = page.getByRole('button', { name: '切换到高手模式', exact: true });
    if (await advancedMode.count()) await advancedMode.click();
    await page.getByRole('button', { name: '仪表盘', exact: true }).click();
    await page.getByRole('radio', { name: '高级设置', exact: true }).click();
    await page.getByRole('radiogroup', { name: '存储模式', exact: true }).getByRole('radio', { name: mode === 'sqlite' ? 'SQL' : '原生', exact: true }).click();
    // SQL getter 还依赖聊天 runtime 发布；欢迎页没有聊天，不能在此等待 getter。
    await page.waitForTimeout(1500);
    storageMode = mode;
}
// SP 在 SQLite hydrate 失败时会静默回退原生模式；断言实际生效的模式，避免把
// “回退到原生”误记成 SQLite 通过。
async function assertStorageMode(page, mode, label) {
    if (mode === 'sqlite') {
        // 切换后 SQL getter 还依赖聊天 runtime 发布，先等它出现再断言实际模式。
        await page.waitForFunction(() => typeof window.AutoCardUpdaterAPI.querySql === 'function' || typeof window.AutoCardUpdaterAPI.executeSqlQuery === 'function', {}, { timeout: 120000 });
    }
    const actual = await page.evaluate(() => {
        const sqlReady = typeof window.AutoCardUpdaterAPI.querySql === 'function' || typeof window.AutoCardUpdaterAPI.executeSqlQuery === 'function';
        const marker = (window.SillyTavern.getContext().characters.find(c => c && c.avatar === window.SillyTavern.getContext().characters[window.SillyTavern.getContext().characterId]?.avatar) || {});
        const sheet = Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(s => s && s.name === '好感系统表');
        return { sqlReady, header: sheet ? sheet.content[0] : null };
    });
    if (mode === 'sqlite') assert.strictEqual(actual.sqlReady, true, (label || '') + ' SQLite 模式未生效（可能已回退原生）');
}
async function sqliteTest(page) {
    await setStorageMode(page, 'sqlite');
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
async function nullableTest(page) {
    for (const mode of ['native', 'sqlite']) {
        await setStorageMode(page, mode);
        const source = syntheticCard();
        const stat = { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null],
            空值: { 回空: null, 空串: null, 缺失: null, 零: null, 假: null, 嵌套: { 值: null, 数值: 0 } },
            容器: { 对象: { 值: 1 }, 数组: ['a'], VWD: [null, '说明'] },
            记录: { 甲: { 值: null, 序号: 1 }, 乙: { 值: '', 序号: 2 }, 丙: { 序号: 3 } } };
        source.data.name = '空值持久化验收-' + mode;
        source.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\n空值测试。';
        source.data.alternate_greetings = [];
        source.data.character_book.entries[0].content = JSON.stringify(stat);
        source.data.extensions.tavern_helper.scripts.push({ name: '变量结构', content: 'const S = z.object({ 容器: z.object({ 对象: z.object({ 值: z.number() }).nullable(), 数组: z.array(z.string()).optional() }) }); registerMvuSchema(S);' });
        const state = await runtimeTest(page, source);
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.空值), stat.空值);
        assert.strictEqual(await page.evaluate(async () => {
            const data = window.Mvu.getMvuData();
            data.stat_data.空值.回空 = '暂存';
            return window.Mvu.replaceMvuData(data);
        }), true);
        assert.strictEqual(await page.evaluate(async () => {
            const data = window.Mvu.getMvuData();
            Object.assign(data.stat_data.空值, { 回空: null, 空串: '', 零: 0, 假: false });
            delete data.stat_data.空值.缺失;
            data.stat_data.空值.嵌套.值 = '';
            data.stat_data.记录.甲.值 = '';
            data.stat_data.记录.乙.值 = null;
            data.stat_data.记录.新 = { 值: false, 序号: 4 };
            data.stat_data.容器.对象 = null;
            delete data.stat_data.容器.数组;
            data.stat_data.容器.VWD = [false, '说明'];
            return window.Mvu.replaceMvuData(data);
        }), true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AutoCardUpdaterAPI && window.MVU2SHUJUKU_CORE, {}, { timeout: 90000 });
        await openState(page, state); await waitCommittedGold(page, 37);
        const read = await page.evaluate(() => {
            const s = window.Mvu.getMvuData().stat_data;
            return { 空值: s.空值, 记录: s.记录 };
        });
        assert.deepStrictEqual(read, { 空值: { 回空: null, 空串: '', 零: 0, 假: false, 嵌套: { 值: '', 数值: 0 } },
            记录: { 甲: { 值: '', 序号: 1 }, 乙: { 值: null, 序号: 2 }, 丙: { 序号: 3 }, 新: { 值: false, 序号: 4 } } });
        record('nullable-write-reload', read);
        assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.容器), { 对象: null, VWD: [false, '说明'] });
        assert.strictEqual(await page.evaluate(() => {
            const data = window.Mvu.getMvuData();
            data.stat_data.容器 = { 对象: { 值: 2 }, 数组: [], VWD: [null, '说明'] };
            return window.Mvu.replaceMvuData(data);
        }), true);
        await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state);
        await waitCommittedGold(page, 37);
        const containers = await page.evaluate(() => window.Mvu.getMvuData().stat_data.容器);
        assert.deepStrictEqual(containers, { 对象: { 值: 2 }, 数组: [], VWD: [null, '说明'] });
        record('nullable-container-vwd-reload', containers);
    }
    await setStorageMode(page, 'native');
}
async function jsonPathTest(page) {
    const source = syntheticCard();
    const stat = {
        状态: { 生命: 100, 金币: 10, 附属: { 左: { 值: 1 }, 右: { 值: 2 } } },
        背包: ['钥匙', 0, false, null],
        容器: {
            对象: { 数量: 1, 保留: '原样', 可空字段: null, 开关: true, 嵌套: { n: 1 }, 临时: '删除我' },
            数组: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'c', value: 3 }],
        },
    };
    source.data.name = 'SQLite JSON路径更新验收';
    source.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\nJSON 路径更新测试。';
    source.data.alternate_greetings = [];
    source.data.character_book.entries[0].content = JSON.stringify(stat);
    source.data.extensions.tavern_helper.scripts.push({ name: '变量结构', content: `const S = z.object({
        状态: z.object({ 生命: z.number(), 金币: z.number(), 附属: z.object({ 左: z.object({ 值: z.number() }), 右: z.object({ 值: z.number() }) }) }),
        容器: z.object({
            对象: z.object({ 数量: z.number(), 保留: z.string(), 可空字段: z.null(), 开关: z.boolean(), 嵌套: z.object({ n: z.number() }), 临时: z.string() }).nullable(),
            数组: z.array(z.object({ id: z.string(), value: z.number() })).optional(),
        }),
    }); registerMvuSchema(S);` });
    try {
    const state = await runtimeTest(page, source);
    await setStorageMode(page, 'sqlite');
    await openState(page, state);
    const chat = 'SQLite JSON路径-' + Date.now();
    await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
    await waitCommittedGold(page, 10);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态), stat.状态, '新聊天固定附属初值应为左 1、右 2');
    await page.evaluate(async () => {
        const st = await import('/script.js'), oa = await import('/scripts/openai.js');
        oa.oai_settings.chat_completion_source = 'custom'; oa.oai_settings.custom_url = location.origin + '/fixture';
        oa.oai_settings.custom_model = 'json-path-fixture'; oa.oai_settings.stream_openai = false;
        st.changeMainAPI('openai'); st.setOnlineStatus('json-path-fixture');
        await window.TavernHelper.createChatMessages([{ role: 'user', message: '只更新 JSON 路径和金币。' }, { role: 'assistant', message: '准备执行 JSON 路径更新。' }]);
    });
    const pattern = '**/api/backends/chat-completions/generate';
    const requests = [];
    let sql = '';
    const sqlSheet = (prompt, labels) => {
        const sheets = [...prompt.matchAll(/CREATE TABLE\s+([^\s(]+)\s*\(([\s\S]*?)\)\s*;/g)].map(match => ({ table: match[1], ddl: match[0] }));
        const sheet = sheets.find(candidate => labels.every(label => new RegExp('^\\s*([A-Za-z_][\\w]*)\\s+[^\\n]*?--\\s*' + label + '(?:\\s|$)', 'm').test(candidate.ddl)));
        assert.ok(sheet, '应从 SP 实际 DDL 和列注释定位 JSON 表：' + labels.join('、'));
        const columns = Object.fromEntries(labels.map(label => {
            const match = sheet.ddl.match(new RegExp('^\\s*([A-Za-z_][\\w]*)\\s+[^\\n]*?--\\s*' + label + '(?:\\s|$)', 'm'));
            assert.ok(match, 'DDL 缺少列注释：' + label);
            return [label, match[1]];
        }));
        return { ...sheet, columns };
    };
    await page.route(pattern, async route => {
        const request = route.request().postDataJSON(); requests.push(request);
        const tablePrompt = request.messages.map(message => String(message.content || '')).find(text => text.includes('<当前表格数据>\n')) || '';
        assert.ok(tablePrompt, '应取得 SP 实际 SQLite 表格提示段');
        assert.match(tablePrompt, /\bjson_set\s*\(/i, 'JSON 列真实提示必须说明 json_set 路径更新');
        assert.ok(!tablePrompt.includes('状态_附属表'), '固定附属对象不应拆成状态_附属表');
        const container = sqlSheet(tablePrompt, ['对象', '数组']);
        const status = sqlSheet(tablePrompt, ['金币', '附属_左_值', '附属_右_值']);
        const objectUpdate = `json_remove(json_set(json_replace(${container.columns.对象}, '$.数量', 2), '$.开关', json('false'), '$.可空字段', json('null'), '$.嵌套', json('{"n":2}')), '$.临时')`;
        const arrayUpdate = `json_set(json_remove(${container.columns.数组}, '$[1]'), '$[#]', json('{"id":"d","value":4}'))`;
        const commands = [
            `UPDATE ${container.table} SET ${container.columns.对象} = ${objectUpdate}, ${container.columns.数组} = ${arrayUpdate} WHERE row_id = 1;`,
            `UPDATE ${status.table} SET ${status.columns.金币} = 42, ${status.columns.附属_左_值} = 9 WHERE row_id = 1;`,
        ].join('\n');
        sql = commands;
        // SP 默认拒绝少于 500 字符的响应。补长说明放在协议的 thought 中，tableEdit 只保留两条写入 SQL。
        const content = '<thought>' + '公开 JSON 路径验收固定响应；仅执行下方两条 SQL。'.repeat(24)
            + '</thought><content><tableEdit>\n' + commands + '\n</tableEdit></content>';
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'json-path-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
    });
    try {
        const result = await page.evaluate(() => window.AutoCardUpdaterAPI.triggerUpdate());
        fs.writeFileSync(path.join(work, 'json-path-' + runId + '.json'), JSON.stringify({ result, requests, sql }, null, 2));
        assert.ok(requests.length, 'SP 应实际产生 JSON 路径填表请求');
        assert.strictEqual(result.success, true, '固定 JSON 路径 SQL 应成功提交');
        await waitCommittedGold(page, 42);
        const updated = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
        assert.deepStrictEqual(updated.容器, {
            对象: { 数量: 2, 保留: '原样', 可空字段: null, 开关: false, 嵌套: { n: 2 } },
            数组: [{ id: 'a', value: 1 }, { id: 'c', value: 3 }, { id: 'd', value: 4 }],
        });
        assert.deepStrictEqual(updated.状态, { 生命: 100, 金币: 42, 附属: { 左: { 值: 9 }, 右: { 值: 2 } } }, '固定附属字段应在父表读写，未涉及右值保持');
        assert.deepStrictEqual(updated.容器.数组[1], { id: 'c', value: 3 }, '另一记录必须保持');
        record('sqlite-json-path-update', { result, requests: requests.length, gold: 42, container: updated.容器 });
    } finally { await page.unroute(pattern); }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openState(page, { ...state, chat }); await waitCommittedGold(page, 42);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态), { 生命: 100, 金币: 42, 附属: { 左: { 值: 9 }, 右: { 值: 2 } } });
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.容器), {
        对象: { 数量: 2, 保留: '原样', 可空字段: null, 开关: false, 嵌套: { n: 2 } },
        数组: [{ id: 'a', value: 1 }, { id: 'c', value: 3 }, { id: 'd', value: 4 }],
    });
    await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 2'));
    await waitCommittedGold(page, 10);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态), stat.状态);
    assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.容器), stat.容器);
    record('sqlite-json-path-reload-delete', { gold: 10, container: stat.容器 });
    } finally {
        await setStorageMode(page, 'native');
    }
}
async function promptCaptureTest(page) {
    const excludeInit = process.argv.includes('--filter-initvar');
    const relationPrompts = process.argv.includes('--relation-prompts');
    const setExcludeRules = async rules => {
        await page.evaluate(() => window.AutoCardUpdaterAPI.openSettings());
        const advanced = page.getByRole('button', { name: '切换到高手模式', exact: true });
        if (await advanced.count()) await advanced.click();
        await page.getByRole('button', { name: '填表规则', exact: true }).click();
        const area = page.locator('.acu-rule-pair-list').filter({ has: page.getByText('排除规则', { exact: true }) });
        await area.waitFor();
        if (!await area.getByRole('button', { name: '添加排除规则' }).isVisible()) await area.locator('.acu-rule-pair-list__header').click();
        const previous = await area.locator('.acu-rule-pair-list__row').evaluateAll(rows => rows.map(row => ({
            start: row.querySelector('input[placeholder="排除开始边界"]').value,
            end: row.querySelector('input[placeholder="排除结束边界"]').value,
        })));
        if (rules) {
            while (await area.getByTitle('删除此规则').count()) await area.getByTitle('删除此规则').first().click();
            for (const rule of rules) {
                await area.getByRole('button', { name: '添加排除规则' }).click();
                const row = area.locator('.acu-rule-pair-list__row').last();
                await row.getByPlaceholder('排除开始边界').fill(rule.start);
                await row.getByPlaceholder('排除结束边界').fill(rule.end);
            }
        }
        return previous;
    };
    const source = relationPrompts ? require('./prompt-guidance-card')() : syntheticCard();
    source.data.name = '提示词投影验收';
    const stat = relationPrompts ? JSON.parse(source.data.character_book.entries[0].content) : { 状态: { 生命: 100, 金币: 10, $private: 'PRIVATE_CANARY_731', _只读: 'VISIBLE_READONLY_832' },
        背包: ['钥匙', 0, false, null], A: { value: 1, bag: [1, 2, 3] }, B: { value: 2, bag: [4, 5, 6] } };
    source.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>公开测试开场。';
    source.data.alternate_greetings = [];
    source.data.character_book.entries[0].content = JSON.stringify(stat);
    const state = await runtimeTest(page, source);
    const relationConversion = relationPrompts ? core.convert(source) : null;
    const relationJsonCell = relationPrompts && relationConversion.schema.find(g => g.tableName === '关系_日志表').columns.find(c => c.zh === '内容').logicalType === 'jsonScalar';
    const pattern = '**/api/backends/chat-completions/generate';
    const previousRules = await setExcludeRules();
    await setExcludeRules(excludeInit ? [{ start: '<initvar', end: '</initvar>' }] : []);
    try {
    for (const mode of ['native', 'sqlite']) {
        await setStorageMode(page, mode); await openState(page, state);
        const chat = '提示词投影-' + mode + '-' + Date.now();
        await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
        await waitCommittedGold(page, 10);
        await page.evaluate(async () => {
            const st = await import('/script.js'), oa = await import('/scripts/openai.js');
            oa.oai_settings.chat_completion_source = 'custom'; oa.oai_settings.custom_url = location.origin + '/fixture';
            oa.oai_settings.custom_model = 'isolated-fixture'; oa.oai_settings.stream_openai = false;
            st.changeMainAPI('openai'); st.setOnlineStatus('isolated-fixture');
            await window.TavernHelper.createChatMessages([{ role: 'user', message: '金币增加到42，其余保持。' }, { role: 'assistant', message: '金币现在是42。' }]);
        });
        const requests = [], relationLocators = [];
        let fixtureFailure = null;
        await page.evaluate(() => {
            window.__fillBusiness = { count: 0 };
            window.__fillBusiness.handler = async after => {
                if (after.stat_data.状态.金币 !== 42) return;
                window.__fillBusiness.count++;
                await new Promise(resolve => setTimeout(resolve, 30));
                after.stat_data.状态.生命 = 73;
            };
            window.SillyTavern.getContext().eventSource.on(window.Mvu.events.VARIABLE_UPDATE_ENDED, window.__fillBusiness.handler);
        });
        await page.route(pattern, async route => {
            try {
            const request = route.request().postDataJSON(); requests.push(request);
            if (excludeInit) assert.ok(!JSON.stringify(request.messages).includes('PRIVATE_CANARY_731'), '排除 initvar 后完整填表正文不含私有哨兵');
            const tablePrompt = request.messages.map(message => String(message.content || '')).find(text => text.includes('<当前表格数据>\n')) || '';
            assert.ok(tablePrompt, '应取得 SP 实际表格提示段');
            assert.ok(!tablePrompt.includes('PRIVATE_CANARY_731') && !tablePrompt.includes('_扩展数据'), '私有列应从最终表格投影中排除');
            if (!relationPrompts) assert.ok(tablePrompt.includes('VISIBLE_READONLY_832'), '只读业务状态仍对 AI 可见');
            let command;
            if (mode === 'sqlite') {
                const gold = tablePrompt.match(/^\s*(\w+)\s+[^\n]*-- 金币/m);
                assert.ok(gold);
                const names = [...tablePrompt.slice(0, gold.index).matchAll(/CREATE TABLE\s+([^\s(]+)/g)];
                command = 'UPDATE ' + names.at(-1)[1] + ' SET ' + gold[1] + ' = 42 WHERE row_id = 1;';
            } else {
                const table = tablePrompt.match(/\[(\d+):状态表\][\s\S]*?Columns:\s*([^\n]+)/);
                const gold = table && table[2].match(/\[(\d+):金币\]/);
                assert.ok(gold);
                command = 'updateRow(' + table[1] + ',0,' + JSON.stringify({ [gold[1]]: 42 }) + ');';
                const names = [...tablePrompt.matchAll(/^\[\d+:([^\]]+)\]/gm)].map(match => match[1]);
                const expected = relationPrompts ? Object.values(relationConversion.template).filter(t => t.content).map(t => t.name)
                    : ['状态表', '背包表', 'A表', 'A_bag表', 'B表', 'B_bag表'];
                assert.deepStrictEqual(names, expected);
            }
            if (relationPrompts) {
                assert.match(tablePrompt, /定位示例（值仅为占位/);
                assert.match(tablePrompt, /不能把来源内的序号 1 直接当成本表行号/);
                const sheet = await page.evaluate(() => Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(t => t.name === '关系_日志表'));
                const ci = sheet.content[0].indexOf('内容'), oi = sheet.content[0].indexOf('关系_名称');
                const index = sheet.content.findIndex((r, i) => i > 0 && r[oi] === '乙' && (relationJsonCell ? JSON.parse(r[ci]) : r[ci]) === '乙日志1');
                assert.ok(index > 1, '样本目标不在全表首行');
                const nativeRow = index - 1, sqlRowId = Number(sheet.content[index][0]);
                assert.notStrictEqual(nativeRow, 1, '来源内数组索引与整表 native 行号不同');
                assert.notStrictEqual(sqlRowId, nativeRow, 'SQL row_id 与 native 行号不同');
                if (mode === 'native') {
                    const block = tablePrompt.match(/\[(\d+):关系_日志表\]([\s\S]*?)(?=\n\[\d+:|<\/当前表格数据>|$)/);
                    assert.ok(block);
                    const contentCol = block[2].match(/\[(\d+):内容\]/);
                    assert.ok(contentCol);
                    assert.match(block[2], new RegExp('\\[' + nativeRow + '\\][^\\n]*乙日志1'));
                    command += '\nupdateRow(' + block[1] + ',' + nativeRow + ',' + JSON.stringify({[contentCol[1]]:relationJsonCell ? JSON.stringify('乙日志已更新') : '乙日志已更新'}) + ');';
                } else {
                    const block = tablePrompt.split(/(?=CREATE TABLE\s)/).find(t => /^CREATE TABLE[^\n]*-- 关系_日志表/.test(t));
                    assert.ok(block, '从实际提示 DDL 查找日志表');
                    const table = block.match(/^CREATE TABLE\s+(\w+)/)[1];
                    const contentCol = block.match(/^\s*(\w+)\s+[^\n]*-- 内容/m)[1];
                    const ownerCol = block.match(/^\s*(\w+)\s+[^\n]*-- 关系_名称/m)[1];
                    const value = relationJsonCell ? JSON.stringify('乙日志已更新') : '乙日志已更新';
                    command += '\nUPDATE ' + table + ' SET ' + contentCol + " = '" + value + "' WHERE " + ownerCol + " = '乙' AND row_id = " + sqlRowId + ';';
                }
                relationLocators.push({ arrayIndex:1, nativeRow, sqlRowId });
            }
            // SP 默认拒绝少于 500 字符的响应。固定夹具满足协议长度，不模拟模型质量。
            const content = '<thought>' + '这是公开自动化验收固定响应，只根据当前表头修改金币，其他字段保持原样。'.repeat(20)
                + '</thought><content><tableEdit>\n' + command + '\n</tableEdit></content>';
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'prompt-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
            } catch (error) {
                fixtureFailure = error;
                await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({error:{message:'本地测试夹具失败'}}) });
            }
        });
        try {
            const result = await page.evaluate(() => window.AutoCardUpdaterAPI.triggerUpdate());
            fs.writeFileSync(path.join(work, 'prompt-' + mode + (excludeInit ? '-filtered' : '') + '-' + runId + '.json'), JSON.stringify({ result, requests, relationLocators }, null, 2));
            if (fixtureFailure) throw fixtureFailure;
            assert.ok(requests.length, 'SP 应实际产生最终填表请求');
            assert.strictEqual(result.success, true, '固定响应应成功提交');
            await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.状态.生命 === 73, {}, { timeout: 20000 });
            await waitCommittedGold(page, 42);
            assert.strictEqual(await page.evaluate(() => window.__fillBusiness.count), 1);
            if (relationPrompts) {
                const expected = structuredClone(stat.关系); expected.乙.日志[1] = '乙日志已更新';
                assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.关系), expected);
                record('relation-prompt-locator', relationLocators);
            }
            record('prompt-capture-and-fill', { excludeInit, requests: requests.length, result, chars: JSON.stringify(requests).length, gold: 42, life: 73, businessCount: 1 });
        } finally {
            await page.evaluate(() => window.SillyTavern.getContext().eventSource.removeListener(window.Mvu.events.VARIABLE_UPDATE_ENDED, window.__fillBusiness.handler));
            await page.unroute(pattern);
        }
        await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, { ...state, chat });
        await waitCommittedGold(page, 42);
        assert.strictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态.生命), 73);
        if (relationPrompts) {
            const expected = structuredClone(stat.关系); expected.乙.日志[1] = '乙日志已更新';
            assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.关系), expected);
        }
        await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 2'));
        await waitCommittedGold(page, 10);
        assert.strictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态.生命), 100);
        if (relationPrompts) assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.关系), stat.关系);
        record('fill-business-reload-delete', { gold: 10, life: 100 });
    }
    } finally { await setExcludeRules(previousRules); }
    await setStorageMode(page, 'native');
}
async function businessEventTest(page, state) {
    for (const mode of ['native', 'sqlite']) {
        await setStorageMode(page, mode);
        await openState(page, state);
        for (const entrance of ['text', 'crud']) {
            const chat = '业务事件验收-' + mode + '-' + entrance + '-' + Date.now();
            await page.evaluate(chat => window.SillyTavern.getContext().openCharacterChat(chat), chat);
            await waitCommittedGold(page, 10);
            await page.evaluate(() => {
                const bus = window.SillyTavern.getContext().eventSource;
                window.__businessTest = { count: 0, events: [] };
                window.__businessTest.handler = async after => {
                    if (after.stat_data.状态.金币 !== 42) return;
                    window.__businessTest.count++;
                    window.__businessTest.events.push({ life: after.stat_data.状态.生命, stack: new Error().stack });
                    await new Promise(resolve => setTimeout(resolve, 30));
                    after.stat_data.状态.生命 = 73;
                };
                bus.on(window.Mvu.events.VARIABLE_UPDATE_ENDED, window.__businessTest.handler);
            });
            if (entrance === 'text') await page.evaluate(() => window.TavernHelper.createChatMessages([
                { role: 'assistant', message: '业务修正。<UpdateVariable>_.set("状态.金币",42);</UpdateVariable>' },
            ]));
            else await page.evaluate(() => window.AutoCardUpdaterAPI.updateCell('状态表', 1, '金币', '42'));
            await page.waitForFunction(() => Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).some(t =>
                t.name === '状态表' && Number(t.content[1]?.[t.content[0].indexOf('生命')]) === 73), {}, { timeout: 20000 });
            await page.waitForTimeout(1000);
            const count = await page.evaluate(() => {
                window.SillyTavern.getContext().eventSource.removeListener(window.Mvu.events.VARIABLE_UPDATE_ENDED, window.__businessTest.handler);
                return window.__businessTest.count;
            });
            if (count !== 1) console.log('BUSINESS_EVENTS', await page.evaluate(() => window.__businessTest.events));
            assert.strictEqual(count, 1, '业务结束监听每次提交仅执行一次');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openState(page, { ...state, chat }); await waitCommittedGold(page, 42);
            assert.strictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态.生命), 73);
            record('business-event-reload', { entrance, count, gold: 42, life: 73 });
            if (entrance === 'text') {
                await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut 1'));
                await waitCommittedGold(page, 10);
                assert.strictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.状态.生命), 100);
                record('business-event-delete', { gold: 10, life: 100 });
            }
        }
    }
    await setStorageMode(page, 'native');
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
            if (only === 'rollback') await require('./rollback-host')({ page, runtimeTest, vwdCard, setStorageMode, assertStorageMode, openState, waitCommittedGold, replaceMvuDataWhenIdle, record, work, runId });
            else if (only === 'compat-probe') await require('./compatibility-probe')({ page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill, waitCommittedGold, record, work, runId });
            else if (only === 'vwd-prompt') await require('./vwd-prompt-host')({ page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill, waitCommittedGold, record, work, runId });
            else if (only === 'nullable-record') await require('./nullable-record-host')({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record });
            else if (only === 'container-presence') await require('./container-presence-host')({ page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill, waitCommittedGold, record, work, runId });
            else if (only === 'full-json') await require('./full-json-host')({ page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill, waitCommittedGold, record, work, runId });
            else if (only === 'vwd') await vwdTest(page);
            else if (only === 'json-path') await jsonPathTest(page);
            else if (only === 'ui') await uiTest(page);
            else {
                const state = only && fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved)) : await runtimeTest(page);
                if (only === 'public-api') await publicApiTest(page, state);
                if (only === 'nullable') await nullableTest(page);
                if (only === 'business') await businessEventTest(page, state);
                if (only === 'prompts') await promptCaptureTest(page);
                if (!only || only === 'history') await historyTest(page, state);
                if (!only || only === 'regenerate') await regenerateTest(page, state);
                if (!only || only === 'ui') await uiTest(page);
                if (!only || only === 'sqlite') await sqliteTest(page);
            }
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

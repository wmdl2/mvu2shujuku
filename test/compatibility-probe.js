'use strict';
// 显式运行的能力探针；不启用 VWD，也不修改产品代码或真实用户设置。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const card = require('./synthetic-card');

module.exports = async function compatibilityProbe(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill,
        waitCommittedGold, record, work, runId } = h;
    const source = card();
    source.data.name = '动态说明能力探针';
    const initial = { 状态: { 生命: 100, 金币: 10, $动态说明: '说明甲' }, 背包: ['钥匙', 0, false, null] };
    source.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n公开探针。';
    source.data.character_book.entries[0].content = JSON.stringify(initial);
    source.data.character_book.entries.push({ id: 8, comment: '变量更新规则', enabled: true, constant: true,
        content: '状态:\n  生命:\n    check: |\n      PROBE_CONST[<%= 2 + 3 %>]\n      PROBE_EJS[<%- mvu2shujukuFormatMessageVariable("stat_data.状态.$动态说明") %>]\n      PROBE_DB[{[db.状态表.where("row_id",1).get("$动态说明")]}]' });
    const output = [];
    const modes = (process.argv.find(a => a.startsWith('--probe-modes='))?.split('=')[1] || 'sqlite,native').split(',');
    const stateOf = () => page.evaluate(() => {
        const all = window.AutoCardUpdaterAPI.exportTableAsJson();
        const sheet = Object.values(all).find(s => s?.name === '状态表');
        return { description: window.Mvu.getMvuData().stat_data.状态.$动态说明, note: sheet.sourceData.note,
            hidden: sheet.sourceData.hiddenPhysicalColumns, header: sheet.content[0],
            chatLength: window.SillyTavern.getContext().chat.length };
    });
    const capture = async (mode, phase, expected) => {
        const got = await captureFill(page, 'compat-' + mode + '-' + phase + '-' + runId + '.txt');
        const marker = name => new RegExp('PROBE_' + name + '\\[([^\\n]*)\\]').exec(got.prompt)?.[1];
        const markers = { const: marker('CONST'), ejs: marker('EJS'), db: marker('DB') };
        const current = await stateOf();
        output.push({ mode, phase, expected, markers, count: got.count, models: got.models, current });
        fs.writeFileSync(path.join(work, 'compat-' + runId + '.json'), JSON.stringify(output, null, 2));
        assert.strictEqual(markers.const, '5', '实际填表请求应展开 EJS 常量');
        if (expected !== undefined) {
            assert.strictEqual(markers.ejs, expected, '实际填表请求应读取当前隐藏说明数据');
            if (mode === 'sqlite') assert.strictEqual(markers.db, expected, 'SQLite 内置查询模板应展开');
        }
        assert.ok(current.note.includes('mvu2shujukuFormatMessageVariable'), '模板 note 本身保持动态表达式');
        record('compat-description-' + mode + '-' + phase, { markers, count: got.count, models: got.models });
        return { ...current, models: got.models };
    };
    for (const mode of modes) {
        await setStorageMode(page, mode);
        const state = await runtimeTest(page, source, undefined, mode);
        await assertStorageMode(page, mode, '动态说明能力探针');
        const baseline = await capture(mode, 'initial', '说明甲');
        if (process.argv.includes('--probe-edges')) {
            assert.ok(baseline.models.every(model => model === 'isolated-fixture'), '应实际使用主 API');
            const rawLiteral = '字面量 <%= 40 + 2 %>；查询 {[db.状态表.where("row_id",1).get("金币")]}；末尾'
                + (process.argv.includes('--probe-escaped') ? '\n{{user}} <random min="1" max="1"/> <if true>条件</if> $random:probe &lt;% 引号"反斜线\\中文🙂' : '');
            const literal = process.argv.includes('--probe-escaped')
                ? require('../src/mvu2shujuku').formatVwdPromptDescription(rawLiteral) : rawLiteral;
            if (process.argv.includes('--probe-escaped')) {
                assert.strictEqual(JSON.parse(literal.slice(literal.indexOf('）') + 1)), rawLiteral, '安全表示必须可逆');
            }
            await page.evaluate(async description => {
                await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '说明字面量探针。' }]);
                const value = window.Mvu.getMvuData(); value.stat_data.状态.$动态说明 = description;
                if (!await window.Mvu.replaceMvuData(value)) throw new Error('说明数据写入失败');
            }, literal);
            await capture(mode, 'main-literal', process.argv.includes('--probe-escaped') ? literal : undefined);
            // 只在隔离用户目录中切换 SP 独立 API，保存原值并在 finally 还原。
            const saved = await page.evaluate(async () => {
                const ctx = window.SillyTavern.getContext(), groups = ctx.extensionSettings.__userscripts;
                const namespace = Object.keys(groups).find(key => key.startsWith('shujuku_') && key.endsWith('__userscript_settings_v1'));
                const key = Object.keys(groups[namespace]).find(key => key.includes('_profile_v1__') && key.endsWith('__settings'));
                const raw = groups[namespace][key], settings = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
                const set = target => {
                    target.apiMode = 'custom'; target.apiConfig = { ...target.apiConfig, useMainApi: false,
                        url: location.origin + '/fixture', apiKey: '', model: 'isolated-direct-probe' };
                };
                set(settings); (settings.apiPresets || []).forEach(set);
                groups[namespace][key] = typeof raw === 'string' ? JSON.stringify(settings) : settings;
                await (await import('/script.js')).saveSettings();
                return { namespace, key, raw };
            });
            try {
                await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state); await waitCommittedGold(page, 37);
                await assertStorageMode(page, mode, '独立 API 探针');
                const direct = await capture(mode, 'direct-literal', process.argv.includes('--probe-escaped') ? literal : undefined);
                assert.ok(direct.models.every(model => model === 'isolated-direct-probe'), '应实际使用 SP 独立 API');
                await page.evaluate(async () => {
                    const value = window.Mvu.getMvuData(); value.stat_data.状态.$动态说明 = '说明丙';
                    if (!await window.Mvu.replaceMvuData(value)) throw new Error('说明数据写入失败');
                });
                await capture(mode, 'direct-normal', '说明丙');
            } finally {
                await page.evaluate(async saved => {
                    window.SillyTavern.getContext().extensionSettings.__userscripts[saved.namespace][saved.key] = saved.raw;
                    await (await import('/script.js')).saveSettings();
                }, saved);
                await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state); await waitCommittedGold(page, 37);
            }
            const notification = await page.evaluate(async () => {
                const api = window.AutoCardUpdaterAPI, seen = [];
                const callback = (tables, meta) => {
                    const sheet = Object.values(tables).find(s => s?.name === '状态表');
                    seen.push({ meta, gold: sheet?.content?.[1]?.[sheet?.content?.[0]?.indexOf('金币')] });
                    return false; // 探测返回值能否阻止提交；不修改可能为活引用的 payload。
                };
                api.registerTableUpdateCallback(callback);
                try {
                    const returned = await api.updateCell('状态表', 1, '金币', '38');
                    return { returned, seen };
                } finally { api.unregisterTableUpdateCallback(callback); }
            });
            await waitCommittedGold(page, 38);
            await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state); await waitCommittedGold(page, 38);
            assert.ok(notification.seen.some(entry => Number(entry.gold) === 38 && entry.meta?.persisted === true));
            record('compat-postcommit-callback-' + mode, notification);
            continue;
        }
        const targetIndex = baseline.chatLength;
        await page.evaluate(async () => {
            await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '说明变化。' }]);
            const value = window.Mvu.getMvuData(); value.stat_data.状态.$动态说明 = '说明乙';
            if (!await window.Mvu.replaceMvuData(value)) throw new Error('说明数据写入失败');
        });
        const changed = await capture(mode, 'changed', '说明乙');
        assert.strictEqual(changed.note, baseline.note, '更新数据而非模板备注');
        await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state); await waitCommittedGold(page, 37);
        await assertStorageMode(page, mode, '动态说明刷新');
        await capture(mode, 'reload', '说明乙');
        await page.evaluate(index => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut ' + index + '-' + (window.SillyTavern.getContext().chat.length - 1)), targetIndex);
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.状态.$动态说明 === '说明甲');
        await capture(mode, 'rollback', '说明甲');
    }
    await setStorageMode(page, 'native');
};

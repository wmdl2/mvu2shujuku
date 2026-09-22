'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../src/mvu2shujuku');
function fixture(fullJson) {
    const source = require('./synthetic-card')();
    const initial = { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 整组: { 数量: 1, 模式: '甲' }, 可空列表: [], 可空字典: { 甲: { 数量: 2 } } };
    if (fullJson) {
        initial.整组.说明对 = [{ 子项: null }, '初始对象说明'];
        initial.可空字典.甲.开关 = [false, '初始行说明'];
        source.data.character_book.entries.push({ comment: '变量更新规则', content: '变量更新规则:\n  整组:\n    数量:\n      check: 任务数量只能在完成任务后增加\n' });
    } else source.data.extensions.tavern_helper.scripts.push({ name: '整组结构', content: `const S = z.object({
        整组: z.object({ 数量: z.number().min(0).max(10).describe('任务数量'), 模式: z.enum(['甲','乙']) }).nullish(),
        可空列表: z.array(z.string()).nullish(), 可空字典: z.record(z.string(), z.object({ 数量: z.number() })).nullish()
    }); registerMvuSchema(S);` });
    source.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n开场。';
    source.data.alternate_greetings = [];
    source.data.character_book.entries[0].content = JSON.stringify(initial);
    return { source, initial };
}
module.exports = async function containerPresenceHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill, waitCommittedGold, record, work, runId } = h;
    const fullJson = h.fullJson === true;
    const convertCore = fullJson ? { convert: (source, options) => core.convert(source, { ...options, jsonContainers: ['整组', '可空列表', '可空字典'] }) } : core;
    for (const mode of ['sqlite', 'native']) {
        await setStorageMode(page, mode);
        const { source } = fixture(fullJson);
        // runtimeTest 的公共启动契约：金币 10、四个背包元素；空值测试使用另外三组。
        source.data.name = (fullJson ? '完整JSON容器验收-' : '整组空值验收-') + mode;
        const state = await runtimeTest(page, source, convertCore, mode);
        const restore = async () => { await openState(page, state); await waitCommittedGold(page, 37); await assertStorageMode(page, mode, '整组空值'); };
        await assertStorageMode(page, mode, '整组空值初始');
        const read = () => page.evaluate(() => {
            const stat = window.Mvu.getMvuData().stat_data, out = {};
            for (const key of ['整组', '可空列表', '可空字典']) if (Object.hasOwn(stat, key)) out[key] = stat[key];
            return out;
        });
        const baseline = await read();
        if (h.initialOnly) {
            const expected = fixture(fullJson).initial;
            assert.deepStrictEqual(baseline, Object.fromEntries(['整组', '可空列表', '可空字典'].map(k => [k, expected[k]])));
            const ddl = await page.evaluate(() => Object.values(window.AutoCardUpdaterAPI.exportTableAsJson())
                .find(s => s?.name === '整组表').sourceData.ddl);
            assert.match(ddl, /DEFAULT ''/);
            assert.doesNotMatch(ddl, /初始对象说明/);
            record('full-json-' + mode + '-empty-default-initialization', { refreshed: true });
            continue;
        }
        const target = await page.evaluate(async () => {
            const index = window.SillyTavern.getContext().chat.length;
            await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '整组空值更新。' }]);
            return index;
        });
        const states = [{ 整组: null, 可空列表: null, 可空字典: null }, { 整组: {}, 可空列表: [], 可空字典: {} }, {},
            { 整组: { 数量: 2, 模式: '乙' }, 可空列表: ['新'], 可空字典: { 乙: { 数量: 4 } } }];
        if (fullJson) {
            states.push({ 整组: { 数量: 2, 模式: '乙', 说明对: [{ 子项: {} }, '对象当前说明'] },
                可空列表: [[3, '数组当前说明'], { 子项: null }],
                可空字典: { 甲: null, 乙: {}, 丙: { 开关: [true, '行当前说明'] } } });
        }
        for (let i = 0; i < states.length; i++) {
            const expected = states[i];
            assert.strictEqual(await page.evaluate(async values => {
                const next = window.Mvu.getMvuData();
                for (const key of ['整组', '可空列表', '可空字典']) delete next.stat_data[key];
                Object.assign(next.stat_data, values);
                return window.Mvu.replaceMvuData(next);
            }, expected), true);
            assert.deepStrictEqual(await read(), expected, '成功后立即读回');
            await page.reload({ waitUntil: 'domcontentloaded' }); await restore();
            assert.deepStrictEqual(await read(), expected, '刷新后仍保留状态');
        }
        record('container-presence-' + mode + '-states', { states: states.length, refreshed: true, immediateRead: true });
        const request = await captureFill(page, 'container-presence-' + mode + '-' + runId + '.txt');
        assert.match(request.prompt, /空单元格表示该变量不存在/);
        assert.match(request.prompt, /任务数量/);
        assert.match(request.prompt, /JSON 路径从内容内部开始/);
        if (fullJson) {
            for (const text of ['对象当前说明', '数组当前说明', '行当前说明']) assert.ok(request.prompt.includes(text));
            assert.doesNotMatch(request.prompt, /\$说明覆盖|shuomingfugai|\$容器状态/);
            record('full-json-' + mode + '-nested-pairs-and-states');
        }
        record('container-presence-' + mode + '-prompt', { requests: request.count });
        // 真实 SQL 填表入口，不把 Node SQLite 或公开 CRUD 替身当成模型 SQL 已验收。
        if (mode === 'sqlite') {
            const group = convertCore.convert(source, { mode: 'both' }).schema.find(g => g.name === '整组');
            const sql = `UPDATE ${group.ident} SET ${group.columns[0].ident} = json_set(${group.columns[0].ident}, '$."数量"', 3) WHERE row_id=1;`;
            const pattern = '**/api/backends/chat-completions/generate';
            let error = null, requests = 0;
            await page.route(pattern, async route => {
                try {
                    requests++;
                    const content = '<thought>' + '整组空值固定 SQL 响应；只改一个字段并保留模式。'.repeat(30) + '</thought><content><tableEdit>\n' + sql + '\n</tableEdit></content>';
                    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'container-presence', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
                } catch (e) { error = e; await route.abort().catch(() => {}); }
            });
            try {
                const response = await page.evaluate(() => window.AutoCardUpdaterAPI.triggerUpdate());
                if (error) throw error;
                assert.ok(requests);
                assert.strictEqual(response.success, true);
                await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.整组?.数量 === 3);
                assert.deepStrictEqual((await read()).整组, { ...states[states.length - 1].整组, 数量: 3 });
                fs.writeFileSync(path.join(work, 'container-presence-sql-' + runId + '.json'), JSON.stringify({ sql, response, requests }, null, 2));
                record('container-presence-sqlite-model-update', { requests });
            } finally { await page.unroute(pattern); }
        }
        await page.evaluate(index => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut ' + index + '-' + (window.SillyTavern.getContext().chat.length - 1)), target);
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.整组?.数量 === 1);
        assert.deepStrictEqual(await read(), baseline);
        record('container-presence-' + mode + '-rollback');
    }
    await setStorageMode(page, 'native');
};
module.exports.fixture = fixture;

'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
const fs = require('fs');
const card = require('./vwd-card');
const withDirectApi = require('./host-api-mode');

function typedCard() {
    const source = card();
    const stat = JSON.parse(source.data.character_book.entries[0].content);
    stat.好感系统.开关 = [false, '布尔说明'];
    source.data.character_book.entries[0].content = JSON.stringify(stat);
    source.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\nVWD 数字布尔说明验收。';
    return source;
}

module.exports = async function vwdPromptHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, captureFill,
        waitCommittedGold, record, runId } = h;
    const raw = '完成委托 <%= 40 + 2 %> {{user}} {[db.状态表.where("row_id",1).get("金币")]}\n<random min="1" max="1"/> $random:probe &lt;% "引号" \\🙂';
    const formatted = core.formatVwdPromptDescription(raw);
    if (process.argv.includes('--vwd-ui')) {
        await page.locator('#extensions-settings-button').click();
        await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
        await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
        await page.locator('#mvu2shujuku-file').setInputFiles({ name: 'vwd-ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card())) });
        await page.locator('#mvu2shujuku-convert-file').click();
        await page.locator('.mvu2shujuku-param-grid .mvu2shujuku-param-value').first().waitFor({ timeout: 30000 });
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#mvu2shujuku-downloads button').filter({ hasText: /-DB\.json/ }).first().click()]);
        const converted = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        const layout = JSON.parse((converted.data || converted).extensions.mvu2shujuku.layout);
        assert.strictEqual(layout.find(e => e.group === '好感系统').vwd.promptVersion, 1, '真实 UI 转换应按宿主能力启用动态说明');
        record('vwd-prompt-ui-enabled');
    }
    const typed = process.argv.includes('--vwd-typed');
    const quick = typed || process.argv.includes('--vwd-quick');
    const read = () => page.evaluate(() => {
        const sheet = Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(t => t?.name === '好感系统表');
        return { stat: window.Mvu.getMvuData().stat_data.好感系统, note: sheet.sourceData.note,
            header: sheet.content[0], row: sheet.content[1], chatLength: window.SillyTavern.getContext().chat.length };
    });
    const capture = async (mode, phase, description, extra = {}) => {
        const request = await captureFill(page, 'vwd-prompt-' + mode + '-' + phase + '-' + runId + '.txt');
        assert.ok(request.prompt.includes('- 乙称呼：' + description + '\n'), phase + ' 乙称呼说明');
        assert.ok(request.prompt.includes('- 甲称呼：当前称呼'), phase + ' 相同原文的其他字段应保持不变');
        assert.doesNotMatch(request.prompt, /mvu2shujukuVwd|\u0000VWD|shuomingfugai|\$说明覆盖/);
        assert.ok(request.models.every(model => model === (extra.direct ? 'isolated-direct-probe' : 'isolated-fixture')));
        record('vwd-prompt-' + mode + '-' + phase, { models: request.models, count: request.count, description });
        return request;
    };
    for (const mode of ['sqlite', 'native']) {
        await setStorageMode(page, mode);
        const convertCore = { convert: (source, options) => core.convert(source, { ...options, vwdDescriptions: true }) };
        const state = await runtimeTest(page, typed ? typedCard() : card(), convertCore, mode);
        await assertStorageMode(page, mode, 'VWD 动态说明');
        const restore = async () => { await openState(page, state); await waitCommittedGold(page, 37); };
        if (!quick) await capture(mode, 'initial', '当前称呼');
        const baseline = await read(), targetIndex = baseline.chatLength;
        assert.ok(baseline.header.includes('$说明覆盖'));
        if (typed) {
            assert.deepStrictEqual(baseline.stat.数字, [3, '数字说明']);
            assert.deepStrictEqual(baseline.stat.开关, [false, '布尔说明']);
        }
        await page.evaluate(async ({ description, typed }) => {
            await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '动态说明更新。' }]);
            const next = window.Mvu.getMvuData();
            next.stat_data.好感系统.乙称呼 = ['小乙新', description];
            next.stat_data.好感系统.描述 = ['已完成', '事后补充说明'];
            if (typed) {
                next.stat_data.好感系统.数字 = [7, '完成任务后的数值'];
                next.stat_data.好感系统.开关 = [true, '已启用'];
            }
            if (!await window.Mvu.replaceMvuData(next)) throw new Error('VWD 写入失败');
        }, { description: raw, typed });
        const changed = await read();
        if (changed.stat.乙称呼[1] !== raw) {
            record('vwd-prompt-' + mode + '-pending-view', { pair: changed.stat.乙称呼,
                cell: changed.row[changed.header.indexOf('乙称呼')], metadata: changed.row[changed.header.indexOf('$说明覆盖')] });
        }
        assert.deepStrictEqual(changed.stat.乙称呼, ['小乙新', raw]);
        assert.deepStrictEqual(changed.stat.描述, ['已完成', '事后补充说明']);
        assert.strictEqual(changed.note, baseline.note, '只更新数据，模板保持不变');
        const prompt = await capture(mode, 'changed', formatted);
        assert.ok(prompt.prompt.includes('- 描述：事后补充说明'));
        if (typed) {
            assert.deepStrictEqual(changed.stat.数字, [7, '完成任务后的数值']);
            assert.deepStrictEqual(changed.stat.开关, [true, '已启用']);
            assert.strictEqual(Number(changed.row[changed.header.indexOf('数字')]), 7);
            assert.strictEqual(Number(changed.row[changed.header.indexOf('开关')]), 1);
            assert.ok(prompt.prompt.includes('- 数字：完成任务后的数值'));
            assert.ok(prompt.prompt.includes('- 开关：已启用'));
            record('vwd-typed-' + mode + '-written');
        }
        await page.reload({ waitUntil: 'domcontentloaded' }); await restore();
        await assertStorageMode(page, mode, 'VWD 刷新');
        assert.deepStrictEqual((await read()).stat, changed.stat);
        if (!quick) await capture(mode, 'reload', formatted);
        if (mode === 'sqlite' && !typed) {
            await withDirectApi(page, restore, async () => {
                await assertStorageMode(page, mode, 'VWD 独立 API');
                await capture(mode, 'direct', formatted, { direct: true });
            });
        }
        const rejected = await page.evaluate(async () => {
            const fn = window.EjsTemplate.evalTemplate, marker = fn.__mvu2shujukuContextBridge;
            fn.__mvu2shujukuContextBridge = false;
            try {
                const next = window.Mvu.getMvuData(); next.stat_data.好感系统.乙称呼 = ['不得保存', '不得保存说明'];
                return await window.Mvu.replaceMvuData(next);
            } finally { fn.__mvu2shujukuContextBridge = marker; }
        });
        assert.strictEqual(rejected, false, '运行期缺少渲染能力必须拒绝');
        assert.deepStrictEqual((await read()).stat, changed.stat);
        record('vwd-prompt-' + mode + '-capability-rejected');
        await page.evaluate(async typed => {
            const next = window.Mvu.getMvuData(); next.stat_data.好感系统.乙称呼[1] = '';
            if (typed) {
                next.stat_data.好感系统.数字[1] = '';
                next.stat_data.好感系统.开关[1] = '仅说明变化';
            }
            if (!await window.Mvu.replaceMvuData(next)) throw new Error('空说明写入失败');
        }, typed);
        if (typed) {
            const empty = await read();
            assert.deepStrictEqual(empty.stat.数字, [7, '']);
            assert.deepStrictEqual(empty.stat.开关, [true, '仅说明变化']);
            record('vwd-typed-' + mode + '-description-only');
        } else await capture(mode, 'empty', '');
        await page.evaluate(index => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/cut ' + index + '-' + (window.SillyTavern.getContext().chat.length - 1)), targetIndex);
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.好感系统.乙称呼[1] === '当前称呼');
        assert.deepStrictEqual((await read()).stat, baseline.stat);
        if (typed) record('vwd-typed-' + mode + '-rollback');
        else await capture(mode, 'rollback', '当前称呼');
    }
    await setStorageMode(page, 'native');
};

module.exports.preflight = function () {
    const converted = core.convert(typedCard(), { mode: 'both', vwdDescriptions: true });
    const layout = JSON.parse((converted.card.data || converted.card).extensions.mvu2shujuku.layout);
    const stat = core.statDataFromTables(layout, converted.template).stat_data;
    assert.strictEqual(stat.状态.金币, 10);
    assert.strictEqual(stat.背包.length, 4);
    assert.deepStrictEqual(stat.好感系统.数字, [3, '数字说明']);
    assert.deepStrictEqual(stat.好感系统.开关, [false, '布尔说明']);
    assert.ok(layout.find(e => e.group === '好感系统').vwd.fields.some(f => f.type === 'boolean'));
    return { group: stat.好感系统, mode: 'both', fields: layout.find(e => e.group === '好感系统').vwd.fields.length };
};

'use strict';
// Public fixture: registered author preprocessing on pure InitVar greetings.
const assert = require('assert/strict');
module.exports = async ({ page, runtimeTest, setStorageMode, assertStorageMode, record }) => {
    const moduleUrl = new URL('/fixture-opening-schema.js', page.url()).href;
    let routeFailure;
    await page.route(moduleUrl, async route => {
        try {
            await route.fulfill({ status: 200, contentType: 'text/javascript',
                body: 'export function registerMvuSchema(schema) { window.__fixtureOpeningSchema = schema; }' });
        } catch (error) { routeFailure = error; await route.abort(); }
    });
    for (const mode of ['native', 'sqlite']) {
        await setStorageMode(page, mode);
        const source = require('./synthetic-card')();
        source.data.name = '纯初始化Schema验收-' + mode;
        source.data.first_mes = source.data.first_mes.replace('"背包":', '"旧事件":{"甲":true},"背包":');
        source.data.alternate_greetings[0] = source.data.alternate_greetings[0].replace('"背包":', '"旧事件":{"乙":"待处理"},"背包":');
        source.data.extensions.tavern_helper.scripts.push({ type: 'script', name: '作者初始化预处理', enabled: true,
            content: `import { registerMvuSchema } from ${JSON.stringify(moduleUrl)};
            const Schema=z.preprocess(data => {
                if (data.旧事件 !== undefined) { data.$事件=data.旧事件; delete data.旧事件; }
                if (data.初始化时间 === undefined) data.初始化时间=Date.now();
                return data;
            },z.object({状态:z.object({生命:z.number(),金币:z.number()}),背包:z.array(z.any()),
                $事件:z.record(z.string(),z.union([z.boolean(),z.string()])).prefault({}),初始化时间:z.number().optional()}));
            $(async () => { await waitGlobalInitialized('Mvu'); registerMvuSchema(Schema); });` });
        const state = await runtimeTest(page, source, undefined, 'opening-schema-' + mode);
        if (routeFailure) throw routeFailure;
        await assertStorageMode(page, mode, '纯初始化Schema');
        const first = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
        assert.deepStrictEqual(first.$事件, { 甲: true });
        assert(!Object.hasOwn(first, '旧事件'));
        assert(Number.isFinite(first.初始化时间) && Math.abs(Date.now() - first.初始化时间) < 300000);
        await page.evaluate(async message => {
            await TavernHelper.setChatMessages([{ message_id: 0, message }], { refresh: 'affected' });
        }, source.data.alternate_greetings[0]);
        await page.waitForFunction(() => {
            try { const s=window.Mvu.getMvuData().stat_data;return s.状态.金币===20 && s.$事件?.乙==='待处理' && !('旧事件' in s); }
            catch (error) { if (error.code==='MVU_DATA_NOT_READY') return false;throw error; }
        }, {}, { timeout: 45000 });
        const second = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
        assert.deepStrictEqual(second.$事件, { 乙: '待处理' });
        assert(Number.isFinite(second.初始化时间));
        record('opening-schema-' + mode, { state, oldAliasRemoved: true, firstAndSecondGreetings: true, runtimeClock: true });
    }
};

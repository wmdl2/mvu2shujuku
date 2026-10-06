'use strict';
const assert = require('assert/strict');
const core = require('../src/mvu2shujuku');
module.exports = async function cardApiHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record } = h;
    const moduleUrl = new URL('/fixture-card-schema.js', page.url()).href;
    const dynamic = process.env.MVU_SCHEMA_ENTRY_STYLE === 'dynamic';
    let routeFailure = null;
    await page.route(moduleUrl, async route => {
        try { await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export function registerMvuSchema(schema) { window.__fixtureOriginalSchema = schema; }' }); }
        catch (error) { routeFailure = error; await route.abort(); }
    });
    for (const mode of ['native', 'sqlite']) {
        await setStorageMode(page, mode);
        const source = require('./synthetic-card')();
        source.data.name = 'Schema与档案验收-' + mode;
        if (dynamic) source.data.extensions.tavern_helper.scripts.push({ type: 'script', name: '双源原引擎加载器', enabled: true,
            content: "await new Promise(resolve=>setTimeout(resolve,250));try{await import('https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@abcdef/artifact/bundle.js');}catch(e){await import('https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@abcdef/artifact/bundle.js');}" });
        source.data.extensions.tavern_helper.scripts.push({ type: 'script', name: 'registered business schema', enabled: true,
            content: `${dynamic ? 'let registerMvuSchema;try{({registerMvuSchema}=await import(' + JSON.stringify(moduleUrl) + '));}catch(e){({registerMvuSchema}=await import(' + JSON.stringify(moduleUrl) + '));}' : 'import { registerMvuSchema } from ' + JSON.stringify(moduleUrl) + ';'}
            const noise = value => value.replace(/[（(]tag[)）]/g, '');
            const Schema=z.object({ 状态:z.object({生命:z.number(),金币:z.number(),变换次数:z.number().default(0),opaque:z.union([z.boolean(),z.array(z.any()),z.null(),z.object({}).passthrough()]).default([false,null])}).passthrough(), 背包:z.array(z.any()),
                新开关:z.boolean().default(false), 可选模块:z.object({count:z.number()}).optional()
            }).passthrough().transform(data => { data.状态.生命=Math.min(data.状态.生命,125); data.状态.变换次数++; return data; });
            eventOn('mag_command_parsed_for_zod', (_, commands) => { for (const cmd of commands) if (cmd.args[0] === 'status.life') cmd.args[0]='["状态"]["生命"]'; });
            $(() => registerMvuSchema(Schema));` });
        const state = await runtimeTest(page, source, core, mode);
        if (routeFailure) throw routeFailure;
        await assertStorageMode(page, mode, 'Schema与档案');
        const metadata = core.convert(source).card.data.extensions.mvu2shujuku;
        if (dynamic) assert(!core.convert(source).card.data.extensions.tavern_helper.scripts.some(s => s.name === '双源原引擎加载器'));
        const observed = await page.evaluate(async marker => {
            const ctx = window.SillyTavern.getContext();
            const originalBook = Object.keys(marker.worldbookAliases)[0];
            // JSON character import does not auto-import the embedded book in ST.
            await window.TavernHelper.createWorldbook(marker.worldbookAliases[originalBook]);
            const aliased = await window.TavernHelper.getWorldbook(originalBook);
            const actual = await window.TavernHelper.getWorldbook(marker.worldbookAliases[originalBook]);
            if (JSON.stringify(aliased) !== JSON.stringify(actual)) throw new Error('世界书别名路由不一致');
            const current = window.Mvu.getMvuData();
            if (JSON.stringify(current.stat_data.状态.opaque) !== '[false,null]') throw new Error('未知联合初值改变类型');
            const parsed = await window.Mvu.parseMessage('<JSONPatch>[{"op":"replace","path":"/status/life","value":999}]</JSONPatch>', current);
            if (parsed.stat_data.状态.生命 !== 125) throw new Error('原 Schema 变换未应用');
            if (parsed.stat_data.状态.变换次数 !== current.stat_data.状态.变换次数 + 1) throw new Error('解析阶段重复执行 Schema');
            if (!await window.Mvu.replaceMvuData(parsed)) throw new Error('解析后保存失败');
            if (window.Mvu.getMvuData().stat_data.状态.变换次数 !== parsed.stat_data.状态.变换次数) throw new Error('保存阶段重复执行 Schema');
            const before = ctx.chat.length;
            const snapshot = window.Mvu.getMvuData(); snapshot.stat_data.状态.生命 = 999; snapshot.stat_data.状态.金币 = 44;
            snapshot.stat_data.新开关 = true; snapshot.stat_data.可选模块 = { count: 5 };
            snapshot.stat_data.状态.opaque = {deep:[false,null]};
            const expectedTransforms = snapshot.stat_data.状态.变换次数 + 1;
            await window.TavernHelper.createChatMessages([{role:'system',message:'公开档案',data:snapshot}], {refresh:'affected'});
            const archived = ctx.chat[before];
            if (archived.variables[0].stat_data.状态.变换次数 !== expectedTransforms || window.Mvu.getMvuData().stat_data.状态.变换次数 !== expectedTransforms) throw new Error('档案阶段重复执行 Schema');
            return { index:before, rawLife:archived.variables[0].stat_data.状态.生命, hasFrame:!!archived.TavernDB_ACU_IsolatedData,
                view:window.Mvu.getMvuData().stat_data, originalBook, binding:marker.worldbookAliases[originalBook] };
        }, metadata);
        assert.strictEqual(observed.rawLife, 125); assert.strictEqual(observed.hasFrame, true);
        assert.strictEqual(observed.view.状态.生命, 125); assert.strictEqual(observed.view.新开关, true);
        assert.deepStrictEqual(observed.view.状态.opaque,{deep:[false,null]});
        assert.deepStrictEqual(observed.view.可选模块, {count:5}); await waitCommittedGold(page,44);
        record('schema-archive-' + mode, observed);
        await page.reload({waitUntil:'domcontentloaded'}); await openState(page,state); await waitCommittedGold(page,44);
        const persisted = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
        assert.strictEqual(persisted.状态.生命,125); assert.strictEqual(persisted.新开关,true); assert.deepStrictEqual(persisted.可选模块,{count:5});
        assert.deepStrictEqual(persisted.状态.opaque,{deep:[false,null]});
        record('schema-archive-reload-' + mode, {life:persisted.状态.生命,enabled:persisted.新开关,module:persisted.可选模块});
        const rejected = await page.evaluate(async () => {
            const before = JSON.stringify(window.AutoCardUpdaterAPI.exportTableAsJson());
            const data=window.Mvu.getMvuData(); data.stat_data.unknownRoot={x:1};
            const ok = await window.Mvu.replaceMvuData(data);
            return {ok,unchanged:JSON.stringify(window.AutoCardUpdaterAPI.exportTableAsJson())===before};
        });
        assert.deepStrictEqual(rejected,{ok:false,unchanged:true}); record('schema-unknown-rejected-' + mode,rejected);
    }
    await page.unroute(moduleUrl); await setStorageMode(page,'native');
};

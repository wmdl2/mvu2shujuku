'use strict';
const assert = require('assert/strict');
const core = require('../src/mvu2shujuku');
function fixture(moduleUrl, mode) {
    const source = require('./synthetic-card')();
    source.data.name = '社区卡默认与结构验收-' + mode;
    source.data.first_mes = '公开测试开场。';
    source.data.alternate_greetings = [];
    source.data.character_book.entries[0].content = '';
    source.data.extensions.tavern_helper.scripts.push({ type: 'script', name: '静态默认结构', enabled: true,
        content: `import { registerMvuSchema } from ${JSON.stringify(moduleUrl)};
        const Schema = z
            .object({状态:z.object({生命:z.number().prefault(100),金币:z.number().prefault(10)})
                .prefault({旧值:5}), 背包:z.array(z.any()).prefault(['钥匙',0,false,null]),
                建筑:z.object({房间:z.record(z.string(),z.object({位置:z.string()}))})
                    .prefault({房间:{甲:{位置:'1-3'},乙:{位置:'outdoor-left'}}}),
                游戏:z.object({位置:z.coerce.number().prefault(0)}).prefault({}),
                列表:z.record(z.string(),z.object({值:z.number()}).or(z.literal('等待')))
                    .prefault({甲:'等待',乙:{值:1}}),
                项:z.array(z.string()).or(z.literal('空')).prefault('空')});
        $(() => registerMvuSchema(Schema));` });
    return source;
}
module.exports = async function communityCardHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record } = h;
    const moduleUrl = new URL('/fixture-community-schema.js', page.url()).href;
    let routeFailure = null;
    await page.route(moduleUrl, async route => {
        try { await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export function registerMvuSchema(schema) {}' }); }
        catch (error) { routeFailure = error; await route.abort(); }
    });
    try {
        for (const mode of ['native', 'sqlite']) {
            await setStorageMode(page, mode);
            const source = fixture(moduleUrl, mode), converted = core.convert(source);
            const state = await runtimeTest(page, source, core, mode);
            if (routeFailure) throw routeFailure;
            await assertStorageMode(page, mode, '社区卡结构');
            const initial = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
            assert.strictEqual(initial.建筑.房间.甲.位置, '1-3');
            assert.strictEqual(initial.建筑.房间.乙.位置, 'outdoor-left');
            assert.deepStrictEqual(initial.列表, {甲:'等待',乙:{值:1}});
            assert.strictEqual(initial.项, '空');
            record('community-defaults-' + mode, {tables:converted.meta.tableCount, positions:['1-3','outdoor-left'], union:true});
            const observed = await page.evaluate(async () => {
                const data = window.Mvu.getMvuData();
                data.stat_data.状态.金币 = 44;
                data.stat_data.状态.旧值 = 9;
                data.stat_data.建筑.房间.甲.位置 = '9-10';
                data.stat_data.建筑.房间.乙.位置 = 'outdoor-right';
                data.stat_data.游戏.位置 = 3;
                data.stat_data.列表 = {甲:{值:2},乙:'等待'};
                data.stat_data.项 = ['一','二'];
                const ok = await window.Mvu.replaceMvuData(data);
                return {ok, stat:window.Mvu.getMvuData().stat_data};
            });
            assert.strictEqual(observed.ok, true);
            assert.strictEqual(observed.stat.建筑.房间.甲.位置, '9-10');
            assert.strictEqual(observed.stat.建筑.房间.乙.位置, 'outdoor-right');
            assert.strictEqual(observed.stat.游戏.位置, 3);
            assert.deepStrictEqual(observed.stat.列表, {甲:{值:2},乙:'等待'});
            assert.deepStrictEqual(observed.stat.项, ['一','二']);
            assert.strictEqual(Object.hasOwn(observed.stat.状态, '旧值'), false);
            await waitCommittedGold(page, 44);
            record('community-write-' + mode, {positions:['9-10','outdoor-right'], numeric:3, union:true, stripped:true});
            await page.reload({waitUntil:'domcontentloaded'}); await openState(page, state); await waitCommittedGold(page,44);
            const persisted = await page.evaluate(() => window.Mvu.getMvuData().stat_data);
            assert.deepStrictEqual(persisted, observed.stat);
            record('community-reload-' + mode, {exact:true});

            const mixed = require('./synthetic-card')();
            mixed.data.name = '社区混合字典验收-' + mode;
            const stat = {状态:{生命:100,金币:10},背包:['钥匙',0,false,null],
                组:{记录:{$meta:{extensible:true},数字:33,开关:false,文本:'原文',数组:[],对象:{值:1}}}};
            mixed.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>公开测试。';
            mixed.data.alternate_greetings = [];
            mixed.data.character_book.entries[0].content = JSON.stringify(stat);
            const mixedState = await runtimeTest(page, mixed, core, mode);
            await assertStorageMode(page, mode, '未声明混合字典');
            const target = {数字:44,开关:true,文本:'更新',数组:[1,2],对象:{值:2}};
            const result = await page.evaluate(async target => {
                const data = window.Mvu.getMvuData();
                data.stat_data.组.记录 = target; data.stat_data.状态.金币 = 44;
                const ok = await window.Mvu.replaceMvuData(data);
                return {ok, value:window.Mvu.getMvuData().stat_data.组.记录};
            }, target);
            assert.deepStrictEqual(result, {ok:true,value:target}); await waitCommittedGold(page,44);
            record('community-mixed-write-' + mode, {numbers:true,boolean:true,array:true,object:true});
            await page.reload({waitUntil:'domcontentloaded'}); await openState(page,mixedState); await waitCommittedGold(page,44);
            assert.deepStrictEqual(await page.evaluate(() => window.Mvu.getMvuData().stat_data.组.记录), target);
            record('community-mixed-reload-' + mode, {exact:true});
        }
    } finally { await page.unroute(moduleUrl); }
    await setStorageMode(page,'native');
};
module.exports.fixture = fixture;

'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
module.exports = async function statStorageHost(h) {
    const { page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record } = h;
    for (const mode of ['sqlite']) {
        await setStorageMode(page, mode);
        const source = require('./synthetic-card')();
        const initial = core.parseInitVar(source.data.character_book.entries[0].content);
        initial.$缓存 = { 开关: true };
        initial.状态._公开 = 1;
        initial.状态.$内部 = { 游标: 2 };
        initial.列表 = [{ 名字: '相同', $缓存: '甲' }, { 名字: '相同', $缓存: '乙' }];
        initial.女性角色 = { 甲: { 姓名: '甲', 亲密状态: { 次数: 1.5, 身体记忆: { 手: '已发生' }, $缓存: '私有值' } } };
        source.data.name = '原消息状态验收-' + mode;
        source.data.character_book.entries[0].content = JSON.stringify(initial);
        source.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>公开测试。';
        source.data.alternate_greetings = [];
        const state = await runtimeTest(page, source, core, mode);
        await assertStorageMode(page, mode, '原消息状态初始化');
        const read = () => page.evaluate(() => JSON.parse(JSON.stringify(window.Mvu.getMvuData().stat_data)));
        assert.equal((await read()).$缓存.开关, true);
        assert.equal(await page.evaluate(async () => {
            const wrap = window.Mvu.getMvuData(); wrap.stat_data.$缓存.开关 = false;
            wrap.stat_data.插图系统 = { 解锁: ['一'] }; wrap.stat_data.状态._公开 = 2;
            return window.Mvu.replaceMvuData(wrap);
        }), true);
        const current = await read();
        assert.equal(current.$缓存.开关, false); assert.equal(current.状态._公开, 2);
        assert.deepStrictEqual(current.插图系统, { 解锁: ['一'] });
        const raw = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext(), m = ctx.chat.at(-1);
            return { stat: m.variables?.[m.swipe_id || 0]?.stat_data, tables: JSON.stringify(window.AutoCardUpdaterAPI.exportTableAsJson()) };
        });
        assert.equal(raw.stat.$缓存, undefined, '已声明美元字段由数据库保存');
        assert.deepStrictEqual(raw.stat.插图系统, { 解锁: ['一'] }); assert(!raw.tables.includes('插图系统'));
        assert(!('$内部' in (raw.stat.状态 || {})));
        assert(raw.tables.includes('$内部')); // 属于状态记录，不是独立原消息子树
        const converted = core.convert(source, { mode: 'sqlite' });
        const roleGroup = converted.schema.find(g => g.name === '女性角色');
        const intimacy = roleGroup.columns.find(c => c.zh === '亲密状态');
        assert(intimacy?.isObject, '复杂嵌套对象保留完整 JSON，所属角色仍为行表');
        assert.strictEqual(roleGroup.kind, 'rows');
        const roleMutation = await page.evaluate(async sql => window.AutoCardUpdaterAPI.executeSqlMutation(sql),
            `UPDATE "${roleGroup.ident}" SET "${intimacy.ident}"=json_set("${intimacy.ident}",'$.次数',2.5) WHERE row_id=1`);
        assert(roleMutation && roleMutation.success !== false, JSON.stringify(roleMutation));
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.女性角色?.甲?.亲密状态?.次数 === 2.5);
        current.女性角色.甲.亲密状态.次数 = 2.5;
        assert.deepStrictEqual((await read()).女性角色, current.女性角色, '局部 SQL 保留同对象的其他公开字段与隐藏字段');
        const cacheGroup = converted.schema.find(g => g.name === '$缓存');
        const cacheMutation = await page.evaluate(async sql => window.AutoCardUpdaterAPI.executeSqlMutation(sql),
            `UPDATE "${cacheGroup.ident}" SET "${cacheGroup.columns[0].ident}"=json_set("${cacheGroup.columns[0].ident}",'$.开关',json('true')) WHERE row_id=1`);
        assert(cacheMutation && cacheMutation.success !== false, JSON.stringify(cacheMutation));
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.$缓存?.开关 === true);
        current.$缓存.开关 = true;
        assert(!Object.values(converted.template).find(s => s.name === cacheGroup.tableName).sourceData.hiddenPhysicalColumns?.includes(cacheGroup.columns[0].ident));
        const listGroup = converted.schema.find(g => g.name === '列表');
        const sql = `UPDATE "${listGroup.ident}" SET "${listGroup.columns[0].ident}"=json_remove("${listGroup.columns[0].ident}",'$[0]')`;
        const mutation = await page.evaluate(async sql => window.AutoCardUpdaterAPI.executeSqlMutation(sql), sql);
        assert(mutation && mutation.success !== false, JSON.stringify(mutation));
        await page.waitForFunction(() => window.Mvu.getMvuData().stat_data.列表?.length === 1);
        assert.deepStrictEqual((await read()).列表, [{ 名字: '相同', $缓存: '乙' }]);
        current.列表 = [{ 名字: '相同', $缓存: '乙' }];
        await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state);
        await waitCommittedGold(page, 37); await assertStorageMode(page, mode, '原消息状态刷新');
        assert.deepStrictEqual(await read(), current);
        assert.equal(await page.evaluate(async () => {
            const tables = window.AutoCardUpdaterAPI.exportTableAsJson();
            for (const sheet of Object.values(tables)) if (sheet?.content) sheet.content = [sheet.content[0]];
            return window.AutoCardUpdaterAPI.importTableAsJson(JSON.stringify(tables));
        }), true);
        assert.equal((await read()).$缓存, undefined, '清空数据库同步清除已映射隐藏状态，不从旧消息值复活');
        assert.deepStrictEqual((await read()).插图系统, { 解锁: ['一'] }, '未声明脚本根数据仍沿用原消息存储');
        assert(!((await read()).状态?.$内部), '数据库内对象清空不恢复旧隐藏子字段');
        assert.equal(await page.evaluate(async snapshot => window.Mvu.replaceMvuData({ stat_data: snapshot }), current), true);
        await waitCommittedGold(page, 37);
        assert.deepStrictEqual(await read(), current);
        record('stat-storage-' + mode, { originalVariables: true, perRecordJson: true, complexChildJson: true, opaqueScriptRoot: true, arrayOwnership: true, reload: true, databaseClear: true });
    }
};

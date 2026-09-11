'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, fs, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));

function openingTemplateBuilder(runtimeCore = core) {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    function buildUpdatedTemplateFromStat(');
    const end = source.indexOf('    // 已有聊天再做整表 import', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(source.slice(start, end) + '\nbuildUpdatedTemplateFromStat;', {
        window: { MVU2SHUJUKU_CORE: runtimeCore },
        collapseLegacyPairLeaves: clone,
        normalizeCellForSync: value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value,
    });
}

test('开场快照：先追平已有数组，再清空数组，生成的完整模板保留目标状态', async () => {
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const original = JSON.stringify(result.template);
    const before = { 状态: { 生命: 100, 金币: 77 }, 背包: ['已有进度', false] };
    const after = { 状态: { 生命: 80, 金币: 20 }, 背包: [] };
    const candidate = await openingTemplateBuilder()(layout, before, after, result.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, candidate).stat_data), after);
    assert.strictEqual(JSON.stringify(result.template), original, '构造候选模板不修改原始模板');
});

test('开场快照：追平或应用失败时拒绝候选，不能把半成品交给持久化', async () => {
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    for (const failAt of [1, 2]) {
        let calls = 0;
        const failingCore = {
            statDataFromTables: core.statDataFromTables,
            writeStatDiffToDb: async () => { calls += 1; return 0; },
            get lastStatWriteFailed() { return calls === failAt; },
        };
        await assert.rejects(openingTemplateBuilder(failingCore)(layout, {}, {}, result.template), /构建开场模板失败/);
        assert.strictEqual(calls, failAt, '失败后必须立即停止后续构造阶段');
    }
});

function messageSnapshotCommitter(layout) {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    async function commitMessageUpdateSnapshot(');
    const end = source.indexOf('    async function tryOpeningBulkInit(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(source.slice(start, end) + '\ncommitMessageUpdateSnapshot;', {
        activeLayout: layout, buildUpdatedTemplateFromStat: openingTemplateBuilder(),
        canonicalJsonForSync: JSON.stringify, assertRuntimeSession() {},
    });
}

test('消息持久化：一次整表导入承载本楼更新，不调用回写历史楼的手动 CRUD', async () => {
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const before = core.statDataFromTables(layout, result.template).stat_data;
    const after = clone(before); after.状态.金币 = 23;
    let committed, calls = 0;
    const api = { exportTableAsJson: () => result.template,
        importTableAsJson: async text => { committed = JSON.parse(text); calls += 1; return true; },
        updateCell: () => { throw new Error('不能向手动 CRUD 委派消息更新'); },
    };
    const commit = messageSnapshotCommitter(layout);
    assert.strictEqual(await commit(api, before, after, {}), true);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, committed).stat_data), after);
    assert.strictEqual(await commit(api, before, before, {}), false);
    assert.strictEqual(calls, 1, '没有变化不导入');
});

test('消息持久化：缺少导入、提交失败或规划期间快照变化时拒绝提交', async () => {
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const before = core.statDataFromTables(layout, result.template).stat_data;
    const after = clone(before); after.状态.金币 = 23;
    const commit = messageSnapshotCommitter(layout);
    await assert.rejects(commit({ exportTableAsJson: () => result.template }, before, after, {}), /整表导入能力/);
    await assert.rejects(commit({ exportTableAsJson: () => result.template, importTableAsJson: async () => false }, before, after, {}), /未提交成功/);
    let reads = 0, writes = 0;
    await assert.rejects(commit({
        exportTableAsJson: () => ++reads === 1 ? result.template : { ...result.template, changed: true },
        importTableAsJson: async () => { writes += 1; return true; },
    }, before, after, {}), /数据库已变化/);
    assert.strictEqual(writes, 0);
});

test('原生模式：SQL 读取 getter 隐藏时，已就绪的 CRUD 仍能成功写入', async () => {
    const result = core.convert(require('./synthetic-card')(), { installMvuShim: true });
    result.card.data.avatar = 'public-native.png';
    const tables = clone(result.template), api = applyingApi(tables);
    // SP 9.2.5 的 getter 在 native 模式一直返回 undefined，不是加载中。
    Object.defineProperties(api, {
        querySql: { get: () => undefined }, executeSqlQuery: { get: () => undefined },
    });
    let now = 0, id = 0;
    const timers = new Map();
    const schedule = (fn, delay, interval = 0) => { timers.set(++id, { fn, at: now + delay, interval }); return id; };
    const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
    async function advance(ms) {
        const until = now + ms;
        await drain();
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [key, timer] = next;
            now = timer.at; timers.delete(key);
            if (timer.interval) timers.set(key, { ...timer, at: now + timer.interval });
            timer.fn(); await drain();
        }
        now = until; await drain();
    }
    const handlers = new Map();
    const context = {
        characters: [result.card.data], characterId: 0, chatId: 'native-A',
        chat: [{ is_user: false, mes: '已初始化的首楼', TavernDB_ACU_IsolatedData: {
            test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: clone(tables) }, logEntries: [] } },
        } }],
        extensionSettings: { mvu2shujuku: {} },
        eventSource: { on(name, fn) { handlers.set(name, fn); }, emit() {} }, event_types: {},
        saveSettingsDebounced() {}, saveChat: async () => {}, saveChatConditional: async () => {},
    };
    const document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
        addEventListener() {}, body: { appendChild() {} } };
    const win = { console, document, TextDecoder, TextEncoder, Uint8Array, Blob,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        setTimeout: (fn, ms = 0) => schedule(fn, ms), clearTimeout: key => timers.delete(key),
        setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: key => timers.delete(key),
        addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {},
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: api,
    };
    win.window = win; win.parent = win; win.top = win; win.globalThis = win;
    vm.createContext(win);
    vm.runInContext(core.assembleExtension({ coreSource: fs.readFileSync(require.resolve('../src/mvu2shujuku'), 'utf8') })['index.js'], win);
    await advance(100);
    assert.strictEqual(typeof win.Mvu?.replaceMvuData, 'function');
    const next = win.Mvu.getMvuData(); next.stat_data.状态.金币 = 37;
    let settled;
    win.Mvu.replaceMvuData(next).then(value => { settled = value; });
    await advance(10000);
    assert.strictEqual(settled, true, '原生 CRUD 不依赖 SQL 查询能力，应成功结算');
    const status = Object.values(tables).find(sheet => sheet?.name === '状态表');
    assert.strictEqual(Number(status.content[1][status.content[0].indexOf('金币')]), 37);
});

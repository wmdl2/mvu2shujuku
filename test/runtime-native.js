'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, fs, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));

function openingTemplateBuilder(runtimeCore = core) {
    // 直接调用真实的候选构造函数（扩展运行时导出的同一份实现），不再按源码切片，
    // 也不用替身预检替代。
    return require('../src/extension-runtime').createCandidateBuilder({ core: runtimeCore }).buildUpdatedTemplateFromStat;
}

test('开场快照：浏览器内联工厂不依赖 Node 模块外部作用域', async () => {
    const factory = require('../src/extension-runtime').createCandidateBuilder;
    const inlineFactory = vm.runInNewContext('(' + factory.toString() + ')');
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const before = core.statDataFromTables(layout, result.template).stat_data;
    const after = clone(before);
    after.状态.生命 = 83;
    const candidate = await inlineFactory({ core }).buildUpdatedTemplateFromStat(layout, before, after, result.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, candidate).stat_data), after);
    assert.deepStrictEqual(core.statDataFromTables(layout, result.template).stat_data, before, '内联工厂不修改输入快照');
});

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

async function nativeRuntime(source = require('./synthetic-card')()) {
    const result = core.convert(source, { installMvuShim: true });
    result.card.data.avatar = 'public-native.png';
    const tables = clone(result.template), api = applyingApi(tables);
    const tableCallbacks = [];
    api.registerTableUpdateCallback = callback => { tableCallbacks.push(callback); return true; };
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
    return { win, context, tables, api, advance, tableCallbacks };
}

test('提交读缓存：脚本成功写入后立即读回新值，不等旧提交快照过期', async () => {
    const h = await nativeRuntime();
    await h.advance(2000);
    assert.ok(h.tableCallbacks.length, '必须经过真实宿主回调入口建立旧读窗口');
    for (const callback of h.tableCallbacks) await callback(clone(h.tables), { persisted: true });
    await h.advance(50);
    const before = h.win.Mvu.getMvuData();
    const next = clone(before); next.stat_data.状态.金币 = 37;
    let settled;
    h.win.Mvu.replaceMvuData(next).then(value => { settled = value; });
    await h.advance(1000);
    assert.strictEqual(settled, true);
    const sheet = Object.values(h.tables).find(s => s.name === '状态表');
    assert.strictEqual(Number(sheet.content[1][sheet.content[0].indexOf('金币')]), 37);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 37, '成功 Promise 后读视图必须追上本次已提交快照');
});

test('整组空值：真实运行时的完整替换保留删除意图，普通旧布局仍补齐遗漏组', async () => {
    const source = require('./synthetic-card')();
    const stat = { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 容器: { n: 1 }, 原有组: { 值: 7 } };
    source.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>';
    source.data.alternate_greetings = [];
    source.data.character_book.entries[0].content = JSON.stringify(stat);
    source.data.extensions.tavern_helper.scripts.push({ name: '结构', content: 'const S = z.object({ 容器: z.object({ n: z.number() }).nullish() }); registerMvuSchema(S);' });
    const h = await nativeRuntime(source);
    const replace = async next => {
        let settled;
        h.win.Mvu.replaceMvuData(next).then(value => { settled = value; });
        await h.advance(2000);
        assert.strictEqual(settled, true);
        return clone(h.win.Mvu.getMvuData().stat_data);
    };
    let next = h.win.Mvu.getMvuData(); next.stat_data.状态.金币 = 11;
    assert.deepStrictEqual((await replace(next)).容器, { n: 1 }, '读取完整基线后改其他字段不会清除容器');
    for (const value of [null, {}, undefined, { n: 2 }]) {
        next = h.win.Mvu.getMvuData();
        if (value === undefined) delete next.stat_data.容器; else next.stat_data.容器 = value;
        delete next.stat_data.原有组;
        const actual = await replace(next);
        assert.deepStrictEqual(actual.容器, value);
        assert.strictEqual(Object.hasOwn(actual, '容器'), value !== undefined);
        assert.deepStrictEqual(actual.原有组, { 值: 7 });
    }
});

test('原生模式：SQL 读取 getter 隐藏时，已就绪的 CRUD 仍能成功写入', async () => {
    const { win, tables, advance } = await nativeRuntime();
    const next = win.Mvu.getMvuData(); next.stat_data.状态.金币 = 37;
    let settled;
    win.Mvu.replaceMvuData(next).then(value => { settled = value; });
    await advance(10000);
    assert.strictEqual(settled, true, '原生 CRUD 不依赖 SQL 查询能力，应成功结算');
    const status = Object.values(tables).find(sheet => sheet?.name === '状态表');
    assert.strictEqual(Number(status.content[1][status.content[0].indexOf('金币')]), 37);
});

function floorSession(chat) {
    const factory = require('../src/runtime-session');
    const inline = vm.runInNewContext('(' + factory.toString() + ')');
    const manager = inline(() => ({ characterKey: 'c', chatKey: 'chat', cardKey: 'c' }));
    return { manager, session: manager.bindWriteTarget(manager.capture(), () => chat) };
}
const frameMessage = (keys = ['']) => ({ is_user: false, mes: 'reply',
    TavernDB_ACU_IsolatedData: Object.fromEntries(keys.map(key => [key, { storageFrame: { version: 2, logEntries: [] } }])) });

test('写入楼层：内联工厂保守验证所有作用域，新楼建帧后恢复差量', () => {
    const chat = [frameMessage(), { is_user: true }, { is_user: false, mes: 'new' }];
    const { manager, session } = floorSession(chat);
    assert.strictEqual(session.writeTarget.canUseCrud(), false);
    chat[2].TavernDB_ACU_IsolatedData = frameMessage().TavernDB_ACU_IsolatedData;
    assert.strictEqual(session.writeTarget.canUseCrud(), true);
    chat[0].TavernDB_ACU_IsolatedData.other = frameMessage(['other']).TavernDB_ACU_IsolatedData.other;
    assert.strictEqual(session.writeTarget.canUseCrud(), false, '不能把别的作用域已有本楼记录误当成当前作用域');
    chat[2].TavernDB_ACU_IsolatedData.other = chat[0].TavernDB_ACU_IsolatedData.other;
    assert.strictEqual(session.writeTarget.canUseCrud(), true);
    assert.strictEqual(manager.bindWriteTarget(session, () => chat), session, '重试保留原始目标');
});

test('写入楼层：未知/旧帧格式不能授权旧楼 CRUD，开场保持原路径', () => {
    for (const old of [
        { TavernDB_ACU_Data: { sheet_x: {} } },
        { TavernDB_ACU_IsolatedData: '{"":{}}' },
        { TavernDB_ACU_IsolatedData: { '': { independentData: { sheet_x: {} } } } },
        { TavernDB_ACU_IsolatedData: { '__proto__': null, bad: null } },
    ]) {
        const chat = [{ is_user: false, ...old }, { is_user: true }, frameMessage()];
        assert.strictEqual(floorSession(chat).session.writeTarget.canUseCrud(), false);
    }
    assert.strictEqual(floorSession([frameMessage()]).session.writeTarget.canUseCrud(), true);
});

test('写入楼层：删楼、换 swipe、编辑、新回复以及原有来源失效均取消', () => {
    for (const change of [chat => chat.pop(), chat => { chat[2].swipe_id = 1; },
        chat => { chat[2].mes = 'edited'; }, chat => chat.push(frameMessage()),
        chat => { chat[2] = { ...chat[2] }; }]) {
        const chat = [frameMessage(), { is_user: true }, frameMessage()];
        const { manager, session } = floorSession(chat);
        assert.strictEqual(manager.isCurrent(session), true);
        change(chat);
        assert.strictEqual(manager.isCurrent(session), false);
    }
    const chat = [frameMessage()]; const { manager } = floorSession(chat);
    let valid = true;
    const session = manager.bindWriteTarget(manager.capture(() => valid), () => chat);
    valid = false;
    assert.strictEqual(manager.isCurrent(session), false, '不能丢掉原有来源 validate');
});

test('写入楼层：每次 CRUD 前复查归属，不可靠时只允许正式导入', async () => {
    const chat = [frameMessage(), { is_user: true }, frameMessage()];
    const { manager, session } = floorSession(chat); let calls = 0;
    const api = manager.apiForSession({ updateCell() { calls++; }, importTableAsJson: async () => true }, session);
    api.updateCell(); assert.strictEqual(calls, 1);
    delete chat[2].TavernDB_ACU_IsolatedData;
    assert.throws(() => api.updateCell(), /旧楼 CRUD/);
    assert.strictEqual(calls, 1);
    assert.strictEqual(await api.importTableAsJson('{}'), true);
    chat.push(frameMessage());
    assert.throws(() => api.importTableAsJson('{}'), /会话或任务来源/);
});

// 模拟已核对的 SP 保存归属：普通 CRUD 追加到已有帧，导入写入最新 AI 回复。
function observeHostWrites(h, failImport = false) {
    const calls = [];
    for (const method of ['importTableAsJson', 'updateCell', 'updateRow', 'insertRow', 'deleteRow']) {
        const original = h.api[method];
        if (typeof original !== 'function') continue;
        h.api[method] = async (...args) => {
            calls.push(method);
            if (failImport && method === 'importTableAsJson') return false;
            const result = await original(...args);
            const eligible = h.context.chat.filter(m => !m.is_user && (method === 'importTableAsJson' || m.TavernDB_ACU_IsolatedData));
            const target = eligible.at(-1);
            target.TavernDB_ACU_IsolatedData = { test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: clone(h.tables) }, logEntries: [] } } };
            return result;
        };
    }
    return calls;
}
async function settleGold(h, gold) {
    const next = h.win.Mvu.getMvuData(); next.stat_data.状态.金币 = gold;
    let result;
    h.win.Mvu.replaceMvuData(next).then(value => { result = value; });
    await h.advance(15000);
    return result;
}

test('写入楼层：真实运行时新楼一次快照、随后差量，无变化不建帧', async () => {
    const h = await nativeRuntime(), calls = observeHostWrites(h);
    const opening = JSON.stringify(h.context.chat[0]);
    h.context.chat.push({ is_user: true, mes: 'user' }, { is_user: false, mes: 'new reply' });
    assert.strictEqual(await settleGold(h, 23), true);
    assert.deepStrictEqual(calls, ['importTableAsJson']);
    assert.strictEqual(JSON.stringify(h.context.chat[0]), opening, '开场帧不得被改写');
    assert.ok(h.context.chat[2].TavernDB_ACU_IsolatedData);
    calls.length = 0;
    assert.strictEqual(await settleGold(h, 24), true);
    assert.deepStrictEqual(calls, ['updateCell'], '第二次小修改必须回到差量路径');
    calls.length = 0;
    h.context.chat.push({ is_user: false, mes: 'another reply' });
    assert.strictEqual(await settleGold(h, 24), true);
    assert.deepStrictEqual(calls, [], '无变化不能导入或创建本楼表帧');
    assert.strictEqual(h.context.chat[3].TavernDB_ACU_IsolatedData, undefined);
});

test('写入楼层：真实运行时导入失败不降级旧楼 CRUD', async () => {
    const h = await nativeRuntime(), calls = observeHostWrites(h, true);
    const before = JSON.stringify(h.tables), opening = JSON.stringify(h.context.chat[0]);
    h.context.chat.push({ is_user: true }, { is_user: false, mes: 'new reply' });
    assert.strictEqual(await settleGold(h, 23), false);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(method => method === 'importTableAsJson'));
    assert.strictEqual(JSON.stringify(h.tables), before);
    assert.strictEqual(JSON.stringify(h.context.chat[0]), opening);
});

test('写入楼层：真实运行时候选规划期间新回复到来，旧提交取消', async () => {
    const h = await nativeRuntime(), calls = observeHostWrites(h);
    h.context.chat.push({ is_user: true }, { is_user: false, mes: 'target reply' });
    const runtimeCore = h.win.MVU2SHUJUKU_CORE, original = runtimeCore.writeStatDiffToDb;
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    runtimeCore.writeStatDiffToDb = async (...args) => { entered = true; await gate; return original(...args); };
    const next = h.win.Mvu.getMvuData(); next.stat_data.状态.金币 = 23;
    let settled;
    h.win.Mvu.replaceMvuData(next).then(value => { settled = value; });
    await h.advance(500);
    assert.strictEqual(entered, true, '必须已经进入真实候选构造');
    h.context.chat.push({ is_user: false, mes: 'later reply' });
    release(); await h.advance(15000);
    assert.strictEqual(settled, false);
    assert.deepStrictEqual(calls, []);
});

function addReplyWithFrame(h) {
    h.context.chat.push({ is_user: true, mes: 'user' }, { is_user: false, mes: 'reply',
        TavernDB_ACU_IsolatedData: clone(h.context.chat[0].TavernDB_ACU_IsolatedData) });
}
async function settleMutation(h, mutate) {
    const next = h.win.Mvu.getMvuData(); mutate(next.stat_data);
    let result;
    h.win.Mvu.replaceMvuData(next).then(value => { result = value; });
    await h.advance(15000);
    return result;
}

test('当前楼批次：混合扣金币与新增道具只提交一次完整快照', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const opening = JSON.stringify(h.context.chat[0]), calls = observeHostWrites(h);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), true);
    assert.deepStrictEqual(calls, ['importTableAsJson']);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 2);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.背包.at(-1), '药');
    assert.strictEqual(JSON.stringify(h.context.chat[0]), opening);
});

test('当前楼批次：混合写入被拒绝时不留下先完成的道具变更', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const before = JSON.stringify(h.tables), frame = JSON.stringify(h.context.chat[2]);
    const calls = observeHostWrites(h, true), updateCell = h.api.updateCell;
    h.api.updateCell = (...args) => args[2] === '金币' ? false : updateCell(...args);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.strictEqual(JSON.stringify(h.tables), before, '任何宿主写入之前就必须构造完整候选');
    assert.strictEqual(JSON.stringify(h.context.chat[2]), frame);
    assert.ok(calls.length > 0 && calls.every(method => method === 'importTableAsJson'));
});

test('当前楼批次：同一行多列保留一次 updateRow，拒绝后不拆成逐格写入', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.状态.生命 = 90; }), true);
    assert.deepStrictEqual(calls, ['updateRow']);
    const before = JSON.stringify(h.tables); calls.length = 0;
    h.api.updateRow = () => { calls.push('updateRow'); return false; };
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 1; stat.状态.生命 = 80; }), false);
    assert.ok(calls.length && calls.every(method => method === 'updateRow'));
    assert.strictEqual(JSON.stringify(h.tables), before);
});

test('当前楼批次：缺少整表接口时多步写入在任何 CRUD 前拒绝', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), before = JSON.stringify(h.tables);
    delete h.api.importTableAsJson;
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(JSON.stringify(h.tables), before);
});

test('当前楼批次：草稿规划中途失败不调用宿主、不提交半成品', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), before = JSON.stringify(h.tables);
    const runtimeCore = h.win.MVU2SHUJUKU_CORE, original = runtimeCore.writeStatDiffToDb;
    runtimeCore.writeStatDiffToDb = (api, ...rest) => original({ ...api,
        updateCell: (...args) => args[2] === '金币' ? false : api.updateCell(...args),
    }, ...rest);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(JSON.stringify(h.tables), before);
});

test('当前楼批次：宿主整批落库后返回失败，不回写旧快照或重复增加道具', async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), original = h.api.importTableAsJson;
    h.api.importTableAsJson = async (...args) => { await original(...args); return false; };
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), true);
    assert.deepStrictEqual(calls, ['importTableAsJson'], '重试按实际数据确认，无反向补偿或重复提交');
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 2);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.背包.filter(x => x === '药').length, 1);
});

test('当前楼批次：序列化工厂的数组多步和标量合成同一候选，保留未登记表', async () => {
    const inlineFactory = vm.runInNewContext('(' + core.getCandidateBuilderFactory().toString() + ')');
    const result = core.convert(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const tables = clone(result.template);
    tables.sheet_other = { name: '其它表', content: [['row_id', '保留'], [1, '原值']] };
    const before = core.statDataFromTables(layout, tables).stat_data, after = clone(before);
    after.状态.金币 = 2; after.背包 = ['药', true];
    const api = applyingApi(tables), original = JSON.stringify(tables);
    const plan = await inlineFactory({ core }).planCurrentReplyWrites(api, layout, before, after, tables);
    assert.strictEqual(JSON.stringify(tables), original, '规划不得触碰真实表引用');
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, plan.tables).stat_data), after);
    assert.deepStrictEqual(clone(plan.tables.sheet_other), tables.sheet_other);
    assert.ok(plan.operations.some(op => op.method === 'importTableAsJson'));
    assert.ok(plan.operations.length > 1, '数组内部导入仍须与外层标量合并提交');
});

test('当前楼批次：规划期间数据库变化或来源失效，不提交过时草稿', async () => {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    async function commitCurrentReplyBatch(');
    const end = source.indexOf('    async function tryOpeningBulkInit(', start);
    assert.ok(start >= 0 && end > start);
    for (const invalidation of ['database', 'source']) {
        const result = core.convert(require('./synthetic-card')());
        const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout), tables = clone(result.template);
        const api = applyingApi(tables), before = core.statDataFromTables(layout, tables).stat_data, after = clone(before);
        after.状态.金币 = 2; after.背包.push('药');
        let invalid = false, calls = 0;
        for (const name of ['updateRow', 'updateCell', 'insertRow', 'deleteRow', 'importTableAsJson']) api[name] = () => { calls++; throw new Error('不可写入'); };
        const trackedCore = { ...core, writeStatDiffToDb: async (...args) => {
            const n = await core.writeStatDiffToDb(...args);
            if (invalidation === 'database') tables.concurrentMarker = true;
            else invalid = true;
            return n;
        }, get lastStatWriteFailed() { return core.lastStatWriteFailed; } };
        const commit = vm.runInNewContext(source.slice(start, end) + '\ncommitCurrentReplyBatch;', {
            activeLayout: layout, dbgWarn() {}, window: { MVU2SHUJUKU_CORE: trackedCore,
                __MVU2SHUJUKU_CANDIDATE_BUILDER_FACTORY__: core.getCandidateBuilderFactory() },
            assertRuntimeSession() { if (invalid) throw new Error('来源失效'); },
        });
        await assert.rejects(commit(api, before, after, tables, {}), invalidation === 'database' ? /数据库已变化/ : /来源失效/);
        assert.strictEqual(calls, 0);
    }
});

test('可空动态记录：实际扩展 replace 立即读回和宿主回调保持记录语义', async () => {
    const sample = require('./nullable-records'), h = await nativeRuntime({ data: sample.source() });
    for (const value of [null, {}, undefined, { 数量: 4, 文本: '新值', 明细: { 保留: 2 } }]) {
        const next = h.win.Mvu.getMvuData();
        for (const dict of [next.stat_data.记录, next.stat_data.角色.甲.背包, next.stat_data.角色.甲.藏库.同名.效果]) {
            if (value === undefined) delete dict.同名; else dict.同名 = value;
        }
        const expected = clone(next.stat_data);
        let settled; h.win.Mvu.replaceMvuData(next).then(value => { settled = value; });
        for (let tick = 0; tick < 80 && settled === undefined; tick++) await h.advance(250);
        assert.strictEqual(settled, true);
        assert.deepStrictEqual(clone(h.win.Mvu.getMvuData().stat_data), expected);
        // applyingApi 只改运行时表；模拟宿主已持久化实际结果，避免把旧 checkpoint 当成回放窗口。
        h.context.chat[0].TavernDB_ACU_IsolatedData = { test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: clone(h.tables) }, logEntries: [] } } };
        for (const callback of h.tableCallbacks) await callback(clone(h.tables), { persisted: true });
        await h.advance(50);
        assert.deepStrictEqual(clone(h.win.Mvu.getMvuData().stat_data), expected);
    }
});

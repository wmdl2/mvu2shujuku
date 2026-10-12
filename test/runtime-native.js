'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
// Retained physical layouts are tested with frozen public metadata; current conversions use layout-planning.js.
const legacyLayoutFixture = require('./legacy-layout-fixture');
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, fs, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));

function openingTemplateBuilder(runtimeCore = core) {
    // 直接调用真实的候选构造函数（扩展运行时导出的同一份实现），不再按源码切片，
    // 也不用替身预检替代。
    return require('../src/extension-runtime').createCandidateBuilder({ core: runtimeCore }).buildUpdatedTemplateFromStat;
}

function greetingSnapshot(runtimeCore, validateCardStat, updateCycle, storedAll) {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    async function computeActiveGreetingSnapshot(');
    const end = source.indexOf('    async function applyActiveGreetingInitvar(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(source.slice(start, end) + '\ncomputeActiveGreetingSnapshot;', {
        window: { MVU2SHUJUKU_CORE: runtimeCore, getAllVariables: () => clone(storedAll || {}) }, getContextSafe: () => ({}),
        autoInitChatId: () => 'public-schema-opening', greetingMacroCache: {},
        validateCardStat, runMvuUpdateCycle: updateCycle,
        emitMvuEvent: async () => {},
    });
}

function plainGreetingSource(metadata) {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    function messageUpdateBlocks(');
    const end = source.indexOf('    function guardGreetingSource(', start);
    assert.ok(start >= 0 && end > start);
    const first = { mes: '公开开场。', is_user: false };
    return vm.runInNewContext(source.slice(start, end) + '\nactiveGreetingSourceSnapshot;', {
        window: { MVU2SHUJUKU_CORE: core }, getContextSafe: () => ({ chat: [first] }),
        readCardApiMetadata: () => metadata,
    });
}

test("旧布局：开场 Schema：世界书初值没有内联块也校验，首次建表可延后", async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs');
    const metadata = { schemaKeys: ['public'] };
    const api = require('../src/card-api')({ readMetadata: () => metadata, isCurrent: () => true });
    let parses = 0;
    api.registerSchema(z.object({ 账户: z.object({ 等级: z.number().transform(value => {
        parses++; return Math.max(1, Math.min(100, value));
    }) }) }), 'public');
    const source = plainGreetingSource(metadata)();
    assert.strictEqual(source.schemaOnly, true);
    assert.strictEqual(source.m, null);
    const compute = greetingSnapshot(core, stat => api.validate(stat));
    const initial = { stat_data: { 账户: { 等级: 0 } } };
    const deferred = await compute(initial, source, { deferSchema: true });
    assert.strictEqual(deferred.schemaDeferred, true);
    assert.strictEqual(parses, 0);
    const settled = await compute(initial, source);
    assert.strictEqual(settled.schemaDeferred, false);
    assert.deepStrictEqual(clone(settled.finalWrap.stat_data), { 账户: { 等级: 1 } });
    assert.strictEqual(parses, 1);
});

test("旧布局：开场 Schema：无任务缓存不阻止晚到的Schema元数据，普通卡仍无任务", () => {
    const metadata = { schemaKeys: [] }, capture = plainGreetingSource(metadata);
    assert.strictEqual(capture(), null);
    metadata.schemaKeys = ['public'];
    const source = capture();
    assert.strictEqual(source.schemaOnly, true);
    assert.strictEqual(capture(), source);
    metadata.schemaKeys = [];
    assert.strictEqual(capture(), null);
});

test("旧布局：开场 Schema：已有世界书初值存档只建基线，不重放Schema", async () => {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    async function applyActiveGreetingInitvar(');
    const end = source.indexOf('    // 扩展成为唯一 runtime owner', start);
    assert.ok(start >= 0 && end > start);
    const metadata = { schemaKeys: ['public'] }, snapshot = plainGreetingSource(metadata)();
    const state = { ready: true, baselineNext: true }, stored = { stat_data: { 账户: { 等级: 23 } } };
    let parses = 0;
    const apply = vm.runInNewContext(source.slice(start, end) + '\napplyActiveGreetingInitvar;', {
        captureRuntimeSession: () => ({}), autoInitChatId: () => 'stored', greetingInitState: () => state,
        activeGreetingSourceSnapshot: () => snapshot, mvuMessageWrites: new Map(), guardGreetingSource: () => {},
        isRuntimeSessionCurrent: () => true,
        computeActiveGreetingSnapshot: greetingSnapshot(core, () => { parses++; throw new Error('不得重放'); }, undefined, stored),
        scheduleWindowStatOverlay: () => { throw new Error('不得重写存档'); },
        dbg: () => {}, dbgWarn: (...args) => { throw args.find(value => value instanceof Error) || new Error('unexpected failure'); },
    });
    await apply();
    assert.strictEqual(parses, 0);
    assert.strictEqual(state.baselineNext, false);
    assert.strictEqual(state.appliedSourceFp, snapshot.sourceFp);
    assert.strictEqual(state.pendingSourceFp, '');
    assert.deepStrictEqual(stored.stat_data, { 账户: { 等级: 23 } });
});

test("旧布局：开场 Schema：纯 InitVar 先运行作者预处理，旧名删除、新名和记录保留", async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs');
    const api = require('../src/card-api')({ readMetadata: () => ({ schemaKeys: ['public'] }), isCurrent: () => true });
    let parses = 0;
    const declared = z.preprocess(data => {
        parses++;
        if (data.旧事件 !== undefined) { data.新事件 = data.旧事件; delete data.旧事件; }
        return data;
    }, z.object({ 新事件: z.record(z.string(), z.union([z.boolean(), z.string()])).prefault({}) }));
    api.registerSchema(declared, 'public');
    const source = { first: {}, text: '公开开场', m: ['', '{"旧事件":{"待结算":true,"说明":"保留"}}'], updateSource: '', sourceFp: 'one', swipe: 0 };
    const result = await greetingSnapshot(core, stat => api.validate(stat))({ stat_data: {} }, source);
    assert.deepStrictEqual(clone(result.finalWrap.stat_data), { 新事件: { 待结算: true, 说明: '保留' } });
    assert.deepStrictEqual(clone(result.finalWrap.display_data), clone(result.finalWrap.stat_data));
    assert.strictEqual(parses, 1);
});

test("旧布局：开场 Schema：校验失败拒绝快照，无 InitVar 不额外运行变换", async () => {
    let calls = 0;
    const compute = greetingSnapshot(core, async () => { calls++; throw new Error('无效原卡 Schema'); });
    const source = { first: {}, text: '公开开场', updateSource: '', sourceFp: 'one', swipe: 0 };
    const unchanged = await compute({ stat_data: { 状态: 3 } }, source);
    assert.deepStrictEqual(clone(unchanged.finalWrap.stat_data), { 状态: 3 });
    assert.strictEqual(calls, 0);
    await assert.rejects(compute({ stat_data: {} }, { ...source, m: ['', '{"状态":3}'] }), /无效原卡 Schema/);
    assert.strictEqual(calls, 1);
});

test("旧布局：开场 Schema：首次建表不等待依赖数据就绪的登记，仍保留后续校验任务", async () => {
    let calls = 0;
    const compute = greetingSnapshot(core, async stat => { calls++; return { 状态: stat.状态 + 1 }; });
    const source = { first: {}, text: '公开开场', m: ['', '{"状态":3}'], updateSource: '', sourceFp: 'one', swipe: 0 };
    const initial = await compute({ stat_data: {} }, source, { deferSchema: true });
    assert.strictEqual(initial.schemaDeferred, true);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(clone(initial.finalWrap.stat_data), { 状态: 3 });
    const settled = await compute({ stat_data: {} }, source);
    assert.strictEqual(settled.schemaDeferred, false);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(clone(settled.finalWrap.stat_data), { 状态: 4 });
});

test("旧布局：开场 Schema：含更新指令的开场复用原更新周期，不二次执行变换", async () => {
    let calls = 0;
    const compute = greetingSnapshot(core, () => { throw new Error('不得重复校验'); }, async (_, wrap) => {
        calls++; wrap.stat_data.状态++; return wrap;
    });
    const result = await compute({ stat_data: {} }, { first: {}, text: '公开开场', m: ['', '{"状态":3}'], updateSource: '<JSONPatch>[]</JSONPatch>', sourceFp: 'one', swipe: 0 });
    assert.deepStrictEqual(clone(result.finalWrap.stat_data), { 状态: 4 });
    assert.strictEqual(calls, 1);
});

test("旧布局：开场快照：浏览器内联工厂不依赖 Node 模块外部作用域", async () => {
    const factory = require('../src/extension-runtime').createCandidateBuilder;
    const inlineFactory = vm.runInNewContext('(' + factory.toString() + ')');
    const result = publishedLayoutFixture(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const before = core.statDataFromTables(layout, result.template).stat_data;
    const after = clone(before);
    after.状态.生命 = 83;
    const candidate = await inlineFactory({ core }).buildUpdatedTemplateFromStat(layout, before, after, result.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, candidate).stat_data), after);
    assert.deepStrictEqual(core.statDataFromTables(layout, result.template).stat_data, before, '内联工厂不修改输入快照');
});

test("旧布局：开场快照：先追平已有数组，再清空数组，生成的完整模板保留目标状态", async () => {
    const result = publishedLayoutFixture(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    const original = JSON.stringify(result.template);
    const before = { 状态: { 生命: 100, 金币: 77 }, 背包: ['已有进度', false] };
    const after = { 状态: { 生命: 80, 金币: 20 }, 背包: [] };
    const candidate = await openingTemplateBuilder()(layout, before, after, result.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, candidate).stat_data), after);
    assert.strictEqual(JSON.stringify(result.template), original, '构造候选模板不修改原始模板');
});

test("旧布局：开场快照：追平或应用失败时拒绝候选，不能把半成品交给持久化", async () => {
    const result = publishedLayoutFixture(require('./synthetic-card')());
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout);
    for (const failAt of [1, 2]) {
        let calls = 0;
        const failingCore = {
            statDataFromTables: core.statDataFromTables,
            writeStatDiffToDbResult: async () => { calls += 1; return {
                ok: calls !== failAt, plannedChanges: 1, failureReason: calls === failAt ? '规划失败' : null,
            }; },
            get lastStatWriteFailed() { throw new Error('新调用不得读取共享失败状态'); },
        };
        await assert.rejects(openingTemplateBuilder(failingCore)(layout, {}, {}, result.template), /构建开场模板失败/);
        assert.strictEqual(calls, failAt, '失败后必须立即停止后续构造阶段');
    }
});

test("旧布局：写入结果：候选构造和当前回复规划不读取旧失败标记", async () => {
    const converted = publishedLayoutFixture(require('./synthetic-card')());
    const layout = JSON.parse(converted.card.data.extensions.mvu2shujuku.layout);
    const before = core.statDataFromTables(layout, converted.template).stat_data;
    const after = clone(before); after.状态.金币 = 27;
    const isolatedCore = { ...core,
        writeStatDiffToDb() { throw new Error('不得使用旧数字接口'); },
        get lastStatWriteFailed() { throw new Error('不得读取旧失败标记'); },
    };
    const builder = require('../src/extension-runtime').createCandidateBuilder({ core: isolatedCore });
    const candidate = await builder.buildUpdatedTemplateFromStat(layout, before, after, converted.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, candidate).stat_data), after);
    const draft = await builder.planCurrentReplyWrites(applyingApi(converted.template), layout, before, after, converted.template);
    assert.deepStrictEqual(clone(core.statDataFromTables(layout, draft.tables).stat_data), after);
    assert.ok(draft.operations.length > 0);
    assert.deepStrictEqual(core.statDataFromTables(layout, converted.template).stat_data, before);
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

test("旧布局：消息持久化：一次整表导入承载本楼更新，不调用回写历史楼的手动 CRUD", async () => {
    const result = publishedLayoutFixture(require('./synthetic-card')());
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

test("旧布局：消息持久化：缺少导入、提交失败或规划期间快照变化时拒绝提交", async () => {
    const result = publishedLayoutFixture(require('./synthetic-card')());
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

async function nativeRuntime(source = require('./synthetic-card')(), configure) {
    const result = publishedLayoutFixture(source, { installMvuShim: true });
    result.card.data.avatar = 'public-native.png';
    const tables = clone(result.template), api = applyingApi(tables);
    const tableCallbacks = [];
    api.registerTableUpdateCallback = callback => { tableCallbacks.push(callback); return true; };
    // This runtime harness uses a CRUD substitute. New conversions require a
    // published SQL read capability; these getters simulate readiness only.
    // configure can withdraw it to test loading/native refusal explicitly.
    Object.defineProperties(api, {
        querySql: { configurable: true, get: () => () => ({ columns: ['ready'], rows: [[1]] }) },
        executeSqlQuery: { configurable: true, get: () => () => ({ columns: ['ready'], rows: [[1]] }) },
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
        eventSource: { on(name, fn) { handlers.set(name, fn); }, async emit(name, ...args) { const fn = handlers.get(name); if (fn) await fn(...args); } }, event_types: {},
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
    if (configure) configure({ win, context, tables, api, now: () => now });
    vm.createContext(win);
    vm.runInContext(core.assembleExtension({ coreSource: fs.readFileSync(require.resolve('../src/mvu2shujuku'), 'utf8') })['index.js'], win);
    await advance(100);
    assert.strictEqual(typeof win.Mvu?.replaceMvuData, 'function');
    return { win, context, tables, api, advance, tableCallbacks, handlers };
}

test("旧布局：开场恢复：内部Schema提交后丢失载体仍恢复已提交值，不回退模板占位值", async () => {
    const source = { name: '公开开场提交缓存', first_mes: '开场', character_book: { entries: [{ comment: '[InitVar]', enabled: false, content: JSON.stringify({组:{时间:'待初始化',备注:'保留'}}) }] },
        extensions: { tavern_helper: { scripts: [{enabled:true,content:'import {registerMvuSchema} from "https://example.test/mvu_zod.js";const S=z.object({组:z.object({时间:z.enum(["白天","夜晚"]).catch(""),备注:z.string()})});registerMvuSchema(S);'}] } } };
    const h = await nativeRuntime({spec:'chara_card_v3',spec_version:'3.0',data:source}, ({win,context,api,tables,now}) => {
        const clockStart = Date.now();
        win.Date = class extends Date { static now() { return clockStart + now(); } };
        context.event_types.MESSAGE_RECEIVED = 'received';
        context.chat[0].mes = '开场'; delete context.chat[0].TavernDB_ACU_IsolatedData;
        for (const key of Object.keys(tables)) delete tables[key];
        const importTables = api.importTableAsJson;
        api.importTableAsJson = async (...args) => {
            const result = await importTables(...args);
            context.chat[0].TavernDB_ACU_IsolatedData = {test:{storageFrame:{version:2,checkpoint:{kind:'full',data:clone(tables)},logEntries:[]}}};
            return result;
        };
        api.initGameSession = async (_, options) => {
            await api.importTableAsJson(JSON.stringify(options.templateData));
            context.chat[0].TavernDB_ACU_IsolatedData = {test:{storageFrame:{version:2,checkpoint:{kind:'full',data:clone(tables)},logEntries:[]}}};
            return {success:true};
        };
    });
    const z = require('../src/vendor/schema-engine-libs').zod;
    const key = h.context.characters[0].extensions.mvu2shujuku.schemaKeys[0];
    assert.strictEqual(h.win.Mvu.registerSchema(z.object({组:z.object({时间:z.enum(['白天','夜晚']).catch(''),备注:z.string()})}), key), true);
    await h.advance(8000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.组.时间, '');
    const layout = JSON.parse(h.context.characters[0].extensions.mvu2shujuku.layout);
    assert.strictEqual(core.statDataFromTables(layout,h.context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame.checkpoint.data).stat_data.组.时间, '', '先证明提交完成，不能以待写覆盖值充当存档');
    delete h.context.chat[0].TavernDB_ACU_IsolatedData;
    await h.context.eventSource.emit('received', 0); await h.advance(8000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.组.时间, '', '恢复必须使用已提交Schema输出');
});

function placeholderCard() {
    const source = require('./synthetic-card')();
    source.data.extensions.regex_scripts.push({ scriptName: '占位符', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', disabled: false });
    return source;
}

test("旧布局：占位符维护：原版 ST 和 TT 虚拟化保留助手刷新，TT 静态使用宿主且不重画相同内容", async () => {
    for (const mode of ['st', 'managed', 'static', 'static-identical']) {
        const calls = [], rendered = [];
        const h = await nativeRuntime(placeholderCard(), ({ win, context }) => {
            context.event_types = { CHAT_CHANGED: 'chat_changed', CHARACTER_MESSAGE_RENDERED: 'rendered' };
            context.setChatMessages = async (messages, options) => { calls.push(options.refresh); context.chat[0].mes = messages[0].message; };
            context.updateMessageBlock = (id, msg) => { rendered.push(id); assert.strictEqual(msg, context.chat[0]); };
            context.messageFormatting = text => mode === 'static-identical' ? text.replace(/\s*<StatusPlaceHolderImpl\/>$/, '') : text;
            if (mode !== 'st') win.__TAURITAVERN__ = { api: { chatSurface: { isManagedOwnershipRequired: () => mode === 'managed' } } };
        });
        const before = JSON.stringify(h.tables);
        await h.context.eventSource.emit('chat_changed'); await h.advance(1300);
        assert.deepStrictEqual(calls, [mode.startsWith('static') ? 'none' : 'affected'], mode);
        assert.deepStrictEqual(rendered, mode === 'static' ? [0] : [], mode);
        assert.ok(h.context.chat[0].mes.includes('<StatusPlaceHolderImpl/>'));
        assert.strictEqual(JSON.stringify(h.tables), before, '补占位符不修改业务表');
        await h.context.eventSource.emit('chat_changed'); await h.advance(1300);
        assert.strictEqual(calls.length, 1, '已有占位符不重复保存或刷新');
    }
});

test("旧布局：占位符维护：等待保存时切聊天不刷新新聊天，保存拒绝可由下一事件重试", async () => {
    let release, renders = 0, attempts = 0;
    const h = await nativeRuntime(placeholderCard(), ({ win, context }) => {
        context.event_types = { CHAT_CHANGED: 'chat_changed', CHARACTER_MESSAGE_RENDERED: 'rendered' };
        win.__TAURITAVERN__ = { api: { chatSurface: { isManagedOwnershipRequired: () => false } } };
        context.updateMessageBlock = () => { renders++; };
        context.setChatMessages = async () => { attempts++; await new Promise(resolve => { release = resolve; }); };
    });
    await h.context.eventSource.emit('chat_changed'); await h.advance(1300);
    assert.strictEqual(attempts, 1);
    h.context.chatId = 'native-B'; h.context.chat = [{ is_user: false, mes: '新聊天' }];
    release(); await h.advance(0);
    assert.strictEqual(renders, 0);
    assert.strictEqual(h.context.chat[0].mes, '新聊天');
    let rejected = false;
    h.context.setChatMessages = async (messages, options) => {
        attempts++;
        if (!rejected) { rejected = true; throw new Error('夹具保存拒绝'); }
        h.context.chat[0].mes = messages[0].message;
        assert.strictEqual(options.refresh, 'none');
    };
    await h.context.eventSource.emit('chat_changed'); await h.advance(1300);
    assert.ok(rejected); assert.strictEqual(renders, 0);
    await h.context.eventSource.emit('chat_changed'); await h.advance(1300);
    assert.ok(h.context.chat[0].mes.includes('<StatusPlaceHolderImpl/>'));
    assert.strictEqual(renders, 1);
});

test("旧布局：前端就绪：完整零值和 false 状态也广播初始化，未物化空壳不广播", async () => {
    const source = require('./synthetic-card')();
    source.data.first_mes = '零值开场';
    source.data.character_book.entries = [{ comment: '[InitVar]', content: JSON.stringify({ 状态: { 积分: 0, 开关: false } }), enabled: true }];
    for (const provenance of ['runtime', 'persisted', 'empty']) {
        const ready = provenance !== 'empty';
        const events = [];
        const h = await nativeRuntime(source, ({ win, context }) => {
            context.event_types = { CHAT_CHANGED: 'chat_changed' };
            win.eventEmit = (name, ...args) => { events.push({ name, args }); return context.eventSource.emit(name, ...args); };
        });
        if (provenance !== 'runtime') {
            h.api.exportTableAsJson = () => ({});
            h.api.isReady = () => false;
            if (!ready) h.context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame.checkpoint.data = {};
        }
        await h.context.eventSource.emit('chat_changed'); await h.advance(6500);
        const initialized = events.filter(e => e.name === 'mag_variable_initialized');
        assert.strictEqual(initialized.length, ready ? 1 : 0);
        if (ready) assert.deepStrictEqual(JSON.parse(JSON.stringify(initialized[0].args[0].stat_data)), { 状态: { 积分: 0, 开关: false } });
    }
});

test("旧布局：变量回放：未加载的 JSON 标量骨架不能被脚本读取并转换写回", async () => {
    const source = require('./synthetic-card')();
    source.data.character_book.entries = [{ comment: '[InitVar]', content: '{"主角名":"林验收","状态":{"积分":0}}', enabled: false }];
    const h = await nativeRuntime(source);
    const original = JSON.stringify(h.tables);
    const frame = h.context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame;
    const realTables = clone(frame.checkpoint.data);
    h.api.exportTableAsJson = () => ({});
    h.api.isReady = () => false;
    for (const partial of [false, true]) {
        frame.checkpoint.data = partial ? Object.fromEntries(Object.entries(realTables).filter(([, v]) => v?.name !== '主角名表')) : {};
        const readonly = h.win.getAllVariables();
        assert.strictEqual(readonly.__mvu2shujukuReadUnavailable, true);
        assert.strictEqual(Object.keys(readonly).includes('__mvu2shujukuReadUnavailable'), false, '读取标记不得写入 JSON 或模板变量');
        assert.throws(() => {
            const data = h.win.Mvu.getMvuData();
            data.stat_data.主角名 = String(data.stat_data.主角名);
        }, error => error.code === 'MVU_DATA_NOT_READY');
        assert.throws(() => h.win.getVariables({ type: 'message' }), error => error.code === 'MVU_DATA_NOT_READY');
        let called = false;
        assert.strictEqual(await h.win.updateVariablesWith(data => { called = true; data.stat_data.主角名 = String(data.stat_data.主角名); return data; }, { type: 'message' }), false);
        assert.strictEqual(called, false, '没有真实基线时不执行业务回调');
        await h.advance(500);
        assert.strictEqual(JSON.stringify(h.tables), original, '拒绝骨架读写后物理数据保持原样');
    }
    frame.checkpoint.data = realTables;
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.主角名, '林验收', '完整持久化帧仍可在运行时空窗内读取');
    h.api.exportTableAsJson = () => h.tables;
    assert.strictEqual(h.win.getVariables({ type: 'message' }).stat_data.主角名, '林验收');
});

test("旧布局：变量回放：共享全局初始化等待完整数据，恢复后才启动作者脚本", async () => {
    let initialized = 0;
    const h = await nativeRuntime(undefined, ({ win }) => {
        win.waitGlobalInitialized = () => Promise.resolve('宿主');
    });
    const frame = h.context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame;
    const realTables = clone(frame.checkpoint.data);
    frame.checkpoint.data = {};
    h.api.exportTableAsJson = () => ({});
    const child = { document: { querySelectorAll: () => [] }, closed: false,
        waitGlobalInitialized: () => Promise.resolve('宿主'), initializeGlobal() { initialized++; },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    };
    h.win.document.querySelectorAll = selector => selector === 'iframe' ? [{ contentWindow: child }] : [];
    await h.advance(2500);
    assert.strictEqual(initialized, 0, '数据空窗不能向新脚本广播已就绪');
    assert.strictEqual(await child.waitGlobalInitialized('其他'), '宿主');
    let ready = false;
    const waiting = child.waitGlobalInitialized('Mvu').then(mvu => { ready = true; return mvu; });
    await h.advance(300);
    assert.strictEqual(ready, false);
    frame.checkpoint.data = realTables;
    await h.advance(2200);
    assert.strictEqual((await waiting).getMvuData().stat_data.状态.金币, 10);
    assert.strictEqual(initialized, 1);
});

test("旧布局：运行内存：完整扩展在 iframe 移除后还原接口并释放登记", async () => {
    const h = await nativeRuntime();
    let now = Date.now();
    h.win.Date = class extends Date { static now() { return now; } };
    const frames = [];
    h.win.document.querySelectorAll = selector => selector === 'iframe' ? frames.slice() : [];
    const register = () => h.win.__mvu2shujukuGlobalState.list;
    const baseline = register().length;
    for (let i = 0; i < 12; i++) {
        const original = () => ({ original: i });
        let initialized = 0;
        const child = { document: { querySelectorAll: () => [] }, closed: false,
            getVariables: original, initializeGlobal() { initialized++; },
            addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
        };
        const frame = { contentWindow: child, addEventListener() {}, removeEventListener() {} };
        frames.push(frame); now += 2500; await h.advance(2500);
        assert.ok(register().some(rec => rec.w === child), '必须经过真实运行时接管');
        assert.notStrictEqual(child.getVariables, original);
        now += 2500; await h.advance(2500);
        assert.strictEqual(initialized, 1, '存活窗口的初始化仍按函数去重');
        frames.pop(); now += 2500; await h.advance(2500);
        assert.strictEqual(child.getVariables, original);
        assert.strictEqual(register().length, baseline, '移除后恢复到固定窗口数量');
    }
});

test("旧布局：MVU 命令运行时：parseMessage 注入解析库后修复 JSONPatch，无法修复时保留旧值", async () => {
    const { win } = await nativeRuntime();
    win.__MVU2SHUJUKU_YAML_LIBS__ = require('../src/vendor/mvu-yaml-libs');
    const base = { stat_data: { score: 1 } };
    const repaired = await win.Mvu.parseMessage(
        '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/score","value":2},]</JSONPatch></UpdateVariable>', base);
    assert.strictEqual(repaired.stat_data.score, 2);
    assert.strictEqual(base.stat_data.score, 1);
    const ignored = await win.Mvu.parseMessage(
        '<UpdateVariable><JSONPatch>this is not a patch !!!</JSONPatch></UpdateVariable>', base);
    assert.strictEqual(ignored.stat_data.score, 1);
});

test("旧布局：提交读缓存：脚本成功写入后立即读回新值，不等旧提交快照过期", async () => {
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

test("旧布局：整组空值：真实运行时的完整替换保留删除意图，普通旧布局仍补齐遗漏组", async () => {
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

test("旧布局：原生模式：SQL 读取 getter 隐藏时，已就绪的 CRUD 仍能成功写入", async () => {
    const { win, tables, advance } = await nativeRuntime();
    const next = win.Mvu.getMvuData(); next.stat_data.状态.金币 = 37;
    let settled;
    win.Mvu.replaceMvuData(next).then(value => { settled = value; });
    await advance(10000);
    assert.strictEqual(settled, true, '原生 CRUD 不依赖 SQL 查询能力，应成功结算');
    const status = Object.values(tables).find(sheet => sheet?.name === '状态表');
    assert.strictEqual(Number(status.content[1][status.content[0].indexOf('金币')]), 37);
});

for (const recover of [true, false]) test('写入结果：真实运行时按本次失败重试且忽略旧状态 ' + (recover ? '恢复' : '持续失败'), async () => {
    const h = await nativeRuntime();
    const runtimeCore = h.win.MVU2SHUJUKU_CORE;
    const write = runtimeCore.writeStatDiffToDbResult;
    const beforeGold = h.win.Mvu.getMvuData().stat_data.状态.金币;
    let calls = 0;
    runtimeCore.writeStatDiffToDbResult = (...args) => {
        calls++;
        if (recover && calls > 1) return write(...args);
        return Promise.resolve({ ok: false, plannedChanges: 1, failureReason: '临时写入失败' });
    };
    runtimeCore.writeStatDiffToDb = () => { throw new Error('不得使用旧数字接口'); };
    Object.defineProperty(runtimeCore, 'lastStatWriteFailed', {
        get() { throw new Error('不得读取旧失败标记'); },
    });
    assert.strictEqual(await settleGold(h, 37), recover);
    assert.ok(calls > 1 && calls <= 7, '初次尝试加最多6次重试：' + calls);
    const status = Object.values(h.tables).find(sheet => sheet?.name === '状态表');
    assert.strictEqual(Number(status.content[1][status.content[0].indexOf('金币')]), recover ? 37 : Number(beforeGold));
});

function floorSession(chat) {
    const factory = require('../src/runtime-session');
    const inline = vm.runInNewContext('(' + factory.toString() + ')');
    const manager = inline(() => ({ characterKey: 'c', chatKey: 'chat', cardKey: 'c' }));
    return { manager, session: manager.bindWriteTarget(manager.capture(), () => chat) };
}
const frameMessage = (keys = ['']) => ({ is_user: false, mes: 'reply',
    TavernDB_ACU_IsolatedData: Object.fromEntries(keys.map(key => [key, { storageFrame: { version: 2, logEntries: [] } }])) });

test("旧布局：写入楼层：内联工厂保守验证所有作用域，新楼建帧后恢复差量", () => {
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

test("旧布局：写入楼层：未知/旧帧格式不能授权旧楼 CRUD，开场保持原路径", () => {
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

test("旧布局：写入楼层：删楼、换 swipe、编辑、新回复以及原有来源失效均取消", () => {
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

test("旧布局：写入楼层：每次 CRUD 前复查归属，不可靠时只允许正式导入", async () => {
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

test("旧布局：写入楼层：真实运行时新楼一次快照、随后差量，无变化不建帧", async () => {
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

test("旧布局：写入楼层：真实运行时导入失败不降级旧楼 CRUD", async () => {
    const h = await nativeRuntime(), calls = observeHostWrites(h, true);
    const before = JSON.stringify(h.tables), opening = JSON.stringify(h.context.chat[0]);
    h.context.chat.push({ is_user: true }, { is_user: false, mes: 'new reply' });
    assert.strictEqual(await settleGold(h, 23), false);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(method => method === 'importTableAsJson'));
    assert.strictEqual(JSON.stringify(h.tables), before);
    assert.strictEqual(JSON.stringify(h.context.chat[0]), opening);
});

test("旧布局：写入楼层：真实运行时候选规划期间新回复到来，旧提交取消", async () => {
    const h = await nativeRuntime(), calls = observeHostWrites(h);
    h.context.chat.push({ is_user: true }, { is_user: false, mes: 'target reply' });
    const runtimeCore = h.win.MVU2SHUJUKU_CORE, original = runtimeCore.writeStatDiffToDbResult;
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    runtimeCore.writeStatDiffToDbResult = async (...args) => { entered = true; await gate; return original(...args); };
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

test("旧布局：当前楼批次：混合扣金币与新增道具只提交一次完整快照", async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const opening = JSON.stringify(h.context.chat[0]), calls = observeHostWrites(h);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), true);
    assert.deepStrictEqual(calls, ['importTableAsJson']);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 2);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.背包.at(-1), '药');
    assert.strictEqual(JSON.stringify(h.context.chat[0]), opening);
});

test("旧布局：旧卡首楼批次：缺少 statStorage 元数据时混合写入仍只提交一次", async () => {
    const h = await nativeRuntime(undefined, ({ context }) => {
        delete context.characters[0].extensions.mvu2shujuku.statStorage;
        context.characters[0].extensions.mvu2shujuku.version = '0.4.0';
    });
    const calls = observeHostWrites(h);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), true);
    assert.deepStrictEqual(calls, ['importTableAsJson']);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 2);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.背包.at(-1), '药');
});

test("旧布局：旧卡首楼批次：整批提交被拒绝时不能留下先写成功的字段", async () => {
    const h = await nativeRuntime(undefined, ({ context }) => {
        delete context.characters[0].extensions.mvu2shujuku.statStorage;
    });
    const before = JSON.stringify(h.tables), calls = observeHostWrites(h, true);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.strictEqual(JSON.stringify(h.tables), before);
    assert.ok(calls.length > 0 && calls.every(method => method === 'importTableAsJson'));
});

test("旧布局：当前楼批次：混合写入被拒绝时不留下先完成的道具变更", async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const before = JSON.stringify(h.tables), frame = JSON.stringify(h.context.chat[2]);
    const calls = observeHostWrites(h, true), updateCell = h.api.updateCell;
    h.api.updateCell = (...args) => args[2] === '金币' ? false : updateCell(...args);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.strictEqual(JSON.stringify(h.tables), before, '任何宿主写入之前就必须构造完整候选');
    assert.strictEqual(JSON.stringify(h.context.chat[2]), frame);
    assert.ok(calls.length > 0 && calls.every(method => method === 'importTableAsJson'));
});

test("旧布局：当前楼批次：同一行多列保留一次 updateRow，拒绝后不拆成逐格写入", async () => {
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

test("旧布局：当前楼批次：缺少整表接口时多步写入在任何 CRUD 前拒绝", async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), before = JSON.stringify(h.tables);
    delete h.api.importTableAsJson;
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(JSON.stringify(h.tables), before);
});

test("旧布局：当前楼批次：草稿规划中途失败不调用宿主、不提交半成品", async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), before = JSON.stringify(h.tables);
    const runtimeCore = h.win.MVU2SHUJUKU_CORE, original = runtimeCore.writeStatDiffToDbResult;
    runtimeCore.writeStatDiffToDbResult = (api, ...rest) => original({ ...api,
        updateCell: (...args) => args[2] === '金币' ? false : api.updateCell(...args),
    }, ...rest);
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), false);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(JSON.stringify(h.tables), before);
});

test("旧布局：当前楼批次：宿主整批落库后返回失败，不回写旧快照或重复增加道具", async () => {
    const h = await nativeRuntime(); addReplyWithFrame(h);
    const calls = observeHostWrites(h), original = h.api.importTableAsJson;
    h.api.importTableAsJson = async (...args) => { await original(...args); return false; };
    assert.strictEqual(await settleMutation(h, stat => { stat.状态.金币 = 2; stat.背包.push('药'); }), true);
    assert.deepStrictEqual(calls, ['importTableAsJson'], '重试按实际数据确认，无反向补偿或重复提交');
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 2);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.背包.filter(x => x === '药').length, 1);
});

test("旧布局：当前楼批次：序列化工厂的完整数组JSON和标量合成同一候选，保留未登记表", async () => {
    const inlineFactory = vm.runInNewContext('(' + core.getCandidateBuilderFactory().toString() + ')');
    const result = publishedLayoutFixture(require('./synthetic-card')());
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
    assert.equal(plan.operations.filter(op => op.method === 'updateCell').length, 2,
        '数组完整JSON和金币分别规划一个单元格更新，最终候选由宿主整批提交');
    assert.deepStrictEqual(clone(plan.tables.sheet_other), tables.sheet_other);
    assert.ok(plan.operations.length > 1, '数组内部导入仍须与外层标量合并提交');
});

test("旧布局：当前楼批次：规划期间数据库变化或来源失效，不提交过时草稿", async () => {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    async function commitCurrentReplyBatch(');
    const end = source.indexOf('    async function tryOpeningBulkInit(', start);
    assert.ok(start >= 0 && end > start);
    for (const invalidation of ['database', 'source']) {
        const result = publishedLayoutFixture(require('./synthetic-card')());
        const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout), tables = clone(result.template);
        const api = applyingApi(tables), before = core.statDataFromTables(layout, tables).stat_data, after = clone(before);
        after.状态.金币 = 2; after.背包.push('药');
        let invalid = false, calls = 0;
        for (const name of ['updateRow', 'updateCell', 'insertRow', 'deleteRow', 'importTableAsJson']) api[name] = () => { calls++; throw new Error('不可写入'); };
        const trackedCore = { ...core, writeStatDiffToDbResult: async (...args) => {
            const result = await core.writeStatDiffToDbResult(...args);
            if (invalidation === 'database') tables.concurrentMarker = true;
            else invalid = true;
            return result;
        }, get lastStatWriteFailed() { throw new Error('新调用不得读取共享失败状态'); } };
        const commit = vm.runInNewContext(source.slice(start, end) + '\ncommitCurrentReplyBatch;', {
            activeLayout: layout, dbgWarn() {}, window: { MVU2SHUJUKU_CORE: trackedCore,
                __MVU2SHUJUKU_CANDIDATE_BUILDER_FACTORY__: core.getCandidateBuilderFactory() },
            assertRuntimeSession() { if (invalid) throw new Error('来源失效'); },
        });
        await assert.rejects(commit(api, before, after, tables, {}), invalidation === 'database' ? /数据库已变化/ : /来源失效/);
        assert.strictEqual(calls, 0);
    }
});

test("旧布局：可空动态记录：实际扩展 replace 立即读回和宿主回调保持记录语义", async () => {
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

module.exports = { nativeRuntime };

function replyStatusOptions({ win, context }) {
    context.event_types = { CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'received', GENERATION_ENDED: 'ended', CHARACTER_MESSAGE_RENDERED: 'rendered' };
}
function reply(text) { return { is_user: false, mes: text, swipe_id: 0 }; }

test("旧布局：回复状态清理：单数复数完整块、多个块及多行按原 MVU 去除，块外正文保留", async () => {
    const h = await nativeRuntime(undefined, replyStatusOptions);
    let calls = 0;
    const before = JSON.stringify(h.tables);
    h.context.setChatMessages = async messages => { calls++; h.context.chat[messages[0].message_id].mes = messages[0].message; };
    const content = '正文前\n<status_current_variable>状态:\n  生命: 8\n</status_current_variable>\n正文中<status_current_variables>第二份\n状态</status_current_variables>正文后';
    h.context.chat.push(reply(content));
    await h.context.eventSource.emit('received', 1);
    await h.context.eventSource.emit('received', 1);
    await h.context.eventSource.emit('ended');
    await h.advance(1300);
    assert.strictEqual(h.context.chat[1].mes, '正文前\n\n正文中正文后');
    assert.strictEqual(calls, 1, '重复完成事件不能重复保存');
    await h.context.eventSource.emit('received', 1); await h.advance(1300);
    assert.strictEqual(calls, 1, '已清理的消息不再保存');
    assert.strictEqual(JSON.stringify(h.tables), before, '回复展示处理不写变量和业务表');
});
test("旧布局：回复状态清理：残缺、嵌套、属性及不配对的状态块不猜测删除", async () => {
    const h = await nativeRuntime(undefined, replyStatusOptions);
    let calls = 0; h.context.setChatMessages = async () => { calls++; };
    for (const text of ['前<status_current_variable>未闭合', '前</status_current_variable>后',
        '<status_current_variable><status_current_variables>嵌套</status_current_variables></status_current_variable>',
        '<status_current_variable class="作者扩展">内容</status_current_variable>',
        '<status_current_variable>内容</status_current_variables>']) {
        const id = h.context.chat.length; h.context.chat.push(reply(text));
        await h.context.eventSource.emit('received', id); await h.advance(1300);
        assert.strictEqual(h.context.chat[id].mes, text);
    }
    assert.strictEqual(calls, 0);
});
test("旧布局：回复状态清理：流式期间保留，完成后清理；补占位符与清理只保存一次", async () => {
    const h = await nativeRuntime(placeholderCard(), replyStatusOptions);
    let calls = 0; h.context.setChatMessages = async messages => { calls++; h.context.chat[messages[0].message_id].mes = messages[0].message; };
    const text = '故事<status_current_variable>变量</status_current_variable>';
    h.context.chat[0].mes += '\n<StatusPlaceHolderImpl/>';
    h.context.chat.push(reply(text)); h.context.generating = true; h.context.isStreaming = true;
    await h.context.eventSource.emit('received', 1); await h.advance(1300);
    assert.strictEqual(calls, 0); assert.strictEqual(h.context.chat[1].mes, text);
    h.context.generating = false; h.context.isStreaming = false;
    await h.context.eventSource.emit('ended'); await h.advance(1300);
    assert.strictEqual(h.context.chat[1].mes, '故事\n\n<StatusPlaceHolderImpl/>');
    assert.strictEqual(calls, 1);
});
test("旧布局：回复状态清理：不遍历旧聊天，用户、系统和普通卡保持完整", async () => {
    const h = await nativeRuntime(undefined, replyStatusOptions);
    const text = '故事<status_current_variable>变量</status_current_variable>';
    h.context.chat[0].mes = text;
    let calls = 0; h.context.setChatMessages = async () => { calls++; };
    await h.context.eventSource.emit('chat_changed'); await h.context.eventSource.emit('ended'); await h.advance(2000);
    assert.strictEqual(h.context.chat[0].mes, text, '进入旧聊天或结束事件不能自行扫描旧楼');
    for (const msg of [{ is_user: true, mes: text }, { is_system: true, mes: text }, { role: 'system', mes: text }, { name: 'System', mes: text }]) {
        const id = h.context.chat.length; h.context.chat.push(msg);
        await h.context.eventSource.emit('received', id); await h.advance(1300);
        assert.strictEqual(msg.mes, text);
    }
    delete h.context.characters[0].extensions.mvu2shujuku;
    h.context.chat.push(reply(text)); await h.context.eventSource.emit('received', h.context.chat.length - 1); await h.advance(1300);
    assert.strictEqual(h.context.chat.at(-1).mes, text); assert.strictEqual(calls, 0);
});
test("旧布局：回复状态清理：延迟期间切聊天、替换楼层或换 swipe 取消旧任务", async () => {
    for (const change of ['chat', 'message', 'swipe']) {
        const h = await nativeRuntime(undefined, replyStatusOptions);
        let calls = 0; h.context.setChatMessages = async () => { calls++; };
        const text = '故事<status_current_variable>变量</status_current_variable>';
        h.context.chat.push(reply(text)); await h.context.eventSource.emit('received', 1);
        if (change === 'chat') { h.context.chatId = 'native-B'; h.context.chat = [reply('新聊天')]; await h.context.eventSource.emit('chat_changed'); }
        else if (change === 'message') h.context.chat[1] = reply('替换后的消息');
        else { h.context.chat[1].swipe_id = 1; h.context.chat[1].mes = '另一分支'; }
        await h.advance(2500); assert.strictEqual(calls, 0);
    }
});
test("旧布局：回复状态清理：保存拒绝后重试；保存中重复事件与切聊天不刷新其他楼", async () => {
    const h = await nativeRuntime(undefined, replyStatusOptions);
    let calls = 0, renders = 0, release;
    const text = '故事<status_current_variable>变量</status_current_variable>';
    h.context.chat.push(reply(text));
    h.context.setChatMessages = async messages => {
        calls++; if (calls === 1) throw new Error('公开夹具保存拒绝');
        h.context.chat[messages[0].message_id].mes = messages[0].message;
    };
    await h.context.eventSource.emit('received', 1); await h.advance(2500);
    assert.strictEqual(calls, 2); assert.strictEqual(h.context.chat[1].mes, '故事');
    h.win.__TAURITAVERN__ = { api: { chatSurface: { isManagedOwnershipRequired: () => false } } };
    h.context.updateMessageBlock = () => { renders++; };
    h.context.setChatMessages = async messages => {
        calls++; const msg = h.context.chat[messages[0].message_id];
        await new Promise(resolve => { release = resolve; }); msg.mes = messages[0].message;
    };
    h.context.chat.push(reply(text)); await h.context.eventSource.emit('received', 2); await h.advance(1300);
    await h.context.eventSource.emit('received', 2); await h.context.eventSource.emit('ended'); await h.advance(1300);
    assert.strictEqual(calls, 3, '保存中不重复调用 setter');
    h.context.chatId = 'native-B'; h.context.chat = [reply('新聊天')]; await h.context.eventSource.emit('chat_changed');
    release(); await h.advance(0);
    assert.strictEqual(h.context.chat[0].mes, '新聊天'); assert.strictEqual(renders, 0);
});


async function beforeMessageRuntime(hook, source, configure) {
    let hooks = 0, saves = 0;
    const h = await nativeRuntime(source, env => {
        replyStatusOptions(env);
        env.win.__MVU2SHUJUKU_YAML_LIBS__ = require('../src/vendor/mvu-yaml-libs');
        const clockStart = Date.now();
        env.win.Date = class extends Date { static now() { return clockStart + env.now(); } };
        env.win.eventEmit = async (name, context) => {
            if (name === 'mag_before_message_update') { hooks++; await hook(context, env); }
        };
        env.context.setChatMessages = async messages => {
            saves++;
            env.context.chat[messages[0].message_id].mes = messages[0].message;
        };
        if (configure) configure(env);
    });
    observeHostWrites(h);
    await h.advance(2500);
    return Object.assign(h, { counts: () => ({ hooks, saves }) });
}
function addUpdateReply(h, text = '原正文<UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>') {
    addReplyWithFrame(h); h.context.chat[2].mes = text; h.context.chat[2].swipe_id = 0;
    return h.context.chat[2];
}
test("旧布局：MVU正文回调：更新后的变量与正文一同采用，重复事件不重放增量命令", async () => {
    const h = await beforeMessageRuntime(context => {
        context.variables.stat_data.状态.金币 += 2;
        context.message_content = '金币：' + context.variables.stat_data.状态.金币;
    });
    const message = addUpdateReply(h);
    await h.context.eventSource.emit('received', 2); await h.advance(6000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 13);
    assert.strictEqual(message.mes, '金币：13');
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
    await h.context.eventSource.emit('received', 2); await h.context.eventSource.emit('ended'); await h.advance(6000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 13);
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
});
test("旧布局：MVU正文回调：变量不变也保存正文，改写后的更新块登记为已处理", async () => {
    const h = await beforeMessageRuntime(context => {
        context.message_content = '改写正文<UpdateVariable>_.add("状态.金币", 5);</UpdateVariable>';
    });
    const message = addUpdateReply(h, '原正文<UpdateVariable>_.set("状态.金币", 10);</UpdateVariable>');
    await h.context.eventSource.emit('received', 2); await h.advance(6000);
    assert.match(message.mes, /^改写正文/);
    await h.context.eventSource.emit('received', 2); await h.advance(6000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 10);
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
});
test("旧布局：MVU正文回调：保存失败只重试正文，不重复变量命令和作者回调", async () => {
    const h = await beforeMessageRuntime(context => { context.message_content = '改写后正文'; });
    let attempts = 0;
    h.context.setChatMessages = async messages => {
        attempts++;
        if (attempts === 1) throw new Error('模拟保存失败');
        h.context.chat[messages[0].message_id].mes = messages[0].message;
    };
    const message = addUpdateReply(h);
    await h.context.eventSource.emit('received', 2); await h.advance(6000);
    assert.strictEqual(message.mes, '改写后正文');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(h.counts().hooks, 1);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
});
test("旧布局：MVU正文回调：回调等待期间切聊天、替换消息、编辑或换 swipe 均放弃旧写入", async () => {
    for (const change of ['chat', 'message', 'edit', 'swipe']) {
        let release, entered = false;
        const h = await beforeMessageRuntime(async context => {
            entered = true; await new Promise(resolve => { release = resolve; }); context.message_content = '旧回调正文';
        });
        const original = addUpdateReply(h);
        await h.context.eventSource.emit('received', 2); await h.advance(1500); assert.ok(entered);
        if (change === 'chat') { h.context.chatId = 'native-B'; h.context.chat = [reply('新聊天')]; await h.context.eventSource.emit('chat_changed'); }
        else if (change === 'message') h.context.chat[2] = reply('替换后的消息');
        else if (change === 'edit') original.mes = '用户编辑';
        else { original.swipe_id = 1; original.mes = '另一分支'; }
        release(); await h.advance(6000);
        assert.strictEqual(h.counts().saves, 0, change);
        assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 10, change);
    }
});
test("旧布局：MVU正文回调：生成结束才执行回调，状态清理与补占位符合并保存", async () => {
    const h = await beforeMessageRuntime(context => { context.message_content += '\n回调正文'; }, placeholderCard());
    h.context.chat[0].mes += '\n<StatusPlaceHolderImpl/>';
    const message = addUpdateReply(h, '原正文<status_current_variable>旧状态</status_current_variable><UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>');
    h.context.generating = true; h.context.isStreaming = true;
    await h.context.eventSource.emit('received', 2); await h.advance(2000);
    assert.strictEqual(h.counts().hooks, 0);
    h.context.generating = false; h.context.isStreaming = false;
    await h.context.eventSource.emit('ended'); await h.advance(6000);
    assert.ok(!message.mes.includes('status_current_variable'));
    assert.ok(message.mes.includes('回调正文'));
    assert.ok(message.mes.endsWith('<StatusPlaceHolderImpl/>'), JSON.stringify({ text: message.mes, counts: h.counts() }));
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
});
test("旧布局：MVU正文回调：首楼更新采用正文，修改来源后轮询不重放初始化", async () => {
    const h = await beforeMessageRuntime(context => {
        context.message_content = '<initvar>{"状态":{"生命":100,"金币":10},"背包":["钥匙",0,false,null]}</initvar>改写开场<UpdateVariable>_.add("状态.金币", 5);</UpdateVariable>';
    }, undefined, ({ context }) => { context.chat[0].mes = require('./synthetic-card')().data.first_mes; });
    h.context.chat[0].mes = '<initvar>{"状态":{"生命":100,"金币":10},"背包":["钥匙",0,false,null]}</initvar>原开场<UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>';
    await h.advance(6000);
    assert.match(h.context.chat[0].mes, /改写开场/, JSON.stringify({ counts: h.counts(), gold: h.win.Mvu.getMvuData().stat_data.状态.金币 }));
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
    await h.advance(6000);
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
});

test("旧布局：MVU正文回调：正文重试前编辑、删除或换分支取消；变量保持单次提交", async () => {
    for (const change of ['edit', 'delete', 'swipe']) {
        const h = await beforeMessageRuntime(context => { context.message_content = '回调正文'; });
        let attempts = 0; h.context.setChatMessages = async () => { attempts++; throw new Error('模拟保存失败'); };
        const message = addUpdateReply(h);
        await h.context.eventSource.emit('received', 2); await h.advance(1500);
        assert.strictEqual(attempts, 1, change);
        if (change === 'delete') h.context.chat.splice(2, 1);
        else { message.mes = '用户新正文'; if (change === 'swipe') message.swipe_id = 1; }
        await h.advance(5000);
        assert.strictEqual(attempts, 1, change);
        assert.strictEqual(h.counts().hooks, 1, change);
        assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11, change);
        if (change !== 'delete') assert.strictEqual(message.mes, '用户新正文');
    }
});
test("旧布局：MVU正文回调：未修改正文或返回非字符串，不生成额外正文保存", async () => {
    for (const invalid of [false, true]) {
        const h = await beforeMessageRuntime(context => { if (invalid) context.message_content = undefined; });
        const message = addUpdateReply(h), original = message.mes;
        await h.context.eventSource.emit('received', 2); await h.advance(5000);
        assert.strictEqual(message.mes, original);
        assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 0 });
        assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
    }
});

test("旧布局：MVU正文回调：新聊天首楼合并初始化成功后保存正文，首轮增量只执行一次", async () => {
    const source = require('./synthetic-card')();
    source.data.first_mes += '<UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>';
    const h = await beforeMessageRuntime(context => { context.message_content = '新聊天回调正文'; }, source, ({ context, api, tables }) => {
        context.chat[0].mes = source.data.first_mes;
        delete context.chat[0].TavernDB_ACU_IsolatedData;
        for (const key of Object.keys(tables)) delete tables[key];
        api.initGameSession = async (_, options) => {
            await api.importTableAsJson(JSON.stringify(options.templateData));
            context.chat[0].TavernDB_ACU_IsolatedData = { test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: clone(tables) }, logEntries: [] } } };
            return { success: true };
        };
    });
    await h.advance(6000);
    assert.strictEqual(h.context.chat[0].mes, '新聊天回调正文');
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
    assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 1 });
});
test("旧布局：MVU正文回调：首楼回调等待期间编辑或换分支，变量与正文都不覆盖新来源", async () => {
    for (const change of ['edit', 'swipe']) {
        let release;
        const h = await beforeMessageRuntime(async context => {
            await new Promise(resolve => { release = resolve; }); context.message_content = '旧开场回调正文';
        }, undefined, ({ context }) => { context.chat[0].mes = require('./synthetic-card')().data.first_mes; });
        h.context.chat[0].mes += '<UpdateVariable>_.add("状态.金币", 1);</UpdateVariable>';
        await h.advance(2000); assert.strictEqual(typeof release, 'function');
        h.context.chat[0].mes = '新的首楼正文'; if (change === 'swipe') h.context.chat[0].swipe_id = 1;
        release(); await h.advance(6000);
        assert.strictEqual(h.context.chat[0].mes, '新的首楼正文');
        assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 10);
        assert.deepStrictEqual(h.counts(), { hooks: 1, saves: 0 });
    }
});

test("旧布局：MVU正文回调：接口改内存后报错仍重试保存，改写的命令不能再执行", async () => {
    const h = await beforeMessageRuntime(context => {
        context.message_content = '回调正文<UpdateVariable>_.add("状态.金币", 5);</UpdateVariable>';
    });
    let attempts = 0;
    h.context.setChatMessages = async messages => {
        attempts++; h.context.chat[messages[0].message_id].mes = messages[0].message;
        if (attempts === 1) throw new Error('模拟刷新在改内存后失败');
    };
    addUpdateReply(h);
    await h.context.eventSource.emit('received', 2); await h.advance(5000);
    assert.strictEqual(attempts, 2);
    await h.context.eventSource.emit('received', 2); await h.advance(5000);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 11);
    assert.strictEqual(h.counts().hooks, 1);
});

test("旧布局：统一变量入口实装：MVU与TH历史读取限定消息边界，历史写入不动当前表", async () => {
    const h = await nativeRuntime();
    const original = clone(h.tables);
    const historical = h.win.Mvu.getMvuData();
    h.context.chat.push({ is_user: true, mes: '历史读取测试' }, { is_user: false, mes: '当前AI回复', swipe_id: 0 });
    const sheet = Object.values(h.tables).find(value => value && value.name === '状态表');
    const column = sheet.content[0].indexOf('金币'); assert(column > 0);
    sheet.content[1][column] = 44;
    for (const callback of h.tableCallbacks) await callback(clone(h.tables), { persisted: true });
    assert.strictEqual(h.win.Mvu.getMvuData({ type: 'message', message_id: 0 }).stat_data.状态.金币, 10);
    assert.strictEqual(h.win.getVariables({ type: 'message', message_id: -3 }).stat_data.状态.金币, 10);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.金币, 44);
    const snapshot = JSON.stringify(h.tables);
    historical.stat_data.状态.金币 = 49;
    assert.strictEqual(await h.win.Mvu.replaceMvuData(historical, { type: 'message', message_id: 0 }), false);
    let called = false;
    assert.strictEqual(await h.win.updateVariablesWith(value => { called = true; return value; }, { type: 'message', message_id: 0 }), false);
    assert.strictEqual(called, false); assert.strictEqual(JSON.stringify(h.tables), snapshot);
    assert.deepStrictEqual(clone(h.context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame.checkpoint.data), original);
});

test("旧布局：统一变量入口实装：MVU显式chat/global作用域仍调用宿主公开接口", async () => {
    const calls = [];
    const h = await nativeRuntime(undefined, ({ win }) => {
        win.getVariables = options => { calls.push(['read', options]); return { native: options.type }; };
        win.replaceVariables = async (value, options) => { calls.push(['write', value, options]); return true; };
    });
    for (const type of ['chat', 'global', 'character']) {
        const options = { type };
        assert.strictEqual(h.win.Mvu.getMvuData(options).native, type);
        assert.strictEqual(calls.at(-1)[1], options);
        assert.strictEqual(await h.win.Mvu.replaceMvuData({ native: type }, options), true);
        assert.strictEqual(calls.at(-1)[2], options);
    }
});


async function hostSeededSchemaRuntime() {
    const source = require('./synthetic-card')();
    source.data.first_mes = '公开开场。'; source.data.alternate_greetings = [];
    source.data.extensions.tavern_helper.scripts.push({type:'script',name:'公开非幂等初始化',enabled:true,
        content: `import {registerMvuSchema} from 'https://example.org/mvu_zod.js';
        const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number().transform(v=>v+1)}),背包:z.array(z.any())});
        registerMvuSchema(Schema);`});
    const h = await nativeRuntime(source, ({win,context,api,tables}) => {
        win.TavernHelper = {};
        context.event_types = {CHAT_CHANGED:'chat_changed',CHAT_CREATED:'chat_created'};
        const importTables=api.importTableAsJson;
        api.importTableAsJson=async (...args) => {
            const result=await importTables(...args);
            // The public CRUD substitute normally updates only its runtime view.
            // Explicit initialization also verifies the persisted full checkpoint.
            context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame.checkpoint.data=clone(tables);
            return result;
        };
    });
    const {zod:z} = require('../src/vendor/schema-engine-libs');
    let calls=0;
    const key=h.context.characters[0].extensions.mvu2shujuku.schemaKeys[0];
    assert(key);
    const schema=z.object({状态:z.object({生命:z.number(),金币:z.number().transform(value=>{calls++;return value+1;})}),背包:z.array(z.any())});
    assert.equal(h.win.TavernHelper.__mvu2shujukuCardApi.registerSchema(schema,key),true);
    await h.advance(15000);
    return {...h,calls:()=>calls};
}

test("旧布局：宿主先建表：真实新聊天事件补齐 Schema 初始化且只执行一次", async () => {
    const h=await hostSeededSchemaRuntime(), before=h.win.Mvu.getMvuData().stat_data.状态.金币;
    assert(h.handlers.has('chat_created'), 'actual runtime subscribes to the host lifecycle event');
    assert.equal(h.calls(),0,'existing checkpoint alone must not replay author transforms');
    await h.context.eventSource.emit('chat_created'); await h.advance(15000);
    assert.equal(h.calls(),1,'a genuinely new chat must complete deferred initialization');
    assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币,before+1);
    await h.context.eventSource.emit('chat_created'); await h.advance(15000);
    assert.equal(h.calls(),1,'duplicate notifications must not repeat non-idempotent transforms');
});

test("旧布局：宿主先建表：已有聊天只换页不重跑 Schema 初始化", async () => {
    const h=await hostSeededSchemaRuntime(), before=h.win.Mvu.getMvuData().stat_data;
    await h.context.eventSource.emit('chat_changed'); await h.advance(15000);
    assert.equal(h.calls(),0);
    assert.deepEqual(clone(h.win.Mvu.getMvuData().stat_data),clone(before));
});


test("旧布局：开场完整 JSON：Schema 删除未声明子字段后不恢复模板旧值", async () => {
    const source=require('./synthetic-card')(), entry=source.data.character_book.entries.find(e=>/initvar/i.test(e.comment));
    const initial=core.parseInitVar(entry.content); initial.状态.身份=[]; entry.content=JSON.stringify(initial);
    source.data.first_mes='公开开场。'; source.data.alternate_greetings=[];
    source.data.extensions.tavern_helper.scripts.push({type:'script',name:'公开对象规范化',enabled:true,
        content:`import {registerMvuSchema} from 'https://example.org/mvu_zod.js';
        const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number()}).transform(v=>v),背包:z.array(z.any())});registerMvuSchema(Schema);`});
    assert.equal(publishedLayoutFixture(source).schema.find(group=>group.name==='状态').valueCol,'内容');
    const h=await nativeRuntime(source,({win,context,api,tables})=>{
        win.TavernHelper={};context.event_types={CHAT_CHANGED:'chat_changed',CHAT_CREATED:'chat_created'};
        const original=api.importTableAsJson;api.importTableAsJson=async (...args)=>{const result=await original(...args);context.chat[0].TavernDB_ACU_IsolatedData.test.storageFrame.checkpoint.data=clone(tables);return result;};
    });
    const {zod:z}=require('../src/vendor/schema-engine-libs'), key=h.context.characters[0].extensions.mvu2shujuku.schemaKeys[0];
    h.win.TavernHelper.__mvu2shujukuCardApi.registerSchema(z.object({状态:z.object({生命:z.number(),金币:z.number()}).transform(v=>v),背包:z.array(z.any())}),key);
    await h.advance(15000);assert.deepEqual(clone(h.win.Mvu.getMvuData().stat_data.状态.身份),[]);
    await h.context.eventSource.emit('chat_created');await h.advance(15000);
    assert.equal(Object.hasOwn(h.win.Mvu.getMvuData().stat_data.状态,'身份'),false);
});

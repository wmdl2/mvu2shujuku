'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, fs, path, applyingApi } = require('./helpers');
const source = fs.readFileSync(path.join(__dirname, '../src/mvu2shujuku.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function card(data = { 状态: { 生命: 100 } }, scripts = []) {
    return { name: '审查合成卡', first_mes: '你好', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(data) },
    ] }, extensions: { regex_scripts: [], tavern_helper: { scripts } } };
}
function extract(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, '实际函数边界必须存在');
    return source.slice(a, b);
}
function runtime(extra = {}) {
    let chat = 'A', avatar = 'one.png';
    const context = { getContextSafe: () => ({ chatId: chat }), currentCharacter: () => ({ avatar }),
        autoInitChatId: () => chat, characterDisplayName: () => '同名', cardCacheKey: ch => ch.avatar, ...extra };
    vm.createContext(context);
    vm.runInContext(extract("    let runtimeSessionKey = '';", '    // 首楼替换修复'), context);
    return { context, switchChat: value => { chat = value; }, switchCard: value => { avatar = value; } };
}

function writeQueue() {
    let timerId = 0;
    const timers = new Map(), win = {};
    const r = runtime({ window: win, hostWindow: {
        setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
    }, invalidateStatProjectionCache() {}, getAcuApi: () => null, activeLayout: null,
        dbg() {}, dbgWarn() {} });
    vm.runInContext(extract('    let pendingStatWrite = null;', '    function normalizeCellForSync('), r.context);
    vm.runInContext(extract('    function scheduleWindowStatOverlay(', '    // 扩展侧提供 window.getAllVariables'), r.context);
    return { ...r, timers, win };
}

test('队列边界：切聊天事件迟到时新写入不继承旧会话 Promise', async () => {
    const r = writeQueue();
    const old = r.context.scheduleWindowStatOverlay({ old: 1 });
    r.switchChat('B');
    const current = r.context.scheduleWindowStatOverlay({ current: 1 });
    assert.notStrictEqual(current, old, '不同会话必须独立结算');
    assert.strictEqual(await old, false);
    assert.strictEqual(r.timers.size, 1, '旧会话防抖任务应取消');
    await Array.from(r.timers.values())[0]();
    assert.strictEqual(await current, false); // 模拟 API 未安装，不能报告成功
});

test('队列边界：拒绝旧重试时同时清理共享读投影和定时器', async () => {
    const r = writeQueue(), session = r.context.captureRuntimeSession();
    const old = r.context.scheduleWindowStatOverlay({ old: 1 }, null, false, false, 'A', session);
    r.switchChat('B');
    assert.strictEqual(await r.context.scheduleWindowStatOverlay({ old: 1 }, null, true, false, 'A', session), false);
    assert.strictEqual(await old, false);
    assert.strictEqual(r.win.__mvu2shujukuPendingStat, null);
    assert.strictEqual(r.timers.size, 0);
});

test('队列边界：迟到旧重试不得取消新会话已经排队的写入', async () => {
    const r = writeQueue(), oldSession = r.context.captureRuntimeSession();
    const old = r.context.scheduleWindowStatOverlay({ old: 1 });
    r.switchChat('B');
    const next = { current: 1 }, current = r.context.scheduleWindowStatOverlay(next);
    assert.strictEqual(await old, false);
    assert.strictEqual(await r.context.scheduleWindowStatOverlay({ old: 1 }, null, true, false, 'A', oldSession), false);
    assert.strictEqual(r.win.__mvu2shujukuPendingStat, next);
    assert.strictEqual(r.timers.size, 1);
    await Array.from(r.timers.values())[0]();
    assert.strictEqual(await current, false);
});

test('队列边界：同会话防抖仍合并快照且回调只结算一次', async () => {
    const r = writeQueue(), settled = [];
    const first = r.context.scheduleWindowStatOverlay({ value: 1 }, ok => settled.push(['first', ok]));
    const second = r.context.scheduleWindowStatOverlay({ value: 2 }, ok => settled.push(['second', ok]));
    assert.strictEqual(first, second);
    assert.strictEqual(r.timers.size, 1);
    assert.strictEqual(r.win.__mvu2shujukuPendingStat.value, 2);
    await Array.from(r.timers.values())[0]();
    assert.strictEqual(await second, false);
    assert.deepStrictEqual(settled, [['first', false], ['second', false]]);
    assert.strictEqual(r.win.__mvu2shujukuPendingStat, null);
});

test('EJS 边界：有空白或注释的对象方法不改写成全局变量接口', () => {
    const input = `<% obj /*owner*/ . getMessageVar('stat_data.x'); obj . setMessageVar('stat_data.x',1); obj . setvar('stat_data.x',1,{outscope:'message'}); %>`;
    assert.strictEqual(core.rewriteEjsConditions(input, {}, core.createReport()).text, input);
});

test('审查：JSON 文件字节含 BOM 空白可转换并保持 JSON 产物', () => {
    const input = new Uint8Array(Buffer.from('\ufeff \n' + JSON.stringify(card())));
    const result = core.convert(input);
    assert.strictEqual(result.meta.isPngInput, false);
    const file = result.files.find(f => f.kind === 'card');
    assert.ok(file.name.endsWith('.json'));
    assert.ok(JSON.parse(file.data));
});

test('审查：顶层数组各 JSON 类型往返，原样回写没有 CRUD', async () => {
    const data = { 列表: ['001', 3, false, null, { a: 1 }, [1, 2, 3], '重复', '重复'] };
    const result = core.convert(card(data));
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    const tables = clone(result.template);
    const before = core.statDataFromTables(layout, tables).stat_data;
    assert.deepStrictEqual(before.列表, data.列表);
    const api = applyingApi(tables);
    let calls = 0;
    for (const method of ['insertRow', 'deleteRow', 'updateCell']) {
        const original = api[method];
        api[method] = (...args) => { calls++; return original(...args); };
    }
    await core.writeStatDiffToDb(api, layout, before, clone(before));
    assert.strictEqual(calls, 0);
    const next = { 列表: [true, 7, '007', null, [4, 5, 6], { b: false }] };
    await core.writeStatDiffToDb(api, layout, before, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data.列表, next.列表);
});

for (const mode of ['false', 'throw', 'insert-minus-one']) test('审查：数组 CRUD 失败停止后续写入 ' + mode, async () => {
    const result = core.convert(card({ 列表: [1, 2, 3] }));
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout), tables = clone(result.template);
    const before = core.statDataFromTables(layout, tables).stat_data;
    const api = applyingApi(tables), calls = [];
    const originalDelete = api.deleteRow;
    api.deleteRow = async (...args) => {
        calls.push('delete');
        if (mode === 'throw') throw new Error('模拟删除失败');
        return mode === 'false' ? false : originalDelete(...args);
    };
    api.insertRow = async () => { calls.push('insert'); return -1; };
    await core.writeStatDiffToDb(api, layout, before, { 列表: [4, 5, 6] });
    assert.strictEqual(core.lastStatWriteFailed, true);
    assert.strictEqual(calls.filter(x => x === 'insert').length, mode === 'insert-minus-one' ? 1 : 0);
    if (mode !== 'insert-minus-one') assert.strictEqual(calls.length, 1);
});

for (const business of ['setInterval(()=>window.tick(),1000);', 'window.started=true;']) test('审查：注册 Schema 的混合业务脚本保留 ' + business, () => {
    const content = "import {registerMvuSchema} from 'https://example.test/schema.js'; const Schema=z.object({值:z.number()});registerMvuSchema(Schema);" + business;
    const result = core.convert(card(undefined, [{ name: '混合脚本', enabled: true, content }]));
    assert.ok(JSON.stringify(result.card).includes(business));
});

test('审查：普通正则不因名称包含完整变量而删除', () => {
    const input = card();
    input.extensions.regex_scripts.push({ scriptName: '完整变量显示', findRegex: 'hello', replaceString: 'world' });
    const result = core.convert(input);
    assert.ok((result.card.data || result.card).extensions.regex_scripts.some(r => r.scriptName === '完整变量显示' && r.replaceString === 'world'));
});

test('审查：EJS 字符串注释正则不改写，模板插值中的真实调用改写', () => {
    const literal = `const example="getvar('stat_data.状态.生命')"; /* getvar('stat_data.x') */ const regex=/getvar\\('stat_data.x'\\)/; const other=obj . getvar('stat_data.x');`;
    const input = '<% ' + literal + "const value=`文字 getvar('stat_data.x') ${getvar('stat_data.状态.生命')}`; %>";
    const result = core.rewriteEjsConditions(input, {}, core.createReport()).text;
    assert.ok(result.includes(literal));
    assert.ok(result.includes("文字 getvar('stat_data.x')"));
    assert.ok(!result.includes("${getvar('stat_data.状态.生命')}"));
    assert.ok(result.includes('mvu2shujukuGetMessageVar'));
});

test('审查：会话代次隔离同名角色及 A→B→A', () => {
    const r = runtime(), session = r.context.captureRuntimeSession();
    r.switchChat('B'); r.context.captureRuntimeSession(); r.switchChat('A');
    assert.strictEqual(r.context.isRuntimeSessionCurrent(session), false);
    const current = r.context.captureRuntimeSession();
    r.switchCard('two.png');
    assert.strictEqual(r.context.isRuntimeSessionCurrent(current), false);
});

test('审查：CRUD await 期间切聊天后拒绝返回及下一次调用', async () => {
    const r = runtime(); let release, calls = 0;
    const api = r.context.runtimeApiForSession({ updateCell() { calls++; return new Promise(resolve => { release = resolve; }); } }, r.context.captureRuntimeSession());
    const pending = api.updateCell();
    r.switchChat('B'); release(true);
    await assert.rejects(pending, e => e.code === 'MVU_SESSION_CHANGED');
    assert.throws(() => api.updateCell(), e => e.code === 'MVU_SESSION_CHANGED');
    assert.strictEqual(calls, 1);
});

test('审查：开场异步准备期间切聊天不排入新聊天写队列', async () => {
    let release; const state = { ready: true }, writes = [];
    const r = runtime({ greetingInitState: () => state, activeGreetingSourceSnapshot: () => ({ sourceFp: 'A' }),
        computeActiveGreetingSnapshot: () => new Promise(resolve => { release = resolve; }),
        scheduleWindowStatOverlay: (...args) => writes.push(args), dbg() {}, dbgWarn() {} });
    vm.runInContext(extract('    async function applyActiveGreetingInitvar()', '    // 扩展成为唯一 runtime owner'), r.context);
    const pending = r.context.applyActiveGreetingInitvar();
    r.switchChat('B'); release({ fp: 'A', finalWrap: { stat_data: { 生命: 100 } }, first: {} });
    await pending;
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(state.pendingSourceFp, '');
});

test('审查：完整卡接口接受空世界书问候语初始化并保留源头像', async () => {
    const full = { name: '问候语卡', first_mes: '<initvar>{"状态":{"生命":100}}</initvar>', character_book: { entries: [] } };
    const context = { charWorldBook: ch => ch.character_book, getContextSafe: () => ({}), dbg() {}, dbgWarn() {},
        fetch: async () => ({ ok: true, json: async () => full }) };
    vm.createContext(context);
    vm.runInContext(extract('    async function fetchFullCharacter(', '    function readFileAsBytes('), context);
    const loaded = await context.fetchFullCharacter({ name: full.name, avatar: 'source.png' });
    assert.strictEqual(loaded.avatar, 'source.png');
    assert.strictEqual(core.convert(loaded).meta.tableCount, 1);
});

test('审查：点击数据桥下载按钮得到可执行 JS 而非报告', async () => {
    const result = core.convert(card()), buttons = [], downloads = [];
    const node = () => ({ style: {}, appendChild() {}, addEventListener(event, fn) { this.click = fn; } });
    const box = node(), downloadBox = { appendChild(button) { buttons.push(button); } };
    const panel = { querySelector: selector => selector === '.mvu2shujuku-result' ? box : selector === '#mvu2shujuku-downloads' ? downloadBox : node() };
    const context = { hostDocument: { getElementById: () => panel, createElement: node }, PANEL_ID: 'test',
        renderUpdateConfigEditor() {}, renderMergeSection() {}, toast() {}, lastResult: result,
        download: (...args) => downloads.push(args) };
    vm.createContext(context);
    vm.runInContext(extract('    function renderResult(', '    function findSettingsMount('), context);
    context.renderResult(result);
    await buttons.find(button => button.textContent === '下载数据桥源码（仅供调试）').click();
    assert.strictEqual(downloads[0][2], result.bridgeScript);
    assert.notStrictEqual(downloads[0][2], result.reportText);
    new vm.Script(downloads[0][2]);
});

test('审查：旧数组布局仍按文本读取，不猜测字符串类型', () => {
    const tables = { sheet_old: { name: '旧表', content: [['row_id', '内容'], [1, '001'], [2, 'false'], [3, 'null']] } };
    assert.deepStrictEqual(core.statDataFromTables([{ kind: 'array', group: '列表', table: '旧表', cols: [] }], tables).stat_data.列表, ['001', 'false', 'null']);
});

test('审查：桥注册拒绝名称前缀、过期转换标识和篡改布局', () => {
    const layout = [{ kind: 'array', group: '列表', table: '列表表', cols: [] }];
    const marker = { originalName: '卡', convertedAt: 'new', layout: JSON.stringify(layout) };
    const ch = { name: '卡_数据库', avatar: 'current.png', extensions: { mvu2shujuku: marker } };
    const context = { currentCharacter: () => ch, isConvertedMvuCard: () => true, charExtensions: x => x.extensions,
        charWorldBook: () => ({ entries: [] }), resolveRuntimeLayout: x => x, cardCacheKey: x => x.avatar,
        activeLayout: null, activeLayoutCardKey: '', activePlaceholderNeeded: false, DB_TEMPLATE_KEY: '__ACU_TEMPLATE_DATA__',
        installWindowGetAllVariables() {}, installWindowMvuShim() {}, ensureTemplateDefine() {}, autoInitDatabase() {},
        hostWindow: { setTimeout() {} }, dbg() {}, dbgWarn() {} };
    vm.createContext(context);
    vm.runInContext(extract('    function acceptBridgeRegistration(', '    function activateRuntimeRegistry('), context);
    const payload = { cardName: '卡', convertedAt: 'new', layout };
    assert.strictEqual(context.acceptBridgeRegistration({ ...payload, cardName: '卡_数据' }), false);
    assert.strictEqual(context.acceptBridgeRegistration({ ...payload, convertedAt: 'old' }), false);
    assert.strictEqual(context.acceptBridgeRegistration({ ...payload, layout: [] }), false);
    assert.strictEqual(context.acceptBridgeRegistration({ ...payload, convertedAt: '' }), false);
    assert.strictEqual(context.activeLayout, null);
    assert.strictEqual(context.acceptBridgeRegistration(payload), true);
    assert.strictEqual(context.activeLayoutCardKey, 'current.png');
});

test('审查：保存 await 期间切换结果仍保存原卡、头像及模板', async () => {
    const original = core.convert(card()), created = [], templates = [];
    original.meta.sourceCharacter = { name: '源卡', avatar: 'original.png' };
    let release, requestedAvatar;
    const context = { lastResult: original, updateParamsDirty: false, PANEL_ID: 'test',
        hostDocument: { getElementById: () => null }, Blob, toast() {}, showInfoPopup() {},
        getContextSafe: () => ({ createCharacterData: async (...args) => { created.push(args); return 'saved.png'; } }),
        fetchAvatarBlob: ch => { requestedAvatar = ch.avatar; return new Promise(resolve => { release = resolve; }); },
        getAcuApi: () => ({ importTemplateFromData: async template => { templates.push(template); return { success: true }; } }),
        autoSaveConversionProfile: async () => { throw new Error('不应保存另一转换结果的配置'); } };
    vm.createContext(context);
    vm.runInContext(extract('    async function saveCardToSillyTavern()', '    // 弹窗：'), context);
    const pending = context.saveCardToSillyTavern();
    context.lastResult = core.convert({ ...card(), name: '另一张卡' });
    release(new Blob(['avatar']));
    assert.strictEqual(await pending, true);
    assert.strictEqual(requestedAvatar, 'original.png');
    assert.strictEqual(created[0][2].data.name, (original.card.data || original.card).name);
    assert.strictEqual(templates[0], original.template);
});

test('审查：保存前参数刷新失败不写入旧卡', async () => {
    let calls = 0;
    const context = { lastResult: core.convert(card()), updateParamsDirty: true, toast() {},
        refreshConvertedResult() { throw new Error('模拟刷新失败'); },
        getContextSafe() { calls++; return {}; } };
    vm.createContext(context);
    vm.runInContext(extract('    async function saveCardToSillyTavern()', '    // 弹窗：'), context);
    assert.strictEqual(await context.saveCardToSillyTavern(), false);
    assert.strictEqual(calls, 0);
});

test('审查：JSON 文件刷新保留自动格式与源角色', () => {
    const input = new Uint8Array(Buffer.from(JSON.stringify(card()))), original = core.convert(input);
    original.meta.sourceCharacter = { avatar: 'source.png' };
    const context = { lastInput: input, lastResult: original, getSettings: () => ({ asPng: 'auto', installMvuShim: 'auto' }), window: { MVU2SHUJUKU_CORE: core } };
    vm.createContext(context);
    vm.runInContext(extract('    function refreshConvertedResult()', '    function updateConfigOf('), context);
    const result = context.refreshConvertedResult();
    assert.ok(result.files.find(f => f.kind === 'card').name.endsWith('.json'));
    assert.strictEqual(result.meta.avatarBytes, undefined);
    assert.strictEqual(result.meta.sourceCharacter.avatar, 'source.png');
});

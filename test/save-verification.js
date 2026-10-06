'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/extension-runtime.js'), 'utf8');
function extract(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
}
const implementation = extract('    async function fetchFullCharacter(', '    function readFileAsBytes(') +
    extract('    function sameSavedScriptData(', '    // 弹窗：');
const copy = x => JSON.parse(JSON.stringify(x));
async function save(options = {}) {
    const expected = { name: '公开保存测试卡', first_mes: '开场', extensions: {
        mvu2shujuku: { converter: 'mvu2shujuku', convertedAt: 'this-conversion' },
        tavern_helper: { scripts: [{ name: '数据桥', content: 'bridge();', enabled: true }], variables: {} },
    } };
    const before = JSON.stringify(expected), writes = [], reads = [], messages = [];
    let persisted = copy(expected), creates = 0;
    const overlays = [];
    const document = {
        getElementById: () => null,
        body: { appendChild(node) { overlays.push(node); } },
        createElement() {
            const children = { strong: {}, p: {} };
            return { setAttribute() {}, focus() {}, querySelector: key => children[key],
                remove() { const i = overlays.indexOf(this); if (i >= 0) overlays.splice(i, 1); } };
        },
    };
    const st = { characters: options.noList ? [] : [{ ...copy(expected), avatar: 'new.png' }],
        createCharacterData: async () => {
            creates++;
            assert.strictEqual(overlays.length, 1, '创建接口调用期间必须显示保存弹窗');
            if (options.onCreate) await options.onCreate(context, overlays);
            if (options.createFailure) throw new Error('公开保存失败');
            return options.noAvatar ? '' : 'new.png';
        } };
    if (!options.noRefresh) st.getCharacters = async () => st.characters;
    if (!options.noWriter) st.writeExtensionField = async (index, key, value) => {
        writes.push({ index, key, value: copy(value) });
        if (!options.silentWriteFailure) persisted.extensions[key] = copy(value);
        value.scripts[0].name = '宿主临时变更';
    };
    if (options.scriptMismatch) persisted.extensions.tavern_helper.scripts[0].name = '残留旧脚本';
    if (options.wrongMarker) persisted.extensions.mvu2shujuku.convertedAt = 'old-conversion';
    if (options.staleList) st.characters = [{ ...copy(expected), avatar: 'old.png' }];
    const context = {
        lastResult: { card: { spec: 'chara_card_v3', data: expected }, meta: { avatarBytes: new Uint8Array([1]) }, files: [] },
        updateParamsDirty: false, PANEL_ID: 'test', hostDocument: document, hostWindow: { setTimeout }, Blob,
        getContextSafe: () => st, window: { MVU2SHUJUKU_CORE: core },
        charWorldBook: ch => ch.character_book, dbg() {}, dbgWarn() {}, toast() {}, download() {},
        getAcuApi: () => null, autoSaveConversionProfile: async () => {},
        showInfoPopup: (title, text) => messages.push(text),
        fetch: async (url, request) => {
            assert.strictEqual(url, '/api/characters/get');
            reads.push(JSON.parse(request.body).avatar_url);
            return { ok: !options.httpError, status: options.httpError || 200,
                json: async () => options.malformed ? { mode: 'patch', ops: [] } : { data: copy(persisted) } };
        },
    };
    vm.createContext(context); vm.runInContext(implementation, context);
    assert.strictEqual(await context.saveCardToSillyTavern(), !options.createFailure, '复核失败不能伪装成创建失败');
    assert.strictEqual(overlays.length, 0, '结束后不能遗留保存弹窗');
    assert.strictEqual(JSON.stringify(expected), before, '宿主参数不能反向修改转换结果');
    return { writes, reads, text: messages.join('\n'), context, creates };
}

test('保存复核：字段同步后必须实际读回，再确认一致', async () => {
    const r = await save();
    assert.strictEqual(r.writes.length, 1); assert.deepStrictEqual(r.reads, ['new.png']);
    assert.ok(r.text.includes('已同步并读回确认'));
    assert.ok(!r.text.includes('脚本复核未通过'));
    assert.strictEqual(r.context.sameSavedScriptData({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
    assert.strictEqual(r.context.sameSavedScriptData([1, 2], [2, 1]), false);
});
test('保存复核：无字段接口但持久化一致时不误报脚本失败', async () => {
    const r = await save({ noWriter: true });
    assert.strictEqual(r.writes.length, 0); assert.ok(r.text.includes('已读回确认'));
    assert.ok(!r.text.includes('脚本复核未通过'));
});
test('保存复核：列表滞后时按创建头像只读新卡，不写同名旧卡', async () => {
    const r = await save({ staleList: true });
    assert.strictEqual(r.writes.length, 0); assert.deepStrictEqual(r.reads, ['new.png']);
    assert.ok(r.text.includes('已读回确认'));
    const noRefresh = await save({ noList: true, noRefresh: true });
    assert.ok(noRefresh.text.includes('已读回确认')); assert.strictEqual(noRefresh.writes.length, 0);
});
test('保存复核：字段接口静默失败时报告实际脚本不一致', async () => {
    const r = await save({ silentWriteFailure: true, scriptMismatch: true });
    assert.strictEqual(r.writes.length, 1);
    assert.ok(r.text.includes('读回的酒馆助手脚本数据与转换结果不一致'));
    assert.ok(!r.text.includes('✓ 已同步并读回确认'));
});
test('保存复核：读取失败与转换标记不一致必须分别报告', async () => {
    const http = await save({ httpError: 503 }); assert.ok(http.text.includes('HTTP 503'));
    const malformed = await save({ malformed: true }); assert.ok(malformed.text.includes('不含角色数据'));
    const wrong = await save({ wrongMarker: true }); assert.ok(wrong.text.includes('转换标记与本次转换不一致'));
});
test('保存复核：没有唯一头像及匹配标记时不猜测目标', async () => {
    const r = await save({ noAvatar: true, noList: true });
    assert.deepStrictEqual(r.writes, []); assert.deepStrictEqual(r.reads, []);
    assert.ok(r.text.includes('创建接口未返回头像'));
});
test('保存进度：同一保存尚未结束时第二次调用不得重复创建', async () => {
    const r = await save({ onCreate: async context => {
        assert.strictEqual(await context.saveCardToSillyTavern(), false);
    } });
    assert.strictEqual(r.creates, 1);
});
test('保存进度：接口失败后关闭弹窗并允许再次保存', async () => {
    const r = await save({ createFailure: true });
    assert.match(r.text, /公开保存失败/);
    assert.strictEqual(await r.context.saveCardToSillyTavern(), false);
});

'use strict';
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const vm = require('vm');
const create = require('../src/write-barrier');
const { nativeRuntime } = require('./runtime-native');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('写入边界：空队列不加延迟，内联工厂不依赖Node作用域', async () => {
    let yields = 0;
    const factory = vm.runInNewContext('(' + create.toString() + ')');
    await factory({ assertCurrent() {}, readPending: () => null, yieldTurn: () => { yields++; } }).wait({});
    assert.equal(yields, 0);
});

test('写入边界：等待作者Promise链继续提交的下一笔，不重复提交数据', async () => {
    const first = deferred(), second = deferred(); let pending = first.promise, done = false;
    first.promise.then(() => { pending = null; return Promise.resolve(); }).then(() => { pending = second.promise; });
    const waiting = create({ assertCurrent() {}, readPending: () => pending, yieldTurn: turn }).wait({}).then(() => { done = true; });
    first.resolve(true); await turn(); assert.equal(done, false);
    second.promise.then(() => { pending = null; }); second.resolve(true); await waiting;
    assert.equal(done, true);
});

test('写入边界：失败、失效会话与取消不能报告等待成功', async () => {
    await assert.rejects(create({ assertCurrent() {}, readPending: () => Promise.resolve(false), yieldTurn: turn }).wait({}), e => e.code === 'MVU_WRITE_NOT_SAVED');
    const write = deferred(); let current = true;
    const p = create({ assertCurrent() { if (!current) throw Error('expired'); }, readPending: () => write.promise, yieldTurn: turn }).wait({});
    current = false; write.resolve(true); await assert.rejects(p, /expired/);
    const cancel = deferred(), token = { promise: cancel.promise, cancelled: false };
    const stopped = create({ assertCurrent() {}, readPending: () => new Promise(() => {}), yieldTurn: turn }).wait({}, token);
    token.cancelled = true; cancel.resolve(); await assert.rejects(stopped, e => e.code === 'MVU_OPERATION_CANCELLED');
});

function events(context) {
    Object.assign(context.event_types, { GENERATION_AFTER_COMMANDS: 'pre_generation', GENERATION_STOPPED: 'stop_generation', CHAT_CHANGED: 'chat_changed' });
}
function write(h, gold) {
    const wrap = h.win.Mvu.getMvuData(); wrap.stat_data.状态.金币 = gold;
    return h.win.Mvu.replaceMvuData(wrap);
}

test('写入边界实装：正常生成等待全部已接收写入及作者连续队列', async () => {
    const h = await nativeRuntime(undefined, ({ context }) => events(context));
    let chained;
    const first = write(h, 41); first.then(() => Promise.resolve()).then(() => { chained = write(h, 52); });
    await h.context.eventSource.emit('pre_generation');
    h.context.chat.push({ is_user: true, mes: '允许先追加用户楼' });
    let ready = false; const aborts = [];
    const before = h.win.mvu2shujukuBeforeGeneration([], 1000, flag => aborts.push(flag)).then(() => { ready = true; });
    await Promise.resolve(); assert.equal(ready, false);
    await h.advance(5000); await before; assert.equal(await first, true); assert.equal(await chained, true);
    assert.deepStrictEqual(aborts, []); assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币, 52);
    assert.equal(core.extensionManifest().generate_interceptor, 'mvu2shujukuBeforeGeneration');
});

test('写入边界实装：事件吞错时仍通过正式回调中止失败生成', async () => {
    let calls = 0, errors = 0;
    const h = await nativeRuntime(undefined, ({ context, api, win }) => {
        events(context); win.toastr = { error() { errors++; } };
        for (const name of ['updateCell', 'updateRow', 'importTableAsJson']) api[name] = async () => { calls++; return false; };
        api.initGameSession = async () => ({ success: false });
    });
    const pending = write(h, 41); await h.context.eventSource.emit('pre_generation');
    const aborts = [], before = h.win.mvu2shujukuBeforeGeneration([], 1000, flag => aborts.push(flag));
    await h.advance(30000); await before; assert.equal(await pending, false); assert(calls > 0);
    assert.deepStrictEqual(aborts, [true]); assert.equal(errors, 1);
});

test('写入边界实装：停止生成解除等待但不取消已有数据写入', async () => {
    const h = await nativeRuntime(undefined, ({ context }) => events(context));
    const pending = write(h, 41); await h.context.eventSource.emit('pre_generation');
    const aborts = [], before = h.win.mvu2shujukuBeforeGeneration([], 1000, flag => aborts.push(flag));
    await h.context.eventSource.emit('stop_generation'); await before;
    assert.deepStrictEqual(aborts, [true]); await h.advance(5000); assert.equal(await pending, true);
});

test('写入边界实装：允许宿主在已等待后重生成删除原楼，不误判成跨会话', async () => {
    let busy = 0;
    const h = await nativeRuntime(undefined, ({ context }) => { events(context); context.deactivateSendButtons = () => { busy++; }; });
    const pending = write(h, 41), before = h.context.eventSource.emit('pre_generation', 'regenerate');
    await h.advance(5000); await before; assert.equal(await pending, true);
    assert.equal(busy, 1);
    h.context.chat.push({ is_user: false, mes: '合法重生成的新目标' });
    const aborts = []; await h.win.mvu2shujukuBeforeGeneration([], 1000, flag => aborts.push(flag));
    assert.deepStrictEqual(aborts, []);
});

for (const name of ['createChatMessages', 'deleteChatMessages', 'setChatMessages']) {
    test('写入边界命名空间：'+name+'等待写入且不制造裸全局', async () => {
        let received, helper;
        const h = await nativeRuntime(undefined, ({ win, context }) => {
            events(context); helper = { [name]: function (...args) { received = { receiver: this, args }; return 'helper-result'; } };
            win.TavernHelper = helper;
        });
        assert.equal(h.win[name], undefined);
        const pending = write(h, 41), input = name === 'deleteChatMessages' ? '1-2' : [{ message_id: 0, message: 'text' }];
        const result = h.win.TavernHelper[name](input, { refresh: 'none' });
        await Promise.resolve(); assert.equal(received, undefined);
        await h.advance(5000); assert.equal(await pending, true); assert.equal(await result, 'helper-result');
        assert.strictEqual(received.receiver, helper); assert.strictEqual(received.args[0], input);
    });
}

test('写入边界实装：普通卡生成不读取数据库或中止请求', async () => {
    const h = await nativeRuntime(undefined, ({ context }) => events(context));
    h.context.characters.push({ name: 'ordinary', avatar: 'ordinary.png', extensions: {} });
    h.context.characterId = 1; h.context.chatId = 'ordinary';
    let reads = 0; h.api.exportTableAsJson = () => { reads++; throw Error('must not read'); };
    await h.context.eventSource.emit('pre_generation');
    const aborts = []; await h.win.mvu2shujukuBeforeGeneration([], 1000, flag => aborts.push(flag));
    assert.equal(reads, 0); assert.deepStrictEqual(aborts, []);
});

for (const name of ['createChatMessages', 'deleteChatMessages', 'setChatMessages']) {
    test('写入边界实装：'+name+'先保存再修改消息，保留原参数与receiver', async () => {
        const calls = []; let native;
        const h = await nativeRuntime(undefined, ({ win, context }) => {
            events(context);
            native = function (...args) { calls.push({ receiver: this, args, gold: win.Mvu.getMvuData().stat_data.状态.金币 }); return 'native-result'; };
            win[name] = native;
        });
        const pending = write(h, 41);
        const arg = name === 'deleteChatMessages' ? '1-2' : [{ message_id: 0, role: 'user', message: 'plain' }];
        const opts = { refresh: 'none' }, mutation = h.win[name](arg, opts);
        await Promise.resolve(); assert.equal(calls.length, 0);
        await h.advance(5000); assert.equal(await pending, true); assert.equal(await mutation, 'native-result');
        assert.equal(calls.length, 1); assert.strictEqual(calls[0].args[0], arg); assert.strictEqual(calls[0].args[1], opts);
        assert.strictEqual(calls[0].receiver, vm.runInContext('window', h.win)); assert.equal(calls[0].gold, 41);
    });
}

test('写入边界实装：等待期间切聊天不继续旧消息操作', async () => {
    let created = 0;
    const h = await nativeRuntime(undefined, ({ win, context }) => { events(context); win.createChatMessages = async () => { created++; }; });
    const pending = write(h, 41), mutation = h.win.createChatMessages([{ role: 'user', message: 'old' }]);
    const rejected = assert.rejects(mutation, /会话|聊天|session/i);
    h.context.chatId = 'other'; await h.context.eventSource.emit('chat_changed');
    await rejected; assert.equal(await pending, false); assert.equal(created, 0);
});

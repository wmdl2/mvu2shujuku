'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert } = require('./helpers');
const createFrontendReadiness = require('../src/frontend-readiness');

function harness(extra = {}) {
    let epoch = 1, target = { index: 2, message: {}, swipe: 0, text: 'saved' };
    const frame = { document: { readyState: 'interactive' } }, calls = [], errors = [];
    const factory = vm.runInNewContext('(' + createFrontendReadiness.toString() + ')');
    const recovery = factory({ target: () => target, capture: () => epoch, sameSession: (a, b) => a === b,
        current: session => session === epoch, prepare: async index => calls.push(['prepare', index]),
        read: index => { calls.push(['read', index]); return { stat_data: { count: 4 } }; },
        wait: async ms => calls.push(['wait', ms]), reload: () => calls.push(['reload']), onError: e => errors.push(e), ...extra });
    return { recovery, frame, calls, errors, changeSession: () => epoch++, changeTarget: value => { target = value; }, target: () => target };
}
test('状态栏就绪恢复：公共原生刷新只执行一次，reload后的同一Window也不循环', async () => {
    const h = harness();
    assert.strictEqual(await h.recovery.request(h.frame), true);
    assert.deepStrictEqual(h.calls, [['prepare', 2], ['read', 2], ['wait', 0], ['reload']]);
    h.frame.document = { readyState: 'interactive' };
    assert.strictEqual(await h.recovery.request(h.frame), false);
    assert.strictEqual(h.calls.filter(x => x[0] === 'reload').length, 1);
});
test('状态栏就绪恢复：重复未就绪读取合并为同一任务', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ prepare: () => gate });
    const a = h.recovery.request(h.frame), b = h.recovery.request(h.frame);
    assert.strictEqual(a, b);
    release(); assert.strictEqual(await a, true);
    assert.strictEqual(h.calls.filter(x => x[0] === 'reload').length, 1);
});
test('状态栏就绪恢复：聊天、消息对象、楼层、swipe、正文或document变化均取消旧任务', async () => {
    for (const change of ['session', 'message', 'index', 'swipe', 'text', 'document', 'detached']) {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const h = harness({ prepare: () => gate }), pending = h.recovery.request(h.frame);
        if (change === 'session') h.changeSession();
        else if (change === 'document') h.frame.document = { readyState: 'interactive' };
        else if (change === 'detached') h.changeTarget(null);
        else h.changeTarget({ ...h.target(), [change]: change === 'message' ? {} : 'changed' });
        release(); assert.strictEqual(await pending, false, change);
        assert.strictEqual(h.calls.some(x => x[0] === 'reload'), false, change);
    }
});
test('状态栏就绪恢复：等待文档脚本完成并让出当前事件，不等待图片完整加载', async () => {
    let h;
    h = harness({ wait: async ms => { h.calls.push(['wait', ms]); h.frame.document.readyState = 'interactive'; } });
    h.frame.document.readyState = 'loading';
    assert.strictEqual(await h.recovery.request(h.frame), true);
    assert.deepStrictEqual(h.calls.filter(x => x[0] === 'wait'), [['wait', 250], ['wait', 0]]);
});
test('状态栏就绪恢复：未准备好有限等待，真实失败不重试重载或漏出拒绝', async () => {
    const error = Object.assign(new Error('not ready'), { code: 'MVU_DATA_NOT_READY' });
    const h = harness({ maxAttempts: 2, read: () => { throw error; } });
    assert.strictEqual(await h.recovery.request(h.frame), false);
    assert.strictEqual(h.calls.filter(x => x[0] === 'prepare').length, 2);
    assert.strictEqual(await h.recovery.request(h.frame), false);
    assert.strictEqual(h.calls.filter(x => x[0] === 'prepare').length, 2);
    const broken = harness({ prepare: async () => { throw Error('damaged history'); } });
    assert.strictEqual(await broken.recovery.request(broken.frame), false);
    assert.strictEqual(broken.errors[0].message, 'damaged history');
});
test('状态栏就绪恢复：脚本、父窗口或已移除frame没有消息目标时不接管', async () => {
    const h = harness({ target: () => null });
    assert.strictEqual(await h.recovery.request(h.frame), false);
    assert.strictEqual(h.calls.length, 0);
});

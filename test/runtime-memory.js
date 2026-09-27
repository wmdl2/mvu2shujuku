'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs } = require('./helpers');
function continuity() {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    function section(start, end) {
        const a = source.indexOf(start), b = source.indexOf(end, a);
        assert.ok(a >= 0 && b > a); return source.slice(a, b);
    }
    let now = 1000;
    const ticks = [], timeouts = [];
    const context = vm.createContext({
        runtimeScopedChatKey: key => key,
        getContextSafe: () => ({ chat: [{}] }),
        Date: { now: () => now }, dbg() {}, activeLayout: null,
        applyActiveGreetingInitvar() { throw new Error('非转换卡不应重跑开场'); },
        hostWindow: {
            setInterval(fn) { ticks.push(fn); return ticks.length; },
            setTimeout(fn) { timeouts.push(fn); },
        },
    });
    // 直接运行产品调用的连续性函数和现有轮询，不复制清理算法。
    vm.runInContext(section('    const openingContinuityByChat =', '    // 对应 MVU 的 init 时机')
        + section('    let greetingPollTimer =', '    function bindAutoInit('), context);
    return { context, ticks, timeouts, advance(ms) { now += ms; },
        state: key => context.openingContinuityState(key),
        size: () => vm.runInContext('Object.keys(openingContinuityByChat).length', context),
    };
}
test('运行内存：过期开场快照由单个既有轮询回收，切离转换卡也清理', () => {
    const h = continuity();
    for (let i = 0; i < 100; i++) h.context.armOpeningContinuity('chat' + i, { data: i });
    const first = h.state('chat0');
    assert.strictEqual(h.ticks.length, 1, '不因每个快照增加常驻定时器');
    assert.strictEqual(h.size(), 100, '有效保护不因数量而淘汰');
    h.advance(29 * 60000); h.context.refreshOpeningContinuityAfterWrite('chat0', { data: '新值' });
    h.advance(2 * 60000); h.ticks[0]();
    assert.strictEqual(h.size(), 1);
    assert.strictEqual(h.state('chat0'), first);
    assert.strictEqual(first.snapshot.data, '新值');
    h.advance(30 * 60000); h.ticks[0]();
    assert.strictEqual(h.size(), 0);
    assert.strictEqual(first.snapshot, null, '清空旧state引用中的大快照');
});
test('运行内存：开场恢复进行中不回收，完成后释放且解除保护不新建状态', () => {
    const h = continuity();
    h.context.disarmOpeningContinuity('missing');
    assert.strictEqual(h.size(), 0);
    h.context.armOpeningContinuity('active', { data: '保护' });
    const st = h.state('active'); st.recovering = true;
    h.advance(31 * 60000); h.ticks[0]();
    assert.strictEqual(h.state('active'), st);
    assert.strictEqual(st.snapshot.data, '保护');
    h.context.disarmOpeningContinuity('active');
    assert.strictEqual(h.timeouts.length, 1);
    st.recovering = false; h.timeouts[0]();
    assert.strictEqual(h.size(), 0);
    assert.strictEqual(st.snapshot, null);
    for (let i = 0; i < 200; i++) h.state('idle' + i);
    h.ticks[0]();
    assert.strictEqual(h.size(), 0, '无快照的闲置聊天登记也应释放');
});

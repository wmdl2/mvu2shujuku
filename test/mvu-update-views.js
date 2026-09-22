'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs, core } = require('./helpers');
test('MVU 更新视图：每轮 display 完整、delta 仅含本轮嵌套路径，旧数据不受污染', async () => {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    function parseMvuCmdValue(');
    const end = source.indexOf('    // 公共 MVU API 使用 Lodash 路径语义', start);
    assert.ok(start >= 0 && end > start);
    const events = [];
    const context = { window: { MVU2SHUJUKU_CORE: core }, hostWindow: {}, console,
        openingBulkClosedChats: new Set(), runtimeScopedChatKey: x => x, autoInitChatId: () => 'chat', pruneOrderedCollection() {},
        emitMvuEvent: async (name, ...args) => { if (name === 'mag_variable_update_ended') events.push(JSON.parse(JSON.stringify(args))); },
    };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context);
    const before = { stat_data: { A: { x: 1, y: 2, name: '甲' } }, display_data: { stale: '上轮' }, delta_data: { stale: '上轮变化' } };
    const first = await context.runMvuUpdateCycle('<UpdateVariable>_.set("A.x",3);</UpdateVariable>', before);
    const second = await context.runMvuUpdateCycle('<UpdateVariable>_.set("A.y",4);</UpdateVariable>', first);
    const plain = x => JSON.parse(JSON.stringify(x));
    assert.deepStrictEqual(plain(first.delta_data), { A: { x: '1->3' } });
    assert.deepStrictEqual(plain(second.delta_data), { A: { y: '2->4' } });
    assert.deepStrictEqual(plain(second.display_data), { A: { x: 3, y: '2->4', name: '甲' } });
    assert.deepStrictEqual(before.stat_data, { A: { x: 1, y: 2, name: '甲' } });
    assert.deepStrictEqual(events[1][0].stat_data.$internal.delta_data, { A: { y: '2->4' } });
    assert.ok(!('$internal' in second.stat_data));
});

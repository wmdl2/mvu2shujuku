'use strict';
const { test } = require('./runner');
const { assert } = require('./helpers');
const vm = require('vm');
const libraries = require('../src/vendor/schema-engine-libs');
const { createEjsEvalBridge } = require('../src/extension-runtime');
const ejs = require('../src/vendor/ejs-parser')();
function harness(factory = createEjsEvalBridge, context = {}) {
    let state = { stat_data: { gold: 44, zero: 0, off: false, empty: null, list: ['a'], object: { x: 1, a: [1] }, encoded: '{"0":3,"named":false}' } };
    const writes = [], nativeCalls = [];
    const chat = [{ is_user: false, swipe_id: 0 }, { is_user: true }, { is_user: false, swipe_id: 0, swipes: ['a', 'b'] }];
    const native = {};
    for (const name of ['getvar', 'getMessageVar', 'setvar', 'setMessageVar', 'incvar', 'incMessageVar', 'decvar', 'decMessageVar', 'delvar', 'delMessageVar', 'insvar', 'insertMessageVar', 'patchVariables']) {
        native[name] = function (...args) { nativeCalls.push({ name, receiver: this, args }); return 'native'; };
    }
    const env = { ...native, ...context };
    const factoryDeps = { lodash: libraries.lodash, readChat: () => chat, hasMessageData: i => i !== 1,
        readHistory: i => i === 0 ? { stat_data: { gold: 9 } } : undefined };
    const bridge = factory(factoryDeps);
    const facade = bridge.createVariableContext(() => state, next => { writes.push(next); state = { stat_data: next }; }, env);
    return { bridge, facade, env, writes, nativeCalls, chat, state: () => state, update: value => { state = value; } };
}
test('统一变量入口：原EJS执行器计算动态参数，数据库读写不改原生变量', async () => {
    const h = harness();
    assert.strictEqual(await ejs.render('<% const p="stat_data."+"gold"; setvar(p,73); %><%= getvar(p) %>', h.facade, { async: true }), '73');
    assert.strictEqual(h.state().stat_data.gold, 73); assert.strictEqual(h.nativeCalls.length, 0); assert.strictEqual(h.writes.length, 1);
});
test('统一变量入口：原EJS的局部同名函数、参数表达式和大小写语义保持不变', async () => {
    const core = require('../src/mvu2shujuku');
    const h = harness();
    const source = '<% const getvar = p => "local:"+p; const GetVar = () => "case"; %><%= getvar("stat_data.gold") %>/<%= GetVar() %>';
    const converted = core.rewriteEjsConditions(source, { entries: [] }, core.createReport()).text;
    assert.strictEqual(converted, source);
    assert.strictEqual(await ejs.render(converted, h.facade, { async: true }), 'local:stat_data.gold/case');
    assert.strictEqual(h.writes.length, 0);
});
test('统一变量入口：非数据库路径和独立作用域原参数原receiver委派', () => {
    const h = harness();
    for (const options of [{ scope: 'global' }, { scope: 'local' }, { scope: 'initial' }]) {
        assert.strictEqual(h.facade.getvar('stat_data.gold', options), 'native');
        assert.strictEqual(h.facade.setvar('stat_data.gold', 7, options), 'native');
        assert.strictEqual(h.nativeCalls.at(-1).args[2], options);
    }
    h.facade.getMessageVar('plain', { clone: true });
    assert.strictEqual(h.nativeCalls.at(-1).receiver, h.env);
    assert.strictEqual(h.writes.length, 0);
});
test('统一变量入口：历史正负索引、执行上下文和缺失消息不回退当前', () => {
    const h = harness();
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', { withMsg: { id: 0 } }), 9);
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', { withMsg: { id: -3 } }), 9);
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', { withMsg: { id: 99 }, defaults: 0 }), 0);
    assert.strictEqual(harness(createEjsEvalBridge, { message_id: 0 }).facade.getvar('stat_data.gold'), 9);
});
test('统一变量入口：withMsg只选择显式message读取，cache沿用当前执行上下文', () => {
    const h = harness();
    const options = { withMsg: { id: 0 } };
    assert.strictEqual(h.facade.getvar('stat_data.gold', options), 44);
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', options), 9);
    h.facade.setvar('stat_data.gold', 88, { ...options, scope: 'cache' });
    assert.strictEqual(h.facade.getvar('stat_data.gold'), 88);
    assert.strictEqual(h.state().stat_data.gold, 44);
    assert.strictEqual(h.writes.length, 0);
});
test('统一变量入口：历史写入和未选中swipe显式拒绝，写入管线零调用', () => {
    const h = harness();
    assert.throws(() => h.facade.setMessageVar('stat_data.gold', 49, { withMsg: { id: 0 } }), { code: 'MVU_HISTORY_WRITE_UNSUPPORTED' });
    assert.throws(() => h.facade.getMessageVar('stat_data.gold', { withMsg: { id: 2, swipe_id: 1 } }), { code: 'MVU_HISTORY_SWIPE_UNSUPPORTED' });
    assert.throws(() => h.facade.setMessageVar('stat_data.gold', 49, { withMsg: { id: 99 } }), { code: 'MVU_HISTORY_WRITE_UNSUPPORTED' });
    assert.strictEqual(h.writes.length, 0); assert.strictEqual(h.state().stat_data.gold, 44);
});
test('统一变量入口：flags检查字段存在性，保留零/false/null及旧值返回', () => {
    const h = harness();
    for (const key of ['zero', 'off', 'empty']) assert.strictEqual(h.facade.setvar('stat_data.' + key, 99, 'nx'), undefined);
    assert.strictEqual(h.facade.setvar('stat_data.missing', 99, 'xx'), undefined);
    assert.strictEqual(h.facade.setvar('stat_data.gold', 45, { results: 'old' }), 44);
    assert.strictEqual(h.facade.setvar('stat_data.new', 0, 'nxs'), 0);
    assert.strictEqual(h.facade.setvar('stat_data.new', 1, 'nxs'), undefined);
    assert.strictEqual(h.facade.setvar('stat_data.new', 1, 'xxs'), 1);
});
test('统一变量入口：merge数组追加、对象深合并与嵌套数组替换', () => {
    const h = harness();
    assert.deepStrictEqual(h.facade.setvar('stat_data.list', ['b'], { merge: true }), ['a', 'b']);
    assert.deepStrictEqual(h.facade.setvar('stat_data.object', { y: 2, a: [3] }, { merge: true }), { x: 1, y: 2, a: [3] });
});
test('统一变量入口：index处理JSON字符串中的下标，不能当消息编号', () => {
    const h = harness();
    assert.strictEqual(h.facade.getvar('stat_data.encoded', { index: 0 }), 3);
    assert.strictEqual(h.facade.getMessageVar('stat_data.encoded', { index: 'named' }), false);
    assert.strictEqual(h.facade.getvar('stat_data.encoded', { index: 'named' }), undefined);
    assert.strictEqual(h.facade.setvar('stat_data.encoded', 4, { index: 0, results: 'old' }), 3);
    assert.strictEqual(JSON.parse(h.state().stat_data.encoded)[0], 4);
});
test('统一变量入口：cache不持久化，noCache重读数据库，clone不泄露引用', () => {
    const h = harness();
    h.facade.setvar('stat_data.gold', 80, 'cache');
    assert.strictEqual(h.facade.getvar('stat_data.gold'), 80); assert.strictEqual(h.writes.length, 0);
    assert.strictEqual(h.facade.getvar('stat_data.gold', { noCache: true }), 44);
    h.facade.getMessageVar('stat_data.list', { clone: true }).push('detached');
    assert.deepStrictEqual(h.facade.getvar('stat_data.list'), ['a']);
});
test('统一变量入口：缓存字段和引用修改不能随其他字段持久化', () => {
    const h = harness();
    h.facade.setvar('stat_data.gold', 88, 'cache');
    h.facade.getvar('stat_data.list', { clone: true }).push('cache-only');
    h.facade.setMessageVar('stat_data.zero', 1);
    assert.strictEqual(h.state().stat_data.gold, 44);
    assert.deepStrictEqual(h.state().stat_data.list, ['a']);
    assert.strictEqual(h.state().stat_data.zero, 1);
    assert.strictEqual(h.facade.getvar('stat_data.gold'), 88);
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', { withMsg: { id: 2 } }), 44);
    assert.strictEqual(h.facade.getvar('stat_data.gold', { noCache: true }), 44);
});
test('统一变量入口：JSON下标沿用宿主数值归一化与显式消息的持久化容器', () => {
    const h = harness();
    h.facade.setvar('stat_data.encoded', 7, { index: '01', scope: 'cache' });
    assert.strictEqual(h.facade.getvar('stat_data.encoded', { index: '1.0' }), 7);
    h.facade.setMessageVar('stat_data.encoded', 8, { index: 0, withMsg: { id: 2 } });
    assert.deepStrictEqual(JSON.parse(h.state().stat_data.encoded), {0:8,named:false});
    assert.strictEqual(h.facade.getvar('stat_data.encoded', { index: '01' }), undefined);
    assert.strictEqual(h.facade.getvar('stat_data.missing', 'unrecognized'), undefined);
});
test('统一变量入口：宿主isDryRun门控与dryRun强制许可一致', () => {
    const h = harness(createEjsEvalBridge, { isDryRun: true });
    assert.strictEqual(h.facade.setvar('stat_data.gold', 70), undefined); assert.strictEqual(h.writes.length, 0);
    assert.strictEqual(h.facade.setvar('stat_data.gold', 70, true), 70); assert.strictEqual(h.writes.length, 1);
});
test('统一变量入口：增减、数组插入和按值删除共用数据库提交', () => {
    const h = harness();
    assert.strictEqual(h.facade.incvar('stat_data.gold', 3, { max: 45 }), 45);
    assert.strictEqual(h.facade.decMessageVar('stat_data.gold', 2), 43);
    assert.deepStrictEqual(h.facade.insertMessageVar('stat_data.list', 'b', 0), ['b', 'a']);
    assert.deepStrictEqual(h.facade.delvar('stat_data.list', 'a'), ['b']);
    assert.strictEqual(h.nativeCalls.length, 0);
});
test('统一变量入口：原型写入拒绝，合法数组和含点键保持路径语义', () => {
    const h = harness();
    assert.throws(() => h.facade.setvar('stat_data.__proto__.polluted', true), { code: 'MVU_VARIABLE_PATH_UNSAFE' });
    h.facade.setvar('stat_data["literal.dot"][0]', 3.5);
    assert.strictEqual(h.facade.getvar('stat_data["literal.dot"][0]'), 3.5);
    assert.strictEqual({}.polluted, undefined);
});
test('统一变量入口：实际内联工厂在无Node作用域VM执行相同行为', async () => {
    const factory = vm.runInNewContext('(' + createEjsEvalBridge.toString() + ')');
    const h = harness(factory);
    assert.strictEqual(await ejs.render('<% const field="gold"; setMessageVar("stat_data."+field, 51, {results:"old"}); %><%= getvar("stat_data."+field) %>', h.facade, { async: true }), '51');
    assert.strictEqual(h.state().stat_data.gold, 51);
});

test('统一变量入口：消息别名强制message作用域且不修改作者选项对象', () => {
    const h = harness();
    const options = Object.freeze({ scope: 'global', defaults: 0 });
    assert.strictEqual(h.facade.getvar('stat_data.gold', options), 'native');
    assert.strictEqual(h.facade.getMessageVar('stat_data.gold', options), 44);
    assert.strictEqual(options.scope, 'global');
    assert.strictEqual(h.facade.setMessageVar('stat_data.gold', 45, options), 45);
    assert.strictEqual(options.scope, 'global');
});
test('统一变量入口：旧执行上下文切聊天后不能读写新数据库，普通变量仍委派', () => {
    let identity = 'A'; const writes = [];
    const bridge = createEjsEvalBridge({ lodash: libraries.lodash, readSessionKey: () => identity });
    const context = { getvar: () => 'native' };
    const facade = bridge.createVariableContext(() => ({ stat_data: { gold: 10 } }), value => writes.push(value), context);
    assert.strictEqual(facade.getvar('stat_data.gold'), 10); identity = 'B';
    assert.throws(() => facade.getvar('stat_data.gold'), { code: 'MVU_VARIABLE_CONTEXT_STALE' });
    assert.throws(() => facade.setvar('stat_data.gold', 20), { code: 'MVU_VARIABLE_CONTEXT_STALE' });
    assert.strictEqual(facade.getvar('other'), 'native'); assert.strictEqual(writes.length, 0);
});
test('统一变量入口：整份读取合并数据库视图，批量原生写入不能夹带stat_data', () => {
    const h = harness();
    assert.strictEqual(h.facade.getvar(null).stat_data.gold, 44);
    assert.throws(() => h.facade.setvar(null, { stat_data: { gold: 73 } }), { code: 'MVU_BULK_VARIABLE_WRITE_UNSUPPORTED' });
    assert.throws(() => h.facade.patchVariables(null, [{ op: 'replace', path: '/stat_data/gold', value: 73 }]), { code: 'MVU_BULK_VARIABLE_WRITE_UNSUPPORTED' });
    assert.strictEqual(h.writes.length, 0);
});

test('统一变量入口：变量对象的动态下标读取数据库，其他键保留原生引用', () => {
    const native = { ordinary: 1, stat_data: { gold: 9 } };
    const facade = createEjsEvalBridge({ lodash: libraries.lodash }).createVariableContext(
        () => ({ stat_data: { gold: 44 } }), () => {}, { getvar: () => native });
    const view = facade.variableView(), root = 'stat_' + 'data';
    assert.strictEqual(view[root].gold, 44); view.ordinary = 2;
    assert.strictEqual(native.ordinary, 2); assert.strictEqual(native.stat_data.gold, 9);
    assert.strictEqual(JSON.parse(JSON.stringify(view)).stat_data.gold, 44);
    view.stat_data = { gold: 73 };
    assert.strictEqual(view.stat_data.gold, 73);
    assert.strictEqual(facade.getvar('stat_data.gold', {noCache:true}),44);
    assert.strictEqual(native.stat_data.gold, 9);
});

test('统一变量入口：消息角色保持宿主原始布尔匹配，不把缺失system字段当false', () => {
    const chat = [{is_user:false}, {is_user:true}, {is_user:false}];
    const bridge = createEjsEvalBridge({lodash:libraries.lodash,readChat:()=>chat,hasMessageData:()=>true});
    assert.strictEqual(bridge.selectMessage({withMsg:{role:'user'}}).index,1);
    assert.strictEqual(bridge.selectMessage({withMsg:{role:'assistant'}}).index,2);
    // The native selector also admits the last non-user message for system;
    // preserve that observed contract rather than correcting the host here.
    assert.strictEqual(bridge.selectMessage({withMsg:{role:'system'}}).index,2);
});

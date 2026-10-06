'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs, core } = require('./helpers');
const { cases, snapshot } = require('./table-prompt-cases');
const baseline = require('./table-prompt-baseline.json');

for (const entry of cases()) test('提示输出冻结：' + entry.name, () => {
    assert.deepStrictEqual(snapshot(core, entry), baseline.cases[entry.name]);
});

test('提示输出冻结：完整浏览器装配在无 require 的 VM 中与 Node 输出一致', () => {
    const bundle = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    const context = { console, TextEncoder, TextDecoder, Uint8Array,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        btoa: value => Buffer.from(value, 'binary').toString('base64') };
    vm.createContext(context);
    vm.runInContext(bundle, context);
    assert.strictEqual(typeof context.require, 'undefined');
    assert.strictEqual(typeof context.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__.acorn.parse, 'function');
    assert.strictEqual(typeof context.__MVU2SHUJUKU_TABLE_PROMPTS_FACTORY__, 'function');
    for (const entry of cases()) assert.deepStrictEqual(snapshot(context.MVU2SHUJUKU_CORE, entry), baseline.cases[entry.name], entry.name);
});

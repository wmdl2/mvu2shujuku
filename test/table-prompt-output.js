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
    const coreSource = fs.readFileSync(require.resolve('../src/mvu2shujuku'), 'utf8');
    const yamlSource = fs.readFileSync(require.resolve('../src/vendor/mvu-yaml-libs'), 'utf8');
    const pinyinInline = 'root.__MVU2SHUJUKU_PINYIN__ = ' + JSON.stringify(require('../src/pinyin-data')) + ';';
    const yamlLibsInline = '(function(){var module={exports:{}};var exports=module.exports;\n' + yamlSource
        + '\nglobalThis.__MVU2SHUJUKU_YAML_LIBS__=module.exports;})();';
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = '
        + JSON.stringify(fs.readFileSync(require.resolve('../src/vendor/jsonrepair-lite'), 'utf8')) + ';';
    const context = { console, TextEncoder, TextDecoder, Uint8Array,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        btoa: value => Buffer.from(value, 'binary').toString('base64') };
    vm.createContext(context);
    vm.runInContext(core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'], context);
    assert.strictEqual(typeof context.require, 'undefined');
    assert.strictEqual(typeof context.__MVU2SHUJUKU_TABLE_PROMPTS_FACTORY__, 'function');
    for (const entry of cases()) assert.deepStrictEqual(snapshot(context.MVU2SHUJUKU_CORE, entry), baseline.cases[entry.name], entry.name);
});

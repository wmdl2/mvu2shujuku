'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const createReader = require('../src/sp-version');
const api = { importTemplateFromData() {} };
const resource = (version, extra = {}) => ({ initiatorType: 'script', name: `https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv${version}/index.js`, ...extra });
const windowWith = entries => ({ performance: { getEntriesByType(type) { assert.strictEqual(type, 'resource'); return entries; } } });
function reader({ extensions = {}, windows = [], runtimeApi = api, factory = createReader } = {}) {
    return factory({ readExtensions: async () => extensions, readWindows: () => windows, readApi: () => runtimeApi });
}
function extension(version, disabled = false) {
    return { extensionNames: ['third-party/sp'], extension_settings: { disabledExtensions: disabled ? ['third-party/sp'] : [] },
        getExtensionManifest: () => ({ display_name: 'SP·数据库 9.2.5', version }) };
}
test('SP版本识别：扩展清单优先，四段版本有效，禁用扩展不掩盖脚本', async () => {
    assert.strictEqual(await reader({ extensions: extension('9.2.5') })(), '9.2.5');
    assert.strictEqual(await reader({ extensions: extension('v9.2.5.1') })(), '9.2.5.1');
    assert.strictEqual(await reader({ extensions: extension('9.2.3'), windows: [windowWith([resource('9.2.5.1')])] })(), '9.2.3');
    assert.strictEqual(await reader({ extensions: extension('9.2.3', true), windows: [windowWith([resource('9.2.5.1')])] })(), '9.2.5.1');
});
test('SP版本识别：脚本版读取同源 iframe 已加载官方固定标签，支持扩展接口缺失', async () => {
    const factory = vm.runInNewContext('(' + createReader.toString() + ')');
    const inaccessible = Object.defineProperty({}, 'performance', { get() { throw new Error('cross origin'); } });
    const read = factory({ readExtensions: async () => { throw new Error('无manifest接口'); },
        readWindows: () => [inaccessible, windowWith([resource('9.2.5.1'), resource('9.2.5.1')])], readApi: () => api });
    assert.strictEqual(await read(), '9.2.5.1');
    assert.strictEqual(await reader({ windows: [windowWith([resource('9.2.5.1')])], runtimeApi: null })(), 'unknown');
});
test('SP版本识别：无固定标签、非官方资源、下载请求和版本歧义均不猜测', async () => {
    for (const name of [
        'https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@main/index.js',
        'https://gcore.jsdelivr.net/gh/Other/shujuku@spv9.2.5.1/index.js',
        'https://gcore.jsdelivr.net.evil.test/gh/AlbusKen/shujuku@spv9.2.5.1/index.js',
        'https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv9.2.5.1/not-index.js',
    ]) assert.strictEqual(await reader({ windows: [windowWith([resource('', { name })])] })(), 'unknown');
    assert.strictEqual(await reader({ windows: [windowWith([resource('9.2.5.1', { initiatorType: 'fetch' })])] })(), 'unknown');
    assert.strictEqual(await reader({ windows: [windowWith([resource('9.2.3'), resource('9.2.5.1')])] })(), 'unknown');
    assert.strictEqual(await reader({ extensions: extension('bad'), windows: [windowWith([resource('9.2.5.1')])] })(), 'unknown');
    const extensions = { extensionNames: ['a', 'b'], getExtensionManifest: name => ({ display_name: 'SP·数据库', version: name === 'a' ? '9.2.3' : '9.2.5' }) };
    assert.strictEqual(await reader({ extensions })(), 'unknown');
});
test('SP版本识别：脚本识别结果进入实际转换后保留隐藏列与准确报告', async () => {
    const targetSpVersion = await reader({ windows: [windowWith([resource('9.2.5.1')])] })();
    const card = { name: '脚本版SP', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 状态: { 可见: 1, '$私有': 2 } }) },
    ] } };
    const converted = core.convert(card, { targetSpVersion });
    const sheet = Object.values(converted.template).find(s => s.name === '状态表');
    assert.ok(sheet.sourceData.hiddenPhysicalColumns.length > 0);
    assert.doesNotMatch(converted.reportText, /无法识别目标|低于本转换器已验证/);
    const unknown = core.convert(card, { targetSpVersion: 'unknown' });
    assert.match(unknown.reportText, /无法识别目标 SP·数据库版本/);
    assert.doesNotMatch(unknown.reportText, /请升级至/);
});

'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi, bridgeSandbox } = require('./helpers');
const fs = require('fs');
function input(rule, data = { 任务: {}, 记录: { 关注度: '随意描述' } }) {
    return { name: '规则迁移测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(data) },
        { comment: '[mvu_update]变量更新规则', content: rule },
    ] } };
}
const rule = `---
variables_update_rules:
  任务:
    type: |-
      { [任务名称: string]: {
        关注度: '高' | '中' | '低'; // 合法的静态选项
        说明: string;
      } }
    check:
      - 领取奖励后删除
`;

test('规则迁移：英文外壳和 TS 字面量联合进入提示词与 CHECK', () => {
    const result = core.convert(input(rule));
    const table = Object.values(result.template).find(t => t.name === '任务表');
    assert.ok(table.sourceData.note.includes('可选值：高 / 中 / 低'));
    assert.match(table.sourceData.ddl, /CHECK\(guanzhudu IN \('高', '中', '低'\)\)/);
    assert.ok(table.sourceData.note.includes('领取奖励后删除'));
    assert.ok(!(result.card.data || result.card).character_book.entries.some(e => e.comment === '[mvu_update]变量更新规则'));
});

test('规则迁移：TS 枚举按路径归属，不污染别组同名字段', () => {
    const result = core.convert(input(rule));
    const table = Object.values(result.template).find(t => t.name === '记录表');
    assert.ok(!table.sourceData.note.includes('可选值'));
    assert.ok(!/CHECK\(guanzhudu IN/.test(table.sourceData.ddl));
});

test('规则迁移：check 行内操作说明按文本解析，完整迁移后移除旧规则条目', () => {
    const checks = ['本轮推进时减1（op: delta, value: -1）', '触发事件时重置为15(op: replace, value: 15)'];
    const card = input(`变量更新规则:\n  状态:\n    冷却:\n      type: number\n      check:\n${checks.map(s => '        - ' + s).join('\n')}\n`, { 状态: { 冷却: 20 } });
    const shapes = core.parseMvuShapes(card);
    assert.deepStrictEqual(shapes.checks.状态.冷却, checks, '解析阶段保留业务原文，不吞掉冒号后的内容');
    const result = core.convert(card);
    const data = result.card.data || result.card;
    assert.ok(!data.character_book.entries.some(e => e.comment === '[mvu_update]变量更新规则'));
    assert.ok(!result.report.warnings.some(w => /YAML 解析失败|完整静态规则/.test(w.message)));
    const note = Object.values(result.template).find(t => t.name === '状态表').sourceData.note;
    assert.match(note, /本轮推进时减1/);
    assert.match(note, /触发事件时重置为15/);
    assert.doesNotMatch(note, /op:|value:/, '操作协议由数据库说明负责，业务条件仍保留');
});

test('规则迁移：行内操作容错不改块文本、不掩盖其他 YAML 错误或混合 EJS', () => {
    const text = '本轮推进时减1（op: delta, value: -1）';
    for (const value of ['\n        - ' + JSON.stringify(text), '\n        - |-\n          ' + text + '\n          第二行必须保留']) {
        const shapes = core.parseMvuShapes(input('变量更新规则:\n  状态:\n    冷却:\n      check:' + value, { 状态: { 冷却: 20 } }));
        assert.ok(shapes.checks.状态.冷却[0].includes(text));
        if (value.includes('第二行')) assert.ok(shapes.checks.状态.冷却[0].includes('第二行必须保留'));
    }
    for (const extra of ['\n    其他:\n      type: [缺少闭合', '\n<% if (condition) { %>额外业务<% } %>']) {
        const result = core.convert(input('变量更新规则:\n  状态:\n    冷却:\n      check:\n        - ' + text + extra, { 状态: { 冷却: 20 } }));
        assert.ok((result.card.data || result.card).character_book.entries.some(e => e.comment === '[mvu_update]变量更新规则'));
    }
});

test('规则迁移：宽字符串联合不误建枚举，纯字符串选项保留内部竖线', () => {
    const result = core.convert(input(`变量更新规则:
  任务:
    type: |-
      { [名称: string]: { 关注度: string | '未知'; 说明: '甲|乙' | '丙'; } }
`));
    const table = Object.values(result.template).find(t => t.name === '任务表');
    assert.ok(!/CHECK\(guanzhudu IN/.test(table.sourceData.ddl));
    assert.ok(table.sourceData.note.includes('可选值：甲|乙 / 丙'));
});

test('正则保留：会生成更新块的交互开局面板不视为 MVU 引擎', () => {
    const card = input('');
    card.extensions = { regex_scripts: [
        { scriptName: '开局配置面板', findRegex: '【开局】', replaceString: '<button onclick="start()">开始</button><script>function start(){return "<UpdateVariable>"+"<JSONPatch>[]</JSONPatch></UpdateVariable>";}</script>', markdownOnly: true },
        { scriptName: '纯变量显示', findRegex: '<status_current_variables>', replaceString: '{{format_message_variable::stat_data}}' },
        { scriptName: '去除更新块', findRegex: '<UpdateVariable>[\\s\\S]*?</UpdateVariable>', replaceString: '' },
    ] };
    const result = core.convert(card);
    const regexes = (result.card.data || result.card).extensions.regex_scripts;
    assert.ok(regexes.some(r => r.scriptName === '开局配置面板' && r.replaceString.includes('function start()')));
    assert.ok(!regexes.some(r => r.scriptName === '纯变量显示'));
    assert.ok(regexes.some(r => r.scriptName === '去除更新块'));
});

test('前端 EJS：标签检测正则保留 JS 语义，正常模板不变', () => {
    for (const source of ['<script>const r=/<%|%>/;</script>', '&lt;script&gt;const r=/&lt;%|%&gt;/;&lt;/script&gt;']) {
        const protectedText = core.protectFrontendEjsLiterals(source);
        assert.ok(!protectedText.includes('<%'));
        assert.ok(!protectedText.includes('&lt;%'));
        const literal = protectedText.match(/const r=(.*?);/)[1];
        const regex = Function('return ' + literal)();
        assert.ok(regex.test('<%'));
        assert.ok(regex.test('%>'));
        assert.ok(!regex.test('普通正文'));
        assert.strictEqual(core.protectFrontendEjsLiterals(protectedText), protectedText);
    }
    const template = '<script>const value = <%= value %>;</script><%= name %>';
    assert.strictEqual(core.protectFrontendEjsLiterals(template), template);
});

test('前端 EJS：生成的扩展在当前转换卡渲染阶段保护，切聊天后失效', () => {
    const index = core.assembleExtension({ coreSource: fs.readFileSync(require.resolve('../src/mvu2shujuku.js'), 'utf8') })['index.js'];
    const start = index.indexOf('    function installFrontendEjsLiteralGuard(prepared)');
    const end = index.indexOf('    function bindDebugHooks(context)', start);
    assert.ok(start > 0 && end > start);
    let card = { converted: true, key: 'card1' }, chat = 'chat1', registered;
    const install = Function('currentCharacter', 'isConvertedMvuCard', 'window', 'autoInitChatId', 'cardCacheKey', index.slice(start, end) + ';return installFrontendEjsLiteralGuard;')(
        () => card, c => c.converted, { MVU2SHUJUKU_CORE: core }, () => chat, c => c.key);
    const prepare = runType => install({ runType, activateRegex: (...args) => { registered = args; } });
    prepare('generate');
    assert.strictEqual(registered, undefined);
    prepare('render');
    const [pattern, replacement, opts] = registered;
    const html = '<script>const r=/<%|%>/;</script>\n正文';
    assert.strictEqual(html.replace(pattern, replacement), core.protectFrontendEjsLiterals(html));
    assert.ok(opts.html && opts.message && !opts.generate && !opts.basic);
    chat = 'chat2';
    assert.strictEqual(html.replace(pattern, replacement), html);
    chat = 'chat1'; card = { converted: true, key: 'card2' };
    assert.strictEqual(html.replace(pattern, replacement), html);
    card.converted = false; registered = undefined;
    prepare('render');
    assert.strictEqual(registered, undefined);
});

test('顶层数字：数值 DDL、默认值和示例保留数字，小数往返不变', async () => {
    const result = core.convert(input('变量更新规则:\n  点数:\n    type: number\n    check:\n      - 消耗后更新，不可为负数', { 点数: 0, 比例: 0.5, 空组: {} }), {mode: 'sqlite'});
    const t = Object.values(result.template).find(t => t.name === '点数表');
    assert.match(t.sourceData.ddl, /neirong REAL NOT NULL DEFAULT 0 CHECK\(typeof\(neirong\) IN \('integer', 'real'\)\)/);
    assert.ok(!t.sourceData.ddl.includes('json_valid'));
    assert.match(t.sourceData.updateNode, /SET neirong = 1 WHERE/);
    assert.match(t.sourceData.updateNode, /不得直接照抄示例值/);
    assert.ok(!t.sourceData.note.includes('可写路径'));
    assert.ok(t.sourceData.note.includes('不可为负数'));
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    const tables = JSON.parse(JSON.stringify(result.template));
    const before = core.statDataFromTables(layout, tables).stat_data;
    assert.deepStrictEqual(before, { 点数: 0, 比例: 0.5, 空组: {} });
    await core.writeStatDiffToDb(applyingApi(tables), layout, before, { 点数: 2.75, 比例: 0, 空组: {} });
    assert.ok(!core.lastStatWriteFailed);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, { 点数: 2.75, 比例: 0, 空组: {} });
});

test('顶层数字：缺表与补行使用数字默认，拒绝对象、字符串和非有限数字', async () => {
    const result = core.convert(input('', { 点数: 7 }));
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    assert.strictEqual(core.statDataFromTables(layout, {}).stat_data.点数, 7);
    for (const value of [{}, '8', null, NaN, Infinity]) {
        const tables = JSON.parse(JSON.stringify(result.template));
        let writes = 0;
        const api = applyingApi(tables);
        api.updateCell = () => { writes++; return true; };
        await core.writeStatDiffToDb(api, layout, { 点数: 7 }, { 点数: value });
        assert.ok(core.lastStatWriteFailed);
        assert.strictEqual(writes, 0);
    }
    const tables = JSON.parse(JSON.stringify(result.template));
    const table = Object.values(tables).find(t => t.name === '点数表');
    table.content = [table.content[0]];
    await core.writeStatDiffToDb(applyingApi(tables), layout, { 点数: 7 }, { 点数: 8.5 });
    assert.ok(!core.lastStatWriteFailed);
    assert.strictEqual(core.statDataFromTables(layout, tables).stat_data.点数, 8.5);
});

test('顶层数字：实际生成桥读取数值列，旧 JSON 布局仍可读数字', () => {
    const result = core.convert(input('', { 点数: 0 }));
    const { win } = bridgeSandbox(result, { extra: { setTimeout() { return 0; }, clearTimeout() {} } });
    assert.strictEqual(win.getAllVariables().stat_data.点数, 0);
    const old = [{ kind: 'json', group: '点数', table: '点数表' }];
    assert.strictEqual(core.statDataFromTables(old, { sheet_a: { name: '点数表', content: [['row_id', '内容'], [1, '0']] } }).stat_data.点数, 0);
});

test('删除边界：无交互控件的前端和匹配更新块的业务脚本均保留', () => {
    const card = input('');
    card.extensions = { regex_scripts: [
        { scriptName: '只读状态栏', findRegex: '状态', replaceString: '<div>{{format_message_variable::stat_data}}</div>' },
        { scriptName: '动态状态栏', findRegex: '<UpdateVariable>', replaceString: '<script>Mvu.getMvuData()</script>' },
        { scriptName: '说明', findRegex: '关键词', replaceString: '这里的 UpdateVariable 只是文字说明' },
    ] };
    const result = core.convert(card);
    const regexes = (result.card.data || result.card).extensions.regex_scripts;
    for (const r of card.extensions.regex_scripts) assert.ok(regexes.some(x => x.scriptName === r.scriptName));
    const display = regexes.find(x => x.scriptName === '只读状态栏');
    assert.ok(display.replaceString.includes('mvu2shujukuFormatMessageVariable'));
    assert.ok(!display.replaceString.includes('{{format_message_variable'));
});

test('删除边界：显式更新标记不能删除混合业务，无法完整解析的规则保留', () => {
    const card = input('变量更新规则:\n  任务:\n    type: [缺少闭合');
    card.character_book.entries.push(
        { comment: '[mvu_update]剧情和更新', content: '必须记住誓言。<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' },
        { comment: '[mvu_update]变量输出格式', content: '<% if (getvar("stat_data.开关")) { %>必须记住誓言。<UpdateVariable>[]</UpdateVariable><% } %>' },
        { comment: '[mvu_plot][mvu_update]剧情', content: '必须记住誓言。<UpdateVariable>[]</UpdateVariable>' },
        { comment: '变量列表中的故事', content: '必须记住誓言。<UpdateVariable>[]</UpdateVariable>' });
    const result = core.convert(card);
    const entries = (result.card.data || result.card).character_book.entries;
    for (const e of card.character_book.entries.filter(e => e.comment !== '[InitVar]')) assert.ok(entries.some(x => x.comment === e.comment), e.comment);
});

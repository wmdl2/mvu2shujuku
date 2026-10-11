'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const migrationFactory = require('../src/update-rule-migration');
const { createWorldbookRequestFilter, createEjsEvalBridge } = require('../src/extension-runtime');
const libs = require('../src/vendor/mvu-yaml-libs');
const migration = migrationFactory({ YAML: libs.YAML });
const initial = { 进程: { 阶段: '创角阶段', 评分: 2.5 } };
const entry = (content, comment = '战斗流程', extra = {}) => ({ id: 7, comment, content, keys: ['BOSS'], enabled: true,
    constant: false, selective: true, insertion_order: 123, extensions: { position: 4, depth: 2 }, ...extra });
function run(content, source = entry(content)) {
    return core.convert({ name: '公开填表适配', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: JSON.stringify(initial) }, source,
    ] } });
}
const sourceEntry = r => r.card.character_book.entries.find(e => e.id === 7);
const guide = r => r.card.character_book.entries.find(e => e.extensions?.mvu2shujukuFillGuide === 1);
const request = r => r.card.character_book.entries.filter(e => e.enabled !== false && !e.keys.includes('__ACU_TEMPLATE_DATA__')).map(e => e.content).join('\n\n');
const format = '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
const output = (extra = '') => '<Format>\n变量输出格式:\n  format: |-\n    ' + format + '\n' + extra + '</Format>';

test('统一填表适配：原业务原文、设置和ID保留，仅新增一个说明条目', () => {
    const text = 'step:\n  when: BOSS现身且本回合结束\n  instruction: 你务必在 <JSONPatch> 中把 /进程/阶段 改到 战斗准备；其他条件不变\n  narrative: 保持现场描写';
    const r = run(text), original = sourceEntry(r);
    assert.strictEqual(original.content, text);
    for (const key of ['id', 'keys', 'enabled', 'constant', 'selective', 'insertion_order']) assert.deepStrictEqual(original[key], entry(text)[key]);
    assert.strictEqual(guide(r).comment, '[M2SJK]填表适配说明');
    assert.strictEqual(r.card.character_book.entries.filter(e => e.extensions?.mvu2shujukuFillGuide).length, 1);
    assert(guide(r).enabled && guide(r).constant);
    assert.strictEqual(new Set(r.card.character_book.entries.map(e => e.id)).size, r.card.character_book.entries.length);
    assert(!Object.values(r.template).some(s => s?.sourceData?.note?.includes('你务必')));
    assert(!r.reportText.includes('无法绑定更新路径'));
});
test('统一填表适配：旧标记标题避开宿主过滤，正文只屏蔽更新专用条目', () => {
    const text = '未能静态绑定的业务条件，JSONPatch 操作针对当前对象。';
    const r = run(text, entry(text, '[mvu_update]变量更新规则'));
    assert.strictEqual(sourceEntry(r).content, text);
    assert.match(sourceEntry(r).comment, /^\[M2SJK\]更新要求/);
    const list = r.card.character_book.entries.map(e => ({ ...e, world: '当前书' }));
    const lores = { characterLore: list.slice() };
    createWorldbookRequestFilter({ readCharacter: () => ({ data: { ...r.card, extensions: { ...r.card.extensions, world: '当前书' } } }) }).filter(lores);
    assert(!lores.characterLore.some(e => /\[M2SJK\]/.test(e.comment)));
    assert(list.some(e => e.id === 7 && e.content === text));
});
test('统一填表适配：相对地址、业务名称与未知自然语言不再要求静态绑定', () => {
    for (const text of ['用JSONPatch把 当前阶段 改为结算，原条件不变', 'instruction: JSONPatch更新 当前敌人的生命值', 'update_instructions:\n  check: JSONPatch同步 ../状态，但冻结时禁止']) {
        const r = run(text); assert.strictEqual(sourceEntry(r).content, text);
        assert(!r.reportText.includes('更新规则迁移未完成'));
    }
});
test('统一填表适配：真实目标和值的操作数组保持完整，不改路径或改名', () => {
    const ops = [{ op: 'replace', path: '/进程/评分', value: 3.75 }, { op: 'remove', path: '/未知/字段' }];
    const text = 'mandatory_patch: ' + JSON.stringify(ops);
    const r = run(text); assert.strictEqual(sourceEntry(r).content, text);
    assert(core.prepareFillPrompt(request(r), r.card).text.includes(text));
});
test('统一填表适配：随机计算、未知回调和宿主写入均保留原代码且不复制', () => {
    for (const code of ['const roll=Math.random();', 'const roll=Date.now();', 'await setvar("stat_data.进程.评分", 3.75);', 'const roll=customDice();']) {
        const text = '<% ' + code + ' %>\nJSONPatch更新本轮数值';
        const r = run(text, entry(text, '[mvu_update]战斗计算'));
        const expected = code;
        assert(sourceEntry(r).content.includes(expected));
        assert.strictEqual(r.card.character_book.entries.filter(e => e.content.includes(expected)).length, 1);
        assert(!r.reportText.includes('更新规则迁移未完成'));
    }
});
test('统一填表适配：共享展示与双标记原样保留，不改成更新专用', () => {
    for (const comment of ['[mvu_plot][mvu_update]状态展示', '当前展示']) {
        const text = '<status_current_variable>当前展示JSONPatch是物品名</status_current_variable>';
        const r = run(text, entry(text, comment)); assert.strictEqual(sourceEntry(r).content, text); assert.strictEqual(sourceEntry(r).comment, comment);
    }
});
test('统一填表适配：保存原格式，仅在填表请求副本排除完整纯格式', () => {
    const text = output('  custom_hint: 冻结时禁止修改评分\n'), r = run(text, entry(text, '[mvu_update]变量输出格式'));
    assert.strictEqual(sourceEntry(r).content, text);
    const view = core.prepareFillPrompt(request(r), r.card);
    assert(view.adapted); assert(!view.text.includes(format)); assert(view.text.includes('冻结时禁止修改评分'));
    assert.strictEqual(sourceEntry(r).content, text);
});
test('统一填表适配：完整格式中的实际业务操作及Analysis条件不能删除', () => {
    for (const payload of ['[{"op":"replace","path":"/进程/评分","value":3.75}]', '[]</JSONPatch><Analysis>冻结时不能修改评分</Analysis><JSONPatch>[]']) {
        const text = output().replace('<JSONPatch>[]</JSONPatch>', '<JSONPatch>' + payload + '</JSONPatch>');
        assert.strictEqual(migration.plan(text, { outputOnly: true }).text, text);
    }
});
test('统一填表适配：占位操作仅在完整静态格式内排除，混合真实操作整块保留', () => {
    const ops = [{ op: 'replace', path: '${/path/to/value}', value: 0 }];
    const text = output().replace('[]', JSON.stringify(ops));
    assert(!migration.plan(text, { outputOnly: true }).text.includes('JSONPatch'));
    ops.push({ op: 'replace', path: '/进程/评分', value: 3.75 });
    const mixed = output().replace('[]', JSON.stringify(ops));
    assert.strictEqual(migration.plan(mixed, { outputOnly: true }).text, mixed);
});
test('统一填表适配：不完整格式、EJS、共享代码与台词负例完整保留', () => {
    const texts = ['format: |\n  <UpdateVariable><JSONPatch>[]', 'format: |\n  <UpdateVariable><JSONPatch><%- JSON.stringify(ops) %></JSONPatch></UpdateVariable>',
        'story:\n  format: |\n    ' + format, 'code:\n  format: |\n    ' + format, 'format: |\n  ' + format + '\n  冻结时不能修改评分',
        'format: |\n  <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>尾随业务', 'format: |\n  <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>\nformat: 有冲突'];
    for (const text of texts) assert.strictEqual(migration.plan(text, { outputOnly: true }).text, text, text);
});
test('统一填表适配：静态标签、围栏和CRLF保持其他原文的字节形式', () => {
    for (const text of [output('  hint: 原业务\n'), '<Rules>\n```yaml\n' + output('  hint: 原业务\n') + '\n```\n</Rules>', output('  hint: 原业务\n').replace(/\n/g, '\r\n')]) {
        const view = migration.plan(text, { outputOnly: true }); assert(view.excluded.length); assert(view.text.includes('hint: 原业务')); assert(!view.text.includes('JSONPatch'));
        let reconstructed = view.text;
        for (const [a, b] of view.excluded) assert(text.slice(a, b).includes('format:'));
        assert.strictEqual(text.replace(text.slice(...view.excluded[0]), ''), reconstructed);
    }
});
test('统一填表适配：指引去重仅限真实模板调用，业务字符串和其他卡不受影响', () => {
    const r = run('instruction: JSONPatch修改当前评分'), call = guide(r).content;
    const view = core.prepareFillPrompt(request(r) + '\n\n' + call, r.card);
    assert.strictEqual(view.text.split(core.fillAdaptationGuidance()).length - 1, 1);
    assert(!view.text.includes(migration.guideCall));
    assert.strictEqual(core.prepareFillPrompt(call, { extensions: {} }).adapted, false);
    for (const text of ['业务字符串 ' + call, '<% const example = `' + migration.guideCall + '`; %>']) assert.strictEqual(core.prepareFillPrompt(text, r.card).adapted, false);
    assert.doesNotMatch(core.fillAdaptationGuidance(), /原变量路径|更新组|布局对应/);
});
test('统一填表适配：未启用和不完整匹配的源内容不被请求过滤', () => {
    const r = run(output(), entry(output(), '[mvu_update]变量输出格式', { enabled: false }));
    const text = output() + '\n\n' + guide(r).content;
    assert(core.prepareFillPrompt(text, r.card).text.includes(format));
    const active = run(output(), entry(output(), '[mvu_update]变量输出格式'));
    assert(core.prepareFillPrompt('台词：' + text, active.card).text.includes(format));
    assert.strictEqual(sourceEntry(active).content, output());
});
function bridgeHarness(factory = createEjsEvalBridge) {
    const r = run(output('  hint: 冻结时禁止修改\n'), entry(output('  hint: 冻结时禁止修改\n'), '[mvu_update]变量输出格式'));
    let current = r.card; const calls = [], preparations = [];
    const ejs = { prepareContext: async (...args) => { preparations.push(args); return { original: true }; },
        evalTemplate: async function(code, context, options) {
            calls.push({ receiver: this, code, context, options });
            return String(code);
        } };
    const bridge = factory({ readCharacter: () => current, readCore: () => core, makeDefines: () => ({ mvu2shujukuGetAllVariables: () => initial }) });
    bridge.install(ejs);
    return { r, ejs, calls, preparations, switchCard: card => { current = card; }, bridge };
}
test('统一填表适配：真实运行时桥先清理请求，再正确准备上下文，源卡不变', async () => {
    const h = bridgeHarness(), text = request(h.r), snapshot = JSON.stringify(h.r.card);
    const result = await h.ejs.evalTemplate(text);
    assert(!result.includes(format)); assert(result.includes('冻结时禁止修改')); assert(result.includes(core.fillAdaptationGuidance()));
    assert.strictEqual(h.preparations[0][1], -1); assert.strictEqual(typeof h.preparations[0][0].mvu2shujukuGetAllVariables, 'function');
    assert.strictEqual(h.calls[0].receiver, h.ejs); assert.strictEqual(JSON.stringify(h.r.card), snapshot);
});
test('统一填表适配：正文/预览上下文不采用填表视图，普通文本原样委派', async () => {
    const h = bridgeHarness(), context = { runType: 'generate', world_info: { uid: 7 } }, options = { when: 'body' };
    const text = request(h.r);
    const result = await h.ejs.evalTemplate(text, context, options);
    assert(result.includes(format)); assert.strictEqual(h.calls[0].code, text);
    assert.strictEqual(h.calls[0].context, context); assert.strictEqual(h.calls[0].options, options);
    await h.ejs.evalTemplate('<%= mvu2shujukuGetAllVariables() %>', context, options);
    assert.strictEqual(h.calls[1].context, context);
    const count = h.preparations.length;
    assert.strictEqual(await h.ejs.evalTemplate('plain text'), 'plain text'); assert.strictEqual(h.preparations.length, count);
});
test('统一填表适配：切卡、并发调用和切卡不共用可变指引或执行结果', async () => {
    const h = bridgeHarness(), text = request(h.r);
    const [a, b] = await Promise.all([h.ejs.evalTemplate(text), h.ejs.evalTemplate(text)]);
    assert.strictEqual(a, b); assert.notStrictEqual(h.calls[0].context, h.calls[1].context);
    h.switchCard({ extensions: {} }); assert((await h.ejs.evalTemplate(text)).includes(format));
    h.switchCard(h.r.card);
    assert.strictEqual(await h.ejs.evalTemplate(text), a);
    const original = h.ejs.evalTemplate; h.bridge.install(h.ejs); assert.strictEqual(h.ejs.evalTemplate, original);
});
test('统一填表适配：浏览器内联工厂没有Node外部作用域依赖', async () => {
    const factory = vm.runInNewContext('(' + createEjsEvalBridge.toString() + ')');
    const h = bridgeHarness(factory), result = await h.ejs.evalTemplate(request(h.r));
    assert(!result.includes(format)); assert(result.includes(core.fillAdaptationGuidance()));
    const isolated = vm.runInNewContext('(' + migrationFactory.toString() + ')')({ YAML: libs.YAML });
    assert(!isolated.plan(output(), { outputOnly: true }).text.includes(format));
});


test('统一填表适配：格式槽中的业务检查原文保留，仅排除标签和占位载荷', () => {
    const text = '<Format>\n变量输出格式:\n  format: |-\n    <UpdateVariable>\n    <Analysis>$(IN ENGLISH, no more than 80 words)\n    - ${核对冻结条件并保持原阈值: ...}\n    </Analysis>\n    <JSONPatch>[{"op":"replace","path":"${/path/to/variable}","value":"${new_value}"}]</JSONPatch>\n    </UpdateVariable>\n</Format>';
    const r = run(text, entry(text, '[mvu_update]变量输出格式'));
    assert.strictEqual(sourceEntry(r).content, text);
    const view = core.prepareFillPrompt(request(r), r.card).text;
    assert(view.includes('${核对冻结条件并保持原阈值: ...}'));
    assert(view.includes('$(IN ENGLISH, no more than 80 words)'));
    assert.doesNotMatch(view, /<\/?(?:Analysis|UpdateVariable|JSONPatch)>|new_value/);
});
test('统一填表适配：同条目其他EJS不阻止独立静态格式清理，代码不变', () => {
    const code = '<% const roll=Math.random(); %>\n';
    const text = code + '变量输出格式:\n  format: |-\n    ' + format + '\n  hint: 原业务检查';
    const r = run(text, entry(text, '[mvu_update]变量输出格式'));
    const view = core.prepareFillPrompt(request(r), r.card).text;
    assert(view.includes(code)); assert(view.includes('原业务检查')); assert(!view.includes(format));
    assert.strictEqual(sourceEntry(r).content, text);
});
test('统一填表适配：YAML别名/锚点及业务数据格式字段不会因旧标签删除', () => {
    const text = '变量输出格式:\n  format: &shared |\n    ' + format + '\n  hint: *shared';
    assert.strictEqual(migration.plan(text, { outputOnly: true }).text, text);
    const data = '变量输出格式:\n  business_data:\n    format: |\n      ' + format;
    assert.strictEqual(migration.plan(data, { outputOnly: true }).text, data);
});
test('统一填表适配：原执行失败交回调用方，重试重新执行且无结果缓存', async () => {
    const r = run('业务原文'), text = request(r); let attempts = 0;
    const ejs = { prepareContext: async () => ({}), evalTemplate: async code => { attempts++; if (attempts === 1) throw new Error('author execution failed'); return code; } };
    createEjsEvalBridge({ readCharacter: () => r.card, readCore: () => core, makeDefines: () => ({}) }).install(ejs);
    await assert.rejects(ejs.evalTemplate(text), /author execution failed/);
    assert((await ejs.evalTemplate(text)).includes(core.fillAdaptationGuidance())); assert.strictEqual(attempts, 2);
});

test('统一填表适配：业务分析中提及旧标签原样保留，不当作输出外壳删除', () => {
    const business = '若物品名是 <JSONPatch> 或 <UpdateVariable>，保留此字符串';
    const text = '变量输出格式:\n  format: |-\n    <UpdateVariable><Analysis>' + business + '</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>';
    const r = run(text, entry(text, '[mvu_update]变量输出格式'));
    const view = core.prepareFillPrompt(request(r), r.card).text;
    assert(view.includes(business)); assert(!view.includes('<JSONPatch>[]</JSONPatch>'));
});

test('统一填表适配：宿主重建条目丢失扩展字段时，转换元数据仍提供请求视图', () => {
    const r = run(output(), entry(output(), '[mvu_update]变量输出格式'));
    const normalized = JSON.parse(JSON.stringify(r.card));
    for (const [index, item] of normalized.character_book.entries.entries()) { delete item.extensions; item.id = index; }
    const view = core.prepareFillPrompt(request({ card: normalized }), normalized);
    assert(view.adapted && !view.text.includes(format));
    assert.strictEqual(normalized.character_book.entries.find(e=>e.content===output()).content, output());
});
test('统一填表适配：真实有效指针不能仅因形似示例路径被排除', () => {
    const text = output().replace('[]', '[{"op":"replace","path":"/path/to/variable","value":3.75}]');
    assert.strictEqual(migration.plan(text, { outputOnly: true }).text, text);
});
test('统一填表适配：纯格式字段后的业务注释保持原文', () => {
    const text = '变量输出格式:\n  format: "' + format + '" # 冻结时禁止修改评分\n  hint: 原要求';
    const r = run(text, entry(text, '[mvu_update]变量输出格式'));
    assert(core.prepareFillPrompt(request(r), r.card).text.includes('# 冻结时禁止修改评分'));
});
test('统一填表适配：纯协议规则的行内与嵌套业务注释保留', () => {
    const scalar = '变量输出格式:\n  rule:\n    - 更新推理仅放<Analysis>，变量操作仅放<JSONPatch> # 冻结时金币保持不变\n  format: "' + format + '"';
    const nested = '变量输出格式:\n  rule:\n    - 更新指令=JSON Patch(RFC6902)数组 支持操作:\n        - remove # 禁止删除冻结记录\n  format: "' + format + '"';
    for (const text of [scalar, nested]) {
        const r = run(text, entry(text, '[mvu_update]变量输出格式'));
        const view = core.prepareFillPrompt(request(r), r.card).text;
        assert(view.includes(text.includes('金币') ? '# 冻结时金币保持不变' : '# 禁止删除冻结记录'));
        assert(!view.includes(format));
    }
});
test('EJS变量getter：选项对象没有defaults时缺失字段仍为undefined', () => {
    let state = { stat_data: { zero: 0, disabled: false, empty: null } };
    const read = createEjsEvalBridge({}).createMessageGetter(() => state);
    assert.strictEqual(read('stat_data.missing', { noCache: true }), undefined);
    assert.strictEqual(read('stat_data.missing', { defaults: 0 }), 0);
    assert.strictEqual(read('stat_data.missing', { defaults: false }), false);
    assert.strictEqual(read('stat_data.missing', { defaults: undefined }), undefined);
    assert.strictEqual(read('stat_data.missing.child', { noCache: true }), undefined);
    assert.strictEqual(read('stat_data.zero', { defaults: 99 }), 0);
    assert.strictEqual(read('stat_data.disabled', { defaults: true }), false);
    assert.strictEqual(read('stat_data.empty', { defaults: 'fallback' }), null);
    assert.strictEqual(read('stat_data.missing', 'unrecognized'), undefined);
    state = { stat_data: { missing: 3.75 } };
    assert.strictEqual(read('stat_data.missing', { noCache: true }), 3.75);
});
test('EJS变量getter：运行时共用工厂内联不依赖Node外部作用域', () => {
    const factory = vm.runInNewContext('(' + createEjsEvalBridge.toString() + ')');
    const getter = factory({ lodash: require('../src/vendor/schema-engine-libs').lodash }).createMessageGetter(() => ({ stat_data: { zero: 0 } }));
    assert.strictEqual(getter('stat_data.missing', { noCache: true }), undefined);
    assert.strictEqual(getter('stat_data.missing', { defaults: '原默认' }), '原默认');
    assert.strictEqual(getter('stat_data.zero', { defaults: 99 }), 0);
});
test('EJS代码边界：正文单引号不遮蔽后续读取，普通示例保持原文', () => {
    const prose = "作者的 player's 状态说明；示例 getvar('stat_data.进程.评分')。\n";
    const script = "<%_ if (getvar('stat_data.进程.评分') > 2) { _%>通过<% } %>";
    const r = run(prose + script);
    assert.strictEqual(sourceEntry(r).content, prose + script);
});
test('EJS变量路径：读写数组下标、带点键和空键，不破坏已有数组', () => {
    const lodash = require('../src/vendor/schema-engine-libs').lodash;
    const factory = vm.runInNewContext('(' + createEjsEvalBridge.toString() + ')');
    const bridge = factory({ lodash, pathParts: (path, data) => Object.hasOwn(data, path) ? [path] : lodash.toPath(path) });
    let state = { stat_data: { items: [{ score: 2.5 }, { score: 4 }], 'a.b': { '': 7 } } };
    const read = bridge.createMessageGetter(() => state);
    const write = bridge.createMessageSetter(() => state, next => { state = { stat_data: next }; });
    assert.strictEqual(read('stat_data.items[0].score'), 2.5);
    assert.strictEqual(write('stat_data.items[0].score', 3.75), 3.75);
    assert(Array.isArray(state.stat_data.items));
    assert.strictEqual(state.stat_data.items[1].score, 4);
    assert.strictEqual(read('stat_data.items[0].score'), 3.75);
    assert.strictEqual(read('stat_data["a.b"][""]'), 7);
    write('stat_data["a.b"][""]', 8);
    assert.strictEqual(read('stat_data["a.b"][""]'), 8);
    write('stat_data.newItems[0].score', 1.25);
    assert(Array.isArray(state.stat_data.newItems));
    assert.strictEqual(read('stat_data.newItems[0].score'), 1.25);
    const before = JSON.stringify(state);
    assert.throws(() => write('stat_data.__proto__.polluted', true), error => error.code === 'MVU_VARIABLE_PATH_UNSAFE');
    assert.strictEqual(JSON.stringify(state), before);
    assert.strictEqual({}.polluted, undefined);
});
test('EJS变量路径：静态下标路径转接，拼接表达式不能误判为字面量', () => {
    const text = `<% setMessageVar('stat_data["items"][0].score', 3.75); %><%= getvar('stat_data["a.b"][""]') %>`;
    const out = core.rewriteEjsConditions(text, { entries: [] }, core.createReport());
    assert.strictEqual(out.text, text);
    const dynamic = `<%= getvar('stat_data.' + '进程.评分') %>`;
    assert.strictEqual(core.rewriteEjsConditions(dynamic, { entries: [] }, core.createReport()).text, dynamic);
});
test('EJS代码边界：注释、转义标签、字符串和对象方法中的示例不改写', () => {
    const examples = [
        "<%# getvar('stat_data.进程.评分') %>",
        "<%%= getvar('stat_data.进程.评分') %>",
        '<% const example = "getvar(\'stat_data.进程.评分\')"; obj.getvar(\'stat_data.进程.评分\'); %>',
    ].join('\n');
    const script = "<%= getvar('stat_data.进程.评分', { defaults: 0 }) -%>";
    const out = core.rewriteEjsConditions(examples + '\n' + script, { entries: [] }, core.createReport());
    assert.strictEqual(out.text, examples + '\n' + script);
    assert.strictEqual(out.items.length, 0);
    const onlyExamples = core.rewriteEjsConditions(examples, { entries: [] }, core.createReport());
    assert.strictEqual(onlyExamples.text, examples);
    assert.strictEqual(onlyExamples.items.length, 0);
});

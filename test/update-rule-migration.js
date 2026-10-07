'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const factory = require('../src/update-rule-migration');
const libs = require('../src/vendor/schema-engine-libs');
const filterFactory = require('../src/extension-runtime').createWorldbookRequestFilter;
const initial = { 进程: { 阶段: '创角阶段', 评分: 2.5, 就绪: false } };
const entry = content => ({ id: 7, comment: '战斗流程', content, keys: ['BOSS'], enabled: false,
    constant: false, selective: true, insertion_order: 123, extensions: { position: 4, depth: 2 } });
function run(content, source = entry(content)) {
    return core.convert({ name: '公开整段迁移', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: JSON.stringify(initial) }, source,
    ] } });
}
const fillEntry = r => r.card.character_book.entries.find(e => /\[M2SJK\]/i.test(e.comment));
const bodyEntry = r => r.card.character_book.entries.find(e => e.comment === '战斗流程');
const source = 'step:\n  when: BOSS现身且本回合结束\n  instruction: 你务必在 <JSONPatch> 中把 /进程/阶段 改到 战斗准备；其他条件不变\n  narrative: 保持现场描写';

test('整段更新迁移：M2SJK保留安全原名，受宿主过滤的原名仅留报告', () => {
    const safe = run(source), fill = fillEntry(safe);
    assert.strictEqual(fill.comment, '[M2SJK]战斗流程（更新要求）');
    for (const name of ['变量更新规则', '状态核对', 'MVU事件', 'Rule check', '格式说明']) {
        const r = run(source, { ...entry(source), comment: name }), target = fillEntry(r);
        assert.strictEqual(target.comment, `[M2SJK]更新要求（${target.id}）`);
        assert(r.reportText.includes(name), '报告保留完整原名称');
        assert(r.card.character_book.entries.some(e => e.comment === name), '混合条目正文保留原名称');
    }
});
test('整段更新迁移：旧更新专用条目兼容新标题，共享与状态展示不改名', () => {
    const name = '[mvu_update]变量更新规则';
    const r = run('未能静态绑定的附加业务说明。', { ...entry('未能静态绑定的附加业务说明。'), comment: name });
    const target = fillEntry(r);
    assert(target); assert.strictEqual(target.content, '未能静态绑定的附加业务说明。');
    assert(r.reportText.includes(name));
    for (const comment of ['[mvu_plot][mvu_update]状态展示', '状态展示']) {
        const content = '<status_current_variable>当前展示</status_current_variable>';
        const shared = run(content, { ...entry(content), comment });
        assert(shared.card.character_book.entries.some(e => e.comment === comment && e.content === content));
        assert(!fillEntry(shared));
    }
});

test('整段更新迁移：不解析自然语言句式，条件和未知续句完整保留', () => {
    const r = run(source), fill = fillEntry(r), body = bodyEntry(r);
    assert(fill && body);
    assert.match(fill.content, /你务必在 本次数据库填表 中把 「进程表」的「阶段」 改到 战斗准备；其他条件不变/);
    assert.match(fill.content, /when: BOSS现身且本回合结束/);
    assert.match(body.content, /narrative: 保持现场描写/);
    assert.doesNotMatch(fill.content, /narrative: 保持现场描写/);
    assert.doesNotMatch(body.content, /instruction:|JSONPatch/);
    assert.doesNotMatch(fill.content, /JSONPatch/);
    assert.match(fill.content, /操作列表不作为输出格式/);
});
test('整段更新迁移：触发设置不变、ID唯一、规则不重复写入表格说明', () => {
    const r = run(source), fill = fillEntry(r);
    for (const key of ['keys', 'enabled', 'constant', 'selective', 'insertion_order', 'extensions'])
        assert.deepStrictEqual(fill[key], entry('')[key]);
    const ids = r.card.character_book.entries.map(e => e.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert(!Object.values(r.template).some(t => (t.sourceData?.note || '').includes('你务必')));
    assert.match(r.reportText, /不重复写入表格说明/);
});
test('整段更新迁移：正文事件屏蔽填表条目，原列表仍保留完整要求', () => {
    const r = run(source), list = [bodyEntry(r), fillEntry(r)].map(e => ({ ...e, world: '当前书' }));
    const request = { characterLore: list.slice() }, card = { data: { extensions: { world: '当前书', mvu2shujuku: { converter: 'mvu2shujuku' } } } };
    filterFactory({ readCharacter: () => card }).filter(request);
    assert.deepStrictEqual(request.characterLore.map(e => e.comment), ['战斗流程']);
    assert.strictEqual(list.length, 2); assert.match(list[1].content, /数据库填表协议/);
});
test('整段更新迁移：已标记的规则原地转换，不复制第二份', () => {
    const text = 'update_instructions:\n  when: BOSS现身且本回合结束\n  instruction: 使用 <JSONPatch> 更新 /进程/阶段';
    const r = run(text, { ...entry(text), comment: '[mvu_update]战斗流程' });
    const rules = r.card.character_book.entries.filter(e=>e.comment.includes('战斗流程'));
    assert.strictEqual(rules.length, 1); assert.doesNotMatch(rules[0].content, /JSONPatch/);
    assert.match(rules[0].content, /when: BOSS现身且本回合结束/);
});
test('整段更新迁移：完整操作数组保留add、remove、replace含义与小数值', () => {
    const ops = [{ op: 'replace', path: '/进程/评分', value: 3.75 },
        { op: 'add', path: '/进程/阶段', value: '战斗准备' }, { op: 'remove', path: '/进程/就绪' }];
    const text = 'step:\n  trigger: 战斗结束\n  mandatory_patch: '+JSON.stringify(ops)+'\n  narrative: 保留现场描写';
    const r = run(text);
    assert(fillEntry(r)); assert(fillEntry(r).content.includes(JSON.stringify(ops)));
    assert.match(fillEntry(r).content, /更新目标对应:.*\/进程\/评分 → 「进程表」的「评分」/);
    assert.doesNotMatch(bodyEntry(r).content, /mandatory_patch|3\.75/);
});
test('整段更新迁移：不能绑定的操作使整个数组保留，不抽走已知操作', () => {
    const text = 'step:\n  mandatory_patch: [{"op":"replace","path":"/进程/阶段","value":"战斗准备"},{"op":"remove","path":"/不存在/字段"}]';
    const r = run(text); assert(!fillEntry(r)); assert.strictEqual(bodyEntry(r).content, text);
    assert.match(r.reportText, /整段保留/);
});
test('整段更新迁移：操作值里的协议同名数据不被替换', () => {
    const text = 'mandatory_patch: [{"op":"replace","path":"/进程/阶段","value":"JSONPatch"}]';
    const r = run(text);
    assert.match(fillEntry(r).content, /"value":"JSONPatch"/);
    assert(!r.reportText.includes('迁移结果仍含未承接协议引用'));
});
test('整段更新迁移：EJS控制结构和变量依赖在两个视图都保留', () => {
    const text = '<% const stat=getvar("stat_data"); if (stat.进程.阶段 === "创角阶段") { %>\nstep:\n  instruction: 在 <JSONPatch> 中更新 /进程/阶段 为 <%= stat.进程.阶段 %>\n  narrative: 正文显示 <%= stat.进程.评分 %>\n<% } %>';
    const r = run(text), body = bodyEntry(r).content, fill = fillEntry(r).content;
    for (const output of [body, fill]) {
        assert.match(output, /const stat=mvu2shujukuGetAllVariables\(\).stat_data/);
        assert.match(output, /if \(stat.进程.阶段 === "创角阶段"\)/);
        assert.match(output, /<% } %>/);
    }
    assert.match(body, /void \( stat.进程.阶段 \)/);
    assert.match(fill, /<%= stat.进程.阶段 %>/);
    assert.match(body, /正文显示 <%= stat.进程.评分 %>/);
});
test('整段更新迁移：EJS外部写入、异步和未知调用保留并报告', () => {
    for (const code of ['setvar("x",1);', 'await fetch("https://example.test");', 'someUnknownHelper();', 'stat.进程.阶段="战斗准备";',
        'delete stat.进程.阶段;', 'const host=window; host.slice();',
        'function probe(host) { return host.slice(); } host.slice();',
        'let reader=()=>1; reader=setvar; reader("x",1);']) {
        const text = '<% const stat=getvar("stat_data"); '+code+' %>\ninstruction: 在 <JSONPatch> 中更新 /进程/阶段';
        const r = run(text); assert(!fillEntry(r));
        assert.match(r.reportText, /迁移未完成/);
        // The existing read rewrite still runs; migration does not remove code.
        assert(bodyEntry(r).content.includes(code));
    }
});
test('整段更新迁移：独立status展示保留在正文，不随更新段落屏蔽', () => {
    const text = '<status_current_variable>当前状态</status_current_variable>\nstep:\n  instruction: 在 <JSONPatch> 中更新 /进程/阶段';
    const r = run(text); assert.match(bodyEntry(r).content, /<status_current_variable>当前状态/);
    assert.doesNotMatch(fillEntry(r).content, /当前状态/);
});
test('整段更新迁移：未绑定的同级更新字段不能作为条件被复制到填表', () => {
    const r = run('step:\n  when: 敌人出现时\n  instruction: 在 <JSONPatch> 中更新 /进程/阶段\n  checks: 在 <JSONPatch> 中更新 /未知/阶段\n  narrative: 保留正文');
    assert.match(bodyEntry(r).content, /\/未知\/阶段/);
    assert.doesNotMatch(fillEntry(r).content, /\/未知\/阶段|checks:/);
    assert.match(fillEntry(r).content, /敌人出现时/);
    assert.match(r.reportText, /迁移未完成/);
});
test('整段更新迁移：示例、剧情标记和纯名称提及不作为协议迁移', () => {
    for (const text of ['example:\n  instruction: 在 <JSONPatch> 中更新 /进程/阶段', '台词: 不得把 JSONPatch 阵营的物品移出仓库']) {
        const r = run(text); assert(!fillEntry(r)); assert.strictEqual(bodyEntry(r).content, text);
    }
    const r = run(source, { ...entry(source), comment: '[mvu_plot]剧情' });
    assert(!fillEntry(r)); assert.strictEqual(r.card.character_book.entries.find(e=>e.comment==='[mvu_plot]剧情').content, source);
});
test('整段更新迁移：跨段协议标签和无法确定的格式不会只搬走一半', () => {
    const text = 'variables_update_format:\n  format: |-\n    库存不得低于零\n    <UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>';
    const r = run(text, { ...entry(text), comment: '变量输出规则' });
    assert(!fillEntry(r)); assert.strictEqual(r.card.character_book.entries.find(e=>e.comment==='变量输出规则').content, text);
    assert.match(r.reportText, /边界交叉/);
});
test('整段更新迁移：工厂在无Node外部作用域的VM中与产品调用一致', () => {
    const resolvePath = path => path.join('/') === '进程/阶段' ? { label: '「进程表」的「阶段」' } : null;
    const direct = factory({ parseJs: libs.acorn.parse }).migrate(source, { resolvePath });
    const inline = vm.runInNewContext('('+factory.toString()+')')({ parseJs: libs.acorn.parse }).migrate(source, { resolvePath });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(inline)), direct);
    assert(run(source).card.character_book.entries.some(e=>e.content===direct.fill));
});
test('整段更新迁移：旧表格check原地处理协议引用，不复制世界书规则', () => {
    const rule = '当任务链明确时，同一 JSONPatch 必须更新阶段；奖励条件不变';
    const content = '变量更新规则:\n  进程:\n    阶段:\n      check: '+JSON.stringify(rule);
    const r = run(content, { ...entry(content), comment: '[mvu_update]变量更新规则' });
    const note = Object.values(r.template).find(t=>t.name==='进程表').sourceData.note;
    assert.doesNotMatch(note, /JSONPatch/); assert.match(note, /奖励条件不变/);
    assert.match(note, /业务更新要求（实际输出遵循数据库填表协议）/);
    assert(!r.card.character_book.entries.some(e=>e.comment.includes('变量更新规则')));
});
test('整段更新迁移：不能拆开YAML共享节点定义与引用', () => {
    const text = 'step:\n  instruction: &shared 在 <JSONPatch> 中更新 /进程/阶段\nother: *shared';
    const r = run(text); assert(!fillEntry(r)); assert.strictEqual(bodyEntry(r).content, text);
    assert.match(r.reportText, /共享节点/);
});
test('整段更新迁移：完整JSON记录的内部路径绑定到该记录的JSON列', () => {
    const content = 'instruction: 在 <JSONPatch> 中更新 /红颜/{角色名}/好感度';
    const r = core.convert({ name: '公开JSON记录规则', character_book: { entries: [
        { comment: '[InitVar]', content: '{红颜:{甲:{好感度:2}}}' }, entry(content),
    ] }, extensions: { tavern_helper: { scripts: [{ name: '结构', enabled: true,
        content: 'import {registerMvuSchema} from "https://example.test/mvu_zod.js";registerMvuSchema(z.object({红颜:z.record(z.string(),z.unknown())}));' }] } } });
    const fill = fillEntry(r); assert(fill);
    assert.match(fill.content, /「红颜表」的对应记录的「内容」内部路径 \/好感度/);
    assert.doesNotMatch(fill.content, /JSONPatch/);
});
test('整段更新迁移：数组及其协议要求一起分流，不留下正文协议指令', () => {
    const text = 'step:\n  when: 本回合结束\n  instruction: 必须在 JSONPatch 中完成下列变更\n  mandatory_patch: [{"op":"replace","path":"/进程/阶段","value":"战斗准备"}]\n  narrative: 保留剧情';
    const r = run(text); assert(fillEntry(r));
    assert.doesNotMatch(bodyEntry(r).content, /JSONPatch|instruction:|mandatory_patch/);
    assert.match(fillEntry(r).content, /完成下列变更/);
    assert.match(fillEntry(r).content, /"value":"战斗准备"/);
});
test('整段更新迁移：相关数组无法绑定时，指令和整组操作一起保留', () => {
    const text = 'step:\n  instruction: 必须在 <JSONPatch> 中更新 /进程/阶段\n  mandatory_patch: [{"op":"remove","path":"/不存在/字段"}]';
    const r = run(text); assert(!fillEntry(r)); assert.strictEqual(bodyEntry(r).content, text);
});

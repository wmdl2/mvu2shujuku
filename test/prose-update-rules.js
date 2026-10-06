'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function convert(rule, init = { 世界: { 时间: '', 冻结: false }, 任务: { 当前: [] }, 名字: '' }, enabled = true) {
    return core.convert({ name: '公开散文规则测试', first_mes: '', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: JSON.stringify(init), enabled: false },
        { id: 2, comment: '[mvu_update]通用规则', content: rule, enabled },
        { id: 3, comment: '名字读取处', content: '人物名：{{getvar::名字}}', enabled: true },
    ] } });
}
function sheet(r, name) { return Object.values(r.template).find(s => s && s.name === name); }
function retained(r) { return (r.card.data || r.card).character_book.entries.find(e => e.id === 2); }

test('散文规则：XML 包裹与自然语言续行完整迁移，宏迁移后仍有凭证', () => {
    const r = convert('<UpdateRules>\n通用更新规则:\n  世界:\n    - 行动/任务推进后 replace /世界/时间，{{user}}可主动推进。\n（冻结时禁止推进时间）\n    - replace /世界/冻结 为false，仅按正文判定\n</UpdateRules>');
    assert.strictEqual(retained(r), undefined);
    const note = sheet(r, '世界表').sourceData.note;
    assert.match(note, /冻结时禁止推进时间/);
    assert.match(note, /行动\/任务推进后 更新 「时间」/);
    assert.match(note, /mvu2shujukuResolveMacro\("user"\)/);
    assert.doesNotMatch(note, /原变量路径|\/世界\/时间|\/世界\/冻结/);
    assert.doesNotMatch(note, /replace \/世界/);
});
test('散文规则：组标题不同但显式路径唯一时按实际路径迁移', () => {
    const r = convert('通用更新规则:\n  支线:\n    - 场景结束时 add /任务/当前/- 新记录，保留旧记录');
    assert.strictEqual(retained(r), undefined);
    const s = Object.values(r.template).find(s => /任务.*当前/.test(s?.name));
    assert.match(s.sourceData.note, /场景结束时 新增 本表的新记录/);
});
test('散文规则：没有操作路径时只接受准确的组标题', () => {
    const r = convert('世界:\n  - 冻结期间保持原时间\n不省略这条续行');
    assert.strictEqual(retained(r), undefined);
    assert.match(sheet(r, '世界表').sourceData.note, /不省略这条续行/);
});
test('散文规则：整组 JSON 的业务条件位于实际可写路径范围内', () => {
    const r = convert('自由:\n  - add /自由/甲/值 为正文明确的数字', { 自由: {} });
    const note = sheet(r, '自由表').sourceData.note;
    assert.strictEqual(retained(r), undefined);
    assert(note.indexOf('【可写路径与约束】') < note.indexOf('新增 「内容」内部路径 /甲/值'));
    assert.match(note, /未列出的字段一律只读/);
    assert.doesNotMatch(note, /【可写路径与约束】\n【更新守卫】/);
});
test('散文规则：未知组完整保留，已迁移部分按实际说明拆分', () => {
    const r = convert('<UpdateRules>\n通用更新规则:\n  世界:\n    - replace /世界/时间 为当前时间\n  未知:\n    - replace /未知/状态 为已发生\n</UpdateRules>');
    assert.ok(retained(r)); assert.match(retained(r).content, /未知\/状态/);
    assert.doesNotMatch(retained(r).content, /世界\/时间/);
    assert.match(r.reportText, /剩余内容未迁入填表侧/);
});
test('散文规则：禁用条目和动态 EJS 不能变为启用的模板规则', () => {
    const text = '<UpdateRules>\n世界:\n  - 必须每轮倒退时间\n</UpdateRules>';
    const r = convert(text, undefined, false);
    assert.ok(retained(r)); assert.doesNotMatch(sheet(r, '世界表').sourceData.note, /必须每轮倒退时间/);
    const dynamic = convert('<UpdateRules>\n世界:\n  - <% if (active) { %>replace /世界/时间 为零<% } %>\n</UpdateRules>');
    assert.ok(retained(dynamic));
});
test('结构化规则：XML 与代码围栏中的 YAML 使用同一解析和迁移路径', () => {
    const body = '变量更新规则:\n  世界:\n    时间:\n      type: string\n      check:\n        - 冻结期间禁止变化';
    const direct = convert(body), wrapped = convert('<UpdateRules>\n```yaml\n' + body + '\n```\n</UpdateRules>');
    assert.deepStrictEqual(wrapped.template, direct.template);
    assert.strictEqual(retained(wrapped), undefined);
});
test('规则包裹：完整静态自定义标签与常见围栏可嵌套，类型和说明不丢失', () => {
    const body = '变量更新规则:\n  世界:\n    时间:\n      type: string\n      check:\n        - 只按当前场景推进';
    const expected = convert(body).template;
    for (const [open, close] of [['<custom-rule_pack>', '</custom-rule_pack>'], ['<变量规则>', '</变量规则>'], ['~~~yml', '~~~'], ['````yaml', '````'], ['```', '```']]) {
        const r = convert(open + '\n' + body + '\n' + close);
        assert.deepStrictEqual(r.template, expected, open);
        assert.strictEqual(retained(r), undefined, open);
    }
    const nested = convert('<Rules>\n<custom_rules>\n```yaml\n' + body + '\n```\n</custom_rules>\n</Rules>');
    assert.deepStrictEqual(nested.template, expected);
    assert.strictEqual(retained(nested), undefined);
    const indented = convert('<Rules>\r\n    ```yaml\r\n' + body.split('\n').map(line => '        ' + line).join('\r\n') + '\r\n    ```\r\n</Rules>');
    assert.deepStrictEqual(indented.template, expected);
    assert.strictEqual(retained(indented), undefined);
    const json = convert('<Rules>\n```json\n' + JSON.stringify({ 变量更新规则: { 世界: { 时间: { type: 'string', check: ['只按当前场景推进'] } } } }) + '\n```\n</Rules>');
    assert.deepStrictEqual(json.template, expected);
    assert.strictEqual(retained(json), undefined);
});
test('规则包裹：属性、相邻标签、脚本和混合正文不被当作完整规则删除', () => {
    const body = '变量更新规则:\n  世界:\n    时间:\n      check:\n        - 仅按正文推进';
    for (const text of ['前言有业务限制\n<Rules>\n' + body + '\n</Rules>', '<Rules enabled="dynamic">\n' + body + '\n</Rules>', '<Rules>\n' + body + '\n</Rules>\n<Rules>别的限制</Rules>', '<script>\n' + body + '\n</script>']) {
        assert.ok(retained(convert(text)), text.slice(0, 30));
    }
});
function pathFormat(lines) {
    return '<Format>\n变量输出格式:\n  valid_paths: |-\n' + lines.map(s => '    ' + s).join('\n') + '\n  format: |-\n    <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>\n</Format>';
}
test('输出格式：字段业务定义、只读权限与通配根不得随旧协议删除', () => {
    const r = convert(pathFormat(['/名字 readonly(前端管理，显示人物姓名)', '/世界/冻结 readonly(玩家开关)', '/世界/时间 replace:string 仅按正文时间', '/actor_* readonly(前端管理，线路主角模式)']),
        { 名字: '', 世界: { 时间: '', 冻结: false }, actor_a: '', actor_b: '' });
    assert.strictEqual(retained(r), undefined);
    for (const name of ['actor_a表', 'actor_b表', '名字表']) {
        assert.match(sheet(r, name).sourceData.note, /模型只读/);
        assert.match(sheet(r, name).sourceData.updateNode, /禁止/);
        assert.doesNotMatch(sheet(r, name).sourceData.note, /UpdateVariable|JSONPatch/);
    }
    assert.match(sheet(r, '名字表').sourceData.note, /显示人物姓名/);
    assert.match(sheet(r, '世界表').sourceData.note, /模型只读字段：冻结/);
    assert.doesNotMatch(sheet(r, '世界表').sourceData.updateNode, /dongjie|冻结/);
});
test('输出格式：未知业务路径保留说明而不恢复旧输出协议', () => {
    const r = convert(pathFormat(['/世界/时间 replace:string 当前时刻', '/未映射/值 replace:string 特定条件']));
    assert.ok(retained(r)); assert.match(retained(r).content, /未映射\/值/);
    assert.doesNotMatch(retained(r).content, /UpdateVariable|JSONPatch/);
    assert.match(sheet(r, '世界表').sourceData.note, /当前时刻/);
});
test('输出格式：任意自定义键保留，不能套用已知路径字段的含义', () => {
    const r = convert(pathFormat(['/名字 readonly(人物姓名)']).replace('valid_paths:', 'author_custom_policy:'));
    assert.match(retained(r).content, /author_custom_policy/);
    assert.match(retained(r).content, /\/名字 readonly\(人物姓名\)/);
    assert.doesNotMatch(retained(r).content, /<UpdateVariable>|<JSONPatch>/);
    assert.doesNotMatch(sheet(r, '名字表').sourceData.note, /本表为模型只读状态/);
    assert.match(r.reportText, /未迁入填表侧/);
});
test('输出格式：已知路径迁移不能吞掉同文档的未知补充键', () => {
    const content = pathFormat(['/名字 readonly(姓名显示)']).replace('  format:', '  author_note: 不得忘记尚未结算的约定\n  format:');
    const r = convert(content);
    assert.match(sheet(r, '名字表').sourceData.note, /姓名显示/);
    assert.match(retained(r).content, /author_note: 不得忘记尚未结算的约定/);
    assert.doesNotMatch(retained(r).content, /\/名字|<UpdateVariable>|<JSONPatch>/);
});
test('输出格式：无法解析的路径说明仍保留，不能静默随协议删除', () => {
    const r = convert(pathFormat(['这段是业务说明，尚未使用完整路径。']));
    assert.ok(retained(r)); assert.match(retained(r).content, /这段是业务说明/);
    assert.doesNotMatch(retained(r).content, /UpdateVariable|JSONPatch/);
});
test('原变量说明：下划线根为模型只读，显式整数说明不得接受小数', () => {
    const card = { name: '公开元数据说明测试', character_book: { entries: [{ id: 1, comment: '[InitVar]', content: '{"_schema_version":2}' }] },
        extensions: { tavern_helper: { scripts: [{ name: '结构迁移', enabled: true,
            content: "import { registerMvuSchema } from 'https://example.test/mvu_zod.js';const S=z.object({_schema_version:z.number().int()});registerMvuSchema(S);" }] } } };
    const r = core.convert(card), s = sheet(r, '_schema_version表');
    assert.match(s.sourceData.note, /本表为模型只读状态/);
    assert.strictEqual(s.updateConfig.updateFrequency, 0);
    assert.doesNotMatch(s.sourceData.note, /原变量路径|结构迁移/);
    assert.match(s.sourceData.note, /一个整数，不接受小数/);
    assert.match(s.sourceData.updateNode, /禁止/);
});
test('普通表说明：不再默认添加原路径、类型与世界书引用清单', () => {
    const r = convert('世界:\n  - 冻结期间保持原时间');
    assert.doesNotMatch(sheet(r, '名字表').sourceData.note, /原变量路径|原卡顶层|名字读取处/);
    assert.strictEqual(core.statDataFromTables(JSON.parse((r.card.data || r.card).extensions.mvu2shujuku.layout), r.template).stat_data.名字, '');
});

test('只读声明：完整肯定语法才关闭自动更新，复杂说明迁移但不推导权限', () => {
    for (const declaration of ['readonly', 'readonly(前端管理)', '只读（作者脚本维护）']) {
        const r = convert(pathFormat(['/名字 ' + declaration]));
        assert.strictEqual(sheet(r, '名字表').updateConfig.updateFrequency, 0, declaration);
        assert.match(sheet(r, '名字表').sourceData.updateNode, /禁止/);
        assert.strictEqual(retained(r), undefined);
    }
    for (const declaration of ['readonly(false)', 'readonly: false', 'readonly = true', 'readonly(0)',
        'readonly(enabled)', 'readonly(count > 0)', 'readonly(a && b)', '只读（当玩家打开开关时）',
        'readonly(仅在开局时)', 'readonly(如果剧情尚未开始)', 'readonly(前端管理) 但允许模型更新',
        'readonly(前端管理)\n      仅在玩家关闭开关时生效', '并非只读', '只读（允许修改）']) {
        const r = convert(pathFormat(['/名字 ' + declaration]));
        assert.notStrictEqual(sheet(r, '名字表').updateConfig.updateFrequency, 0, declaration);
        assert.doesNotMatch(sheet(r, '名字表').sourceData.note, /本表为模型只读状态/);
        assert.strictEqual(retained(r), undefined, declaration);
        for (const line of declaration.split('\n')) assert.ok(sheet(r, '名字表').sourceData.note.includes(line.trim()), declaration);
        assert.match(r.reportText, /未据此自动设置只读或更新频率/);
    }
});

test('只读作用域：通配根仅匹配同层名称，字段只读不关闭整表调度', () => {
    const r = convert(pathFormat(['/actor_* readonly(前端管理)', '/世界/冻结 readonly(玩家开关)']),
        { actor_a: '', actor_b: '', actor: '', actorish: '', 世界: { 时间: '', 冻结: false } });
    for (const name of ['actor_a表', 'actor_b表']) assert.strictEqual(sheet(r, name).updateConfig.updateFrequency, 0);
    for (const name of ['actor表', 'actorish表', '世界表']) assert.notStrictEqual(sheet(r, name).updateConfig.updateFrequency, 0);
    assert.match(sheet(r, '世界表').sourceData.note, /模型只读字段：冻结/);
});

test('只读频率：单例全部业务列明确只读时关闭自动更新，行表不扩大权限', () => {
    const r = convert(pathFormat(['/世界/时间 readonly(脚本维护)', '/世界/冻结 readonly(玩家开关)',
        '/成员/{全名}/值 readonly(脚本维护)']), { 世界: { 时间: '', 冻结: false }, 成员: { 甲: { 值: 1 } } });
    assert.strictEqual(sheet(r, '世界表').updateConfig.updateFrequency, 0);
    assert.notStrictEqual(sheet(r, '成员表').updateConfig.updateFrequency, 0);
});

test('字段规则：普通列使用实际列名，不重复原路径和类型', () => {
    const r = convert(pathFormat(['/世界/时间 replace:string 正文明确推进时更新', '/世界/冻结 readonly(玩家开关)']));
    const note = sheet(r, '世界表').sourceData.note;
    assert.match(note, /「时间」：正文明确推进时更新/);
    assert.match(note, /「冻结」：玩家开关/);
    assert.doesNotMatch(note, /\/世界|replace:string|原变量路径|原卡字段定义/);
    assert.notStrictEqual(sheet(r, '世界表').updateConfig.updateFrequency, 0);
});

test('JSON 字段规则：相对内容列定位，叶子只读不能锁整个 JSON', () => {
    const r = convert(pathFormat(['/自由/支线/已发现 replace:boolean 正文确认发现后更新',
        '/自由/主线/阶段 readonly(脚本维护)']), { 自由: {} });
    const note = sheet(r, '自由表').sourceData.note;
    assert.match(note, /「内容」内部路径 \/支线\/已发现：boolean 正文确认发现后更新/);
    assert.match(note, /「内容」内部路径 \/主线\/阶段：模型只读；脚本维护/);
    assert.doesNotMatch(note, /\/自由|原变量路径/);
    assert.notStrictEqual(sheet(r, '自由表').updateConfig.updateFrequency, 0);
    assert.strictEqual(retained(r), undefined);
});

test('字段规则：已拆列中的未知叶子保留报告，不能自动开放整个表', () => {
    const r = convert(pathFormat(['/世界/不存在 replace:string 新值']));
    assert.ok(retained(r));
    assert.match(retained(r).content, /世界\/不存在/);
    assert.doesNotMatch(sheet(r, '世界表').sourceData.note, /不存在/);
});

test('行表规则：占位记录名映射实际列，具体记录的只读不扩大到全部记录', () => {
    const r = convert(pathFormat(['/成员/{全名}/值 replace:number(0~100) 明确变化后更新',
        '/成员/甲/备注 readonly(脚本维护)']), { 成员: { 甲: { 值: 1, 备注: '' } } });
    const s = sheet(r, '成员表');
    assert.match(s.sourceData.note, /「值」：业务数值范围：0~100； 明确变化后更新/);
    assert.match(s.sourceData.note, /记录「甲」的「备注」：模型只读；脚本维护/);
    assert.doesNotMatch(s.sourceData.note, /\/成员|number\(0~100\)|模型只读字段：备注/);
    assert.notStrictEqual(s.updateConfig.updateFrequency, 0);
    assert.strictEqual(retained(r), undefined);
});

test('只读冲突：父只读与子可写声明不能自动禁用整表', () => {
    const r = convert(pathFormat(['/世界 readonly(脚本维护)', '/世界/时间 replace:string 剧情推进后更新']));
    assert.notStrictEqual(sheet(r, '世界表').updateConfig.updateFrequency, 0);
    assert.doesNotMatch(sheet(r, '世界表').sourceData.note, /本表为模型只读状态/);
    assert.ok(retained(r));
    assert.match(r.reportText, /只读与可写声明冲突/);
});

test('类型冲突：原声明与实际列不一致时保留报告，不提供第二套类型指令', () => {
    const r = convert(pathFormat(['/世界/时间 replace:number 当剧情改变时更新']));
    assert.ok(retained(r));
    assert.match(r.reportText, /原类型说明与已解析字段类型不一致/);
    assert.doesNotMatch(sheet(r, '世界表').sourceData.note, /replace:number|当剧情改变时更新/);
    assert.match(r.reportText, /原变量路径映射（仅供核对/);
});

test('类型冲突：整数声明不能在未落实整数约束的 REAL 列中被静默删掉', () => {
    const r = convert(pathFormat(['/世界/评分 replace:integer 必须整数']), { 世界: { 评分: 1.5 } });
    assert.ok(retained(r));
    assert.match(r.reportText, /原类型说明与已解析字段类型不一致/);
    assert.match(sheet(r, '世界表').sourceData.ddl, /REAL/);
});

test('散文规则：展平对象改写为实际列，清空值和条件不能丢失', () => {
    const r = core.convert({ name: '公开展平规则', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: '{"任务":{"支线":{"名称":"","进度":""}}}', enabled: false },
        { id: 2, comment: '[mvu_update]', content: '支线:\n  - 非空时 replace /任务/支线 为 {"名称":"","进度":""}', enabled: true },
    ] }, extensions: { tavern_helper: { scripts: [{ name: '结构', enabled: true, content:
        "import {registerMvuSchema} from 'https://example.test/mvu_zod.js';registerMvuSchema(z.object({任务:z.object({支线:z.object({名称:z.string(),进度:z.string()})})}));" }] } } });
    const note = sheet(r, '任务表').sourceData.note;
    assert.match(note, /非空时 更新 「支线_名称」、「支线_进度」/);
    assert.match(note, /「支线_名称」=""、?「支线_进度」=""/);
    assert.doesNotMatch(note, /\/任务\/支线|为 \{"名称"/);
    assert.strictEqual(retained(r), undefined);
});

test('JSON 数组规则：元素记录的内部字段路径相对于实际内容列', () => {
    const card = { name: '公开JSON数组', character_book: { entries: [
        { id: 1, comment: '[InitVar]', enabled: false, content: '{"事件":[]}' },
        { id: 2, comment: '[mvu_update]', enabled: true, content: '事件:\n  - 节点完成后 replace /事件/{i}/阶段 为下一阶段' },
    ] }, extensions: { tavern_helper: { scripts: [{ enabled: true, name: '结构', content:
        "import {registerMvuSchema} from 'https://example.test/mvu_zod.js';registerMvuSchema(z.object({事件:z.array(z.any())}));" }] } } };
    const r = core.convert(card);
    assert.match(sheet(r, '事件表').sourceData.note, /对应元素记录的「内容」内部路径 \/阶段/);
    assert.doesNotMatch(sheet(r, '事件表').sourceData.note, /\/事件\/\{i\}/);
    assert.strictEqual(retained(r), undefined);
});

const protocolRules = `  rule:
    - 每次回复仅允许一个独立的<logic_check>与一个独立的<UpdateVariable>；二者不得嵌套，<UpdateVariable>必须位于回复末尾
    - 更新指令=JSON Patch(RFC6902)数组 支持操作:
        - replace:替换已有路径值
        - add:新增对象/数组项(\x60-\x60=数组末尾追加)
        - remove
    - 禁输出完整变量JSON/YAML 仅输出diff操作于<JSONPatch>
    - 更新推理仅放<Analysis>，变量操作仅放<JSONPatch>
`;
test('输出协议：已确认文档中的完整协议规则逐项清理，业务续句保留', () => {
    const content = pathFormat(['/名字 readonly(人物姓名)']).replace('  format:', protocolRules + '  format:');
    assert.strictEqual(retained(convert(content)), undefined);
    const mixed = content.replace('    - 更新推理仅放', '    - 不得忘记尚未结算的约定\n    - 更新推理仅放');
    const r = convert(mixed);assert.match(retained(r).content, /不得忘记尚未结算的约定/);
    assert.doesNotMatch(retained(r).content, /logic_check|UpdateVariable|JSONPatch|RFC6902/);
    const conditional = content.replace('<UpdateVariable>必须位于回复末尾', '<UpdateVariable>必须位于回复末尾，任务结束时保留未支付债务');
    assert.match(retained(convert(conditional)).content, /任务结束时保留未支付债务/);
});
test('复杂权限：JSON 叶子说明完整迁移，条件不能推导整表只读或开放其他路径', () => {
    const source = { name: '公开复杂权限测试', character_book: { entries: [
        { id: 1, comment: '[InitVar]', content: JSON.stringify({ 自由: { 甲: { 称呼冻结: false, 对玩家称呼: '主人', 好感: 10 } } }) },
        { id: 2, comment: '[mvu_update]变量输出格式', content: pathFormat([
            '/自由/{全名}/称呼冻结 readonly(玩家界面管理 boolean；缺失视为false，禁模型新增、修改或删除；为true时对玩家称呼禁改)',
            '/自由/{全名}/好感 replace:number(0~100)']).replace('  format:', protocolRules + '  format:') }
    ] }, extensions: { tavern_helper: { scripts: [{ name: '结构', content: "const S=z.object({自由:z.any()});registerMvuSchema(S);" }] } } };
    const result=core.convert(source), table=sheet(result,'自由表');
    assert.strictEqual(retained(result), undefined);
    assert.match(table.sourceData.note,/内部路径 \/\{全名\}\/称呼冻结/);
    for(const text of ['玩家界面管理 boolean','缺失视为false','禁模型新增、修改或删除','为true时对玩家称呼禁改'])assert.ok(table.sourceData.note.includes(text));
    assert.doesNotMatch(table.sourceData.note,/本表为模型只读状态|UpdateVariable|JSONPatch|原变量路径/);
    assert.notStrictEqual(table.updateConfig.updateFrequency,0);
    const group=result.schema.find(g=>g.tableName==='自由表');
    assert.strictEqual(group.jsonAiWritable,true,'明确可写路径仍被承接');
    assert.ok(group.columns.every(c=>!c.aiReadonly),'条件说明不能把整个 JSON 列标成只读');
    const onlyConditional=core.convert({...source,character_book:{entries:[source.character_book.entries[0],{...source.character_book.entries[1],content:pathFormat(['/自由/{全名}/称呼冻结 readonly(仅在开局时由玩家界面管理)'])}]}});
    assert.ok(!onlyConditional.schema.find(g=>g.tableName==='自由表').jsonAiWritable,'复杂权限自身不能自动开放整个 JSON');
});

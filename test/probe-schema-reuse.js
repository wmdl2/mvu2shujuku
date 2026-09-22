'use strict';
// 能力探针：显式传入作者原始 mvu_zod.ts、Zod 与 lodash 路径，不参与普通回归。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');
const { stripTypeScriptTypes } = require('module');
const core = require('../src/mvu2shujuku');
const builder = require('../src/extension-runtime').createCandidateBuilder({ core });
const [sourceFile, zodPath, lodashPath] = process.argv.slice(2);
if (!sourceFile || !zodPath || !lodashPath) throw new Error('用法：node probe-schema-reuse.js mvu_zod.ts zod路径 lodash路径');
const z = require(zodPath), lodash = require(lodashPath), source = fs.readFileSync(sourceFile, 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
// 只替换错误文本格式化导入、移除导出关键字和类型；原注册/命令处理逻辑不改。
const js = stripTypeScriptTypes(source.replace(/^import \{ prettifyErrorWithInput \} from '@util\/common';/m,
    'const prettifyErrorWithInput = error => error.message;').replace('export function registerMvuSchema', 'function registerMvuSchema'));
function originalRuntime(schema) {
    const events = new Map(), registrations = [], errors = [];
    const register = vm.runInNewContext(js + '\nregisterMvuSchema;', { z, _: lodash, klona: clone,
        eventOn: (name, fn) => events.set(name, fn), registerVariableSchema: (s, options) => registrations.push({ schema: s, options }),
        $: () => ({ prop: () => false }), toastr: { warning() {}, error() {} }, YAML: { parse: JSON.parse },
        console: { info() {}, warn: value => errors.push(value), error: value => errors.push(value) },
    });
    register(schema);
    return { events, registrations, errors };
}
function update(runtime, before, commands) {
    const variables = { stat_data: clone(before) }, operations = clone(commands);
    runtime.events.get('mag_command_parsed_for_zod')(variables, operations);
    runtime.events.get('mag_command_parsed_ended_for_zod')(variables, operations);
    runtime.events.get('mag_variable_update_ended_for_zod')(variables);
    assert.strictEqual(operations.length, 0);
    return clone(variables.stat_data);
}
const set = (path, value) => ({ type: 'set', args: [JSON.stringify(path), JSON.stringify(value)], full_match: `_.set(${JSON.stringify(path)},${JSON.stringify(value)})` });
(async () => {
    const before = { 状态: { 生命: 100, 上限: 100, 金币: 10 }, 背包: ['钥匙'] };
    const schema = z.object({ 状态: z.object({ 生命: z.coerce.number(), 上限: z.coerce.number(), 金币: z.coerce.number().min(0) })
        .transform(value => ({ ...value, 生命: Math.min(value.生命, value.上限) })), 背包: z.array(z.string()) });
    const runtime = originalRuntime(schema);
    assert.strictEqual(runtime.registrations[0].options.type, 'message');
    const sequential = update(runtime, before, [set('状态.生命', 120), set('状态.上限', 150)]);
    const finalOnly = schema.parse({ ...before, 状态: { ...before.状态, 生命: 120, 上限: 150 } });
    assert.strictEqual(sequential.状态.生命, 100);
    assert.strictEqual(finalOnly.状态.生命, 120);
    const rejected = update(runtime, before, [set('状态.金币', -5), set('状态.生命', '80')]);
    assert.deepStrictEqual(rejected.状态, { 生命: 80, 上限: 100, 金币: 10 });
    const result = core.convert({ name: 'Schema复用探针', first_mes: '', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(before) }] } });
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    const encoded = await builder.buildUpdatedTemplateFromStat(layout, before, sequential, result.template);
    const roundTrip = core.statDataFromTables(layout, encoded).stat_data;
    assert.deepStrictEqual(roundTrip, sequential);
    // 只捕获原注册对象，也可在独立候选对象上执行；不会写入真实数据库。
    const registeredCandidate = runtime.registrations.at(-1).schema.parse({ stat_data: finalOnly }).stat_data;
    assert.deepStrictEqual(registeredCandidate, finalOnly);
    console.log(JSON.stringify({ upstreamSha256: crypto.createHash('sha256').update(source).digest('hex'),
        zodVersion: z.core?.version, registeredEvents: [...runtime.events.keys()], sequential, finalOnly,
        invalidCommandRejectedAndCoercionPreserved: rejected, tableRoundTrip: roundTrip,
        conclusions: { originalCommandLogicReusable: true, schemaObjectReusable: true, wholeCandidateParseEquivalentToCommandSequence: false },
        boundary: '原辅助脚本命令阶段及真实表格编解码探针；不证明 SP SQL 填表已有提交前接入点。' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

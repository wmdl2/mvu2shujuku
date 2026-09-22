'use strict';
// 本地纯计算测量；不含宿主 I/O、回放或真实模型调用，不作为固定耗时断言。
const { performance } = require('perf_hooks');
const { core, applyingApi } = require('./helpers');
const sessions = require('../src/runtime-session')(() => ({ characterKey: 'bench', chatKey: 'bench' }));
const builder = require('../src/extension-runtime').createCandidateBuilder({ core });
const clone = value => JSON.parse(JSON.stringify(value));
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
    const floor = [];
    for (const messages of [100, 1000, 10000]) {
        const tag = { storageFrame: { version: 2, logEntries: [] } };
        const chat = Array.from({ length: messages }, (_, i) => i % 2 === 0 ? { is_user: true }
            : { is_user: false, mes: 'reply', TavernDB_ACU_IsolatedData: { '': tag } });
        const session = sessions.bindWriteTarget(sessions.capture(), () => chat);
        for (let i = 0; i < 10; i++) session.writeTarget.canUseCrud();
        const times = [];
        for (let i = 0; i < 101; i++) {
            const start = performance.now();
            if (!session.writeTarget.canUseCrud()) throw new Error('invalid benchmark fixture');
            times.push(performance.now() - start);
        }
        floor.push({ messages, medianMs: median(times) });
    }
    const write = [];
    for (const rows of [100, 1000, 10000]) {
        const stat = { 状态: { 金币: 10 }, 记录: Object.fromEntries(Array.from({ length: rows }, (_, i) =>
            ['r' + i, { 数值: i, 说明: '公开基准' }])) };
        const result = core.convert({ name: '楼层写入基准', first_mes: '',
            extensions: { tavern_helper: { scripts: [{ name: 'schema', content: 'const S = z.object({ 状态: z.object({ 金币: z.number() }), 记录: z.record(z.string(), z.object({ 数值: z.number(), 说明: z.string() })) }); registerMvuSchema(S);' }] } },
            character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] },
        });
        const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
        const before = core.statDataFromTables(layout, result.template).stat_data;
        const after = clone(before); after.状态.金币 = 11;
        const mixed = clone(after); mixed.记录.r0.数值 = -1;
        const diff = [], snapshot = [], batchSingle = [], batchMixed = [];
        for (let i = 0; i < 6; i++) {
            const tables = clone(result.template), api = applyingApi(tables);
            let start = performance.now();
            await core.writeStatDiffToDb(api, layout, before, after);
            if (core.lastStatWriteFailed) throw new Error('diff failed');
            if (i) diff.push(performance.now() - start);
            start = performance.now();
            await builder.buildUpdatedTemplateFromStat(layout, before, after, result.template);
            if (i) snapshot.push(performance.now() - start);
            for (const [target, measurements, expectedCalls] of [[after, batchSingle, 1], [mixed, batchMixed, 2]]) {
                const host = applyingApi(clone(result.template));
                start = performance.now();
                const plan = await builder.planCurrentReplyWrites(host, layout, before, target);
                if (plan.operations.length !== expectedCalls || JSON.stringify(host.exportTableAsJson()) !== plan.beforeJson) throw new Error('invalid batch plan');
                if (plan.operations.length === 1) {
                    const op = plan.operations[0]; await host[op.method](...op.args);
                } else await host.importTableAsJson(JSON.stringify(plan.tables));
                if (i) measurements.push(performance.now() - start);
            }
        }
        write.push({ rows, snapshotBytes: Buffer.byteLength(JSON.stringify(result.template)),
            diffMedianMs: median(diff), candidateMedianMs: median(snapshot),
            batchSingleMedianMs: median(batchSingle), batchMixedMedianMs: median(batchMixed) });
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, floor, write }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// 公开提示词对照输入；期望文件只保存摘要，失败时按表名定位。
const clone = value => JSON.parse(JSON.stringify(value));
function typedCard() {
    const card = require('./synthetic-card')();
    const initial = { 状态: { 评级: '开始', 耐力: 10, 开关: true, 刻度: 1.5, 可空: null,
        情报: { 标题: "O'Brien", 正文: '第一行\n第二行' }, _内部: 7, $系统: '脚本维护' },
        清单: { 甲: { 名称: "O'Brien", 数量: 2 } }, 队列: ['甲', '乙'] };
    card.data.name = '提示词类型对照';
    card.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>公开测试。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(initial);
    const schema = `z.object({状态:z.object({评级:z.enum(['开始','结束']),耐力:z.number().min(0).max(10),开关:z.boolean(),刻度:z.number(),可空:z.string().nullable(),情报:z.object({标题:z.string(),正文:z.string()})}),清单:z.record(z.object({名称:z.string(),数量:z.number().min(0).max(50)})),队列:z.array(z.string())})`;
    card.data.extensions.tavern_helper = { scripts: [{ name: '结构', content: `const S=${schema};registerMvuSchema(S);` }] };
    return card;
}
function cases() {
    const sources = [
        ['basic', require('./frontend-card')],
        ['relationships', require('./prompt-guidance-card')],
        ['typed', typedCard],
        ['vwd', require('./vwd-card')],
    ];
    const output = [];
    for (const [name, makeCard] of sources) for (const mode of ['native', 'sqlite', 'both']) {
        for (const jsonContainers of [false, true]) for (const vwdDescriptions of name === 'vwd' ? [false, true] : [false]) {
            output.push({ name: [name, mode, jsonContainers ? 'json' : 'split', vwdDescriptions ? 'vwd' : 'static'].join('/'),
                card: makeCard(), options: { mode, jsonContainers, vwdDescriptions, targetSpVersion: '9.2.5' } });
        }
    }
    for (const mode of ['native', 'sqlite', 'both']) output.push({ name: 'reminders/' + mode,
        card: require('./frontend-card')(), options: { mode },
        reminders: ['仅当 状态.生命 变化时更新', '金币缺失时补齐；其余情况保留', '战斗、受伤、消耗、恢复时维护生命'] });
    return output;
}
function convertCase(core, entry) {
    const result = core.convert(clone(entry.card), entry.options);
    if (entry.reminders) {
        const group = result.schema.find(group => group.tableName === '状态表');
        if (!group) throw new Error('公开夹具缺少状态表');
        group.reminders = entry.reminders.slice();
        result.template = core.generateTemplate(result.schema, entry.options);
    }
    return result;
}
function snapshot(core, entry) {
    const crypto = require('crypto');
    const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const result = convertCase(core, entry);
    const marker = (result.card.data || result.card).extensions.mvu2shujuku;
    return { template: hash(result.template), layout: hash(marker.layout),
        sourceData: Object.fromEntries(Object.values(result.template).filter(sheet => sheet && sheet.sourceData)
            .map(sheet => [sheet.name, hash(sheet.sourceData)])) };
}
module.exports = { cases, convertCase, snapshot };

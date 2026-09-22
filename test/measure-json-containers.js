'use strict';
// 公共合成输入的静态库存计量；不是完整请求、计费数据或真实模型质量测量。
const path = require('path');
const core = require('../src/mvu2shujuku');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(__dirname, '../../参考资料');
const encoder = require(path.join(refs, 'SillyTavern/node_modules/tiktoken')).get_encoding('o200k_base');
const count = text => encoder.encode(String(text), [], []).length;
function inventory(result) {
    const total = { tables: 0, visibleContent: 0, note: 0, ddl: 0, operations: 0 };
    for (const group of result.schema) {
        const sheet = Object.values(result.template).find(s => s.name === group.tableName);
        const hidden = new Set(sheet.sourceData.hiddenPhysicalColumns || []);
        const visible = [true, ...group.columns.map(c => !hidden.has(c.ident))];
        total.tables++;
        total.visibleContent += count(JSON.stringify(sheet.content.map(row => row.filter((_, i) => visible[i]))));
        total.note += count(sheet.sourceData.note || '');
        const visibleGroup = { ...group, columns: group.columns.filter(c => !hidden.has(c.ident)),
            rows: (group.rows || []).map(row => row.filter((_, i) => visible[i])) };
        const projected = Object.values(core.generateTemplate([visibleGroup])).find(s => s.name === group.tableName);
        total.ddl += count(projected.sourceData.ddl || '');
        for (const key of ['initNode', 'insertNode', 'updateNode', 'deleteNode']) total.operations += count(sheet.sourceData[key] || '');
    }
    return total;
}
try {
    const samples = [];
    for (const size of [2, 200]) {
        const stat = { 状态: { 金币: 10 }, 记录: {} };
        for (let i = 0; i < size; i++) stat.记录['人物' + i] = { 好感: [i % 10, '当前好感'], 经历: ['事件甲', '事件乙', '事件丙'] };
        const card = { name: 'JSON成本合成样本', character_book: { entries: [
            { comment: '[InitVar]', content: JSON.stringify(stat) },
            { comment: '变量更新规则', content: '变量更新规则:\n  记录:\n    type: "{ [名字: string]: { 好感: number; 经历: string[]; } }"\n    check: 好感随互动变化，不得凭空增加经历' },
        ] } };
        samples.push({ records: size, originalStatJson: count(JSON.stringify(stat)),
            tables: inventory(core.convert(card)), fullJson: inventory(core.convert(card, { jsonContainers: true })) });
    }
    console.log(JSON.stringify({ encoding: 'o200k_base', scope: 'Separate visible template components; sums are not a full request. Original stat_data JSON excludes MVU rules and surrounding prompt.', samples }, null, 2));
} finally { encoder.free(); }

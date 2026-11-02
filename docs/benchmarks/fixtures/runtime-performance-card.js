'use strict';

// Public conversion benchmark: 17 stable record containers, 53 rows each.
// No private data or remote dependencies; runtime measurements are separate.
module.exports = function runtimePerformanceCard() {
    const stat = {}, fields = [];
    for (let group = 0; group < 17; group++) {
        const key = 'records_' + group;
        stat[key] = Object.fromEntries(Array.from({ length: 53 }, (_, row) => ['id_' + row, {
            name: 'NPC_' + group + '_' + row,
            score: row / 10,
            enabled: row % 2 === 0,
            tags: ['public', 'test'],
        }]));
        fields.push(JSON.stringify(key) + ':z.record(z.string(),z.object({name:z.string(),score:z.number(),enabled:z.boolean(),tags:z.array(z.string())})).default({})');
    }
    return { stat, source: {
        name: '公开性能合成样本', first_mes: '性能验证。',
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat), enabled: true }] },
        extensions: { tavern_helper: { scripts: [{ type: 'script', name: 'Schema', enabled: true,
            content: 'registerMvuSchema(z.object({' + fields.join(',') + '}));' }] } },
    } };
};

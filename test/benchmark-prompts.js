'use strict';
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const core = require('../src/mvu2shujuku');
const syntheticCard = require('./synthetic-card');
const createRuntimeWindows = require('../src/runtime-windows');

function args(argv) {
    const out = {};
    for (const item of argv.slice(2)) {
        const m = item.match(/^--([^=]+)(?:=(.*))?$/);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}
function cardFrom(file) { return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) : syntheticCard(); }
function inventory(result, card) {
    const sheets = Object.values(result.template).filter(s => s && s.content && s.sourceData);
    const ordered = sheets.slice().sort((a, b) => (a.orderNo || 0) - (b.orderNo || 0));
    let maxCellChars = 0, maxColumnsExcludingRowId = 0, jsonMaxCellChars = 0, jsonTotalChars = 0, contentJsonMaxChars = 0, contentJsonTotalChars = 0;
    for (const sheet of sheets) {
        maxColumnsExcludingRowId = Math.max(maxColumnsExcludingRowId, Math.max(0, (sheet.content && sheet.content[0] || []).length - 1));
        for (const row of sheet.content || []) for (const cell of row || []) maxCellChars = Math.max(maxCellChars, String(cell == null ? '' : cell).length);
        const group = result.schema.find(g => g.tableName === sheet.name);
        if (!group) continue;
        for (let ci = 0; ci < group.columns.length; ci++) {
            const col = group.columns[ci];
            if (!col.isObject && col.logicalType !== 'jsonScalarOptional') continue;
            for (const row of sheet.content.slice(1)) {
                const chars = String(row[ci + 1] == null ? '' : row[ci + 1]).length;
                jsonMaxCellChars = Math.max(jsonMaxCellChars, chars); jsonTotalChars += chars;
                if (col.zh === '内容') { contentJsonMaxChars = Math.max(contentJsonMaxChars, chars); contentJsonTotalChars += chars; }
            }
        }
    }
    const fields = ['EJS', 'getvar', 'format_message_variable', 'getAllVariables'];
    const entries = (card.data || card).character_book?.entries || [];
    const variableEntries = entries.filter(e => fields.some(f => new RegExp(f, 'i').test(String(e && e.content || ''))) || /<%[\s\S]*%>/.test(String(e && e.content || '')));
    const sizes = name => name === 'DDL' ? sheets.reduce((n, s) => n + String(s.sourceData.ddl || '').length, 0) : sheets.reduce((n, s) => n + String(s.sourceData[name] || '').length, 0);
    return {
        tableCount: sheets.length,
        chars: Object.fromEntries(['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode'].map(k => [k, sizes(k)]).concat([['DDL', sizes('DDL')], ['content', sheets.reduce((n, sheet) => n + JSON.stringify(sheet.content).length, 0)]])),
        logicalOrder: ordered.map(s => s.name), maxCellChars, maxColumnsExcludingRowId,
        jsonColumns: { maxCellChars: jsonMaxCellChars, totalChars: jsonTotalChars, contentJsonMaxChars, contentJsonTotalChars },
        variableDisplayEntries: { count: variableEntries.length, chars: variableEntries.reduce((n, e) => n + String(e.content || '').length, 0) },
    };
}
class NoopObserver { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } }
function measureRuntimeWindows() {
    const frames = [];
    class Doc { querySelectorAll() { return this.frames || []; } }
    class Frame {
        constructor(win) { this.localName = 'iframe'; this.contentWindow = win; }
        addEventListener() {}
        removeEventListener() {}
    }
    const rootDoc = new Doc(); rootDoc.frames = [];
    const root = { document: rootDoc, closed: false };
    for (let i = 0; i < 100; i++) { const doc = new Doc(); const win = { document: doc, closed: false }; const frame = new Frame(win); frame.parentNode = root; rootDoc.frames.push(frame); frames.push(frame); }
    const run = MutationObserver => {
        const rw = createRuntimeWindows({ readRoots: () => [root], readSessionKey: () => 'bench', MutationObserver });
        const start = performance.now(); for (let i = 0; i < 30; i++) { rw.getWindows(); rw.getWindows(); } const elapsedMs = performance.now() - start;
        return { queries: rw.stats.queries, enumeratedFrames: rw.stats.enumeratedFrames, scans: rw.stats.scans, hits: rw.stats.hits, elapsedMs: Number(elapsedMs.toFixed(3)) };
    };
    const current = run(NoopObserver);
    return {
        legacyEquivalent: { queries: 30 * 2 * 2, enumeratedFrames: 30 * 2 * 2 * 100 },
        fallbackNoMutationObserver: run(undefined), cachedMutationObserver: current,
    };
}
function measureOne(name, card, currentCore, baselinePath) {
    const out = { sample: name, inventoryOnly: true, current: inventory(currentCore.convert(card, { mode: 'both' }), card) };
    if (baselinePath) {
        const baseline = require(path.resolve(baselinePath));
        out.baseline = inventory(baseline.convert(card, { mode: 'both' }), card);
    }
    return out;
}
function main() {
    const cli = args(process.argv);
    const samples = cli.card ? [{ name: path.basename(cli.card), card: cardFrom(cli.card) }] : [
        { name: 'synthetic-card', card: syntheticCard() },
        { name: 'synthetic-parent-order', card: { name: 'synthetic-parent-order', first_mes: 'A/B', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify({ A: { value: 1, bag: [1, 2, 3] }, B: { value: 2, bag: [4, 5, 6] } }) }] } } },
    ];
    const result = { environment: { node: process.version, platform: process.platform }, samples: samples.map(s => measureOne(s.name, s.card, core, cli.baseline)), runtimeWindows: measureRuntimeWindows() };
    console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main();
module.exports = { inventory, measureRuntimeWindows, main };

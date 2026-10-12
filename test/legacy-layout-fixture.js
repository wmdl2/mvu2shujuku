'use strict';
// Frozen synthetic schema-builder outputs from 96067ef, with the version-1
// storage contract explicitly selected. No ignored old source or private card
// is required. Current conversion acceptance belongs to layout-planning.js.
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const core = require('../src/mvu2shujuku');
const {decode}=require('./frozen-value-codec');
const frozen = decode(JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('./legacy/layouts.json.gz')))));
const localPath=require('path').join(__dirname,'fixtures/legacy-layouts.local.json');
const local=fs.existsSync(localPath)?decode(JSON.parse(fs.readFileSync(localPath,'utf8'))):{};
function fixture(source, options = {}, published = false) {
    const key = (published ? 'published:' : '') + (core.isVwdExperimental() ? 'vwd:' : '')
        + crypto.createHash('sha256').update(JSON.stringify([source, options])).digest('hex');
    const saved = frozen.fixtures[key] || local[key];
    if (!saved) throw new Error('Missing frozen legacy layout fixture: ' + key);
    const { schema, template, layout, policy, report } = structuredClone(saved);
    const result = core.convert(structuredClone(source), options), data = result.card.data || result.card;
    result.schema = schema;
    result.template = template;
    result.layout = layout;
    result.meta.tableNames = schema.map(g => g.tableName);
    result.meta.tableCount = schema.length;
    result.report = Object.assign(core.createReport(), report);
    result.reportText = result.report.toMarkdown();
    data.extensions.mvu2shujuku.layout = core.buildLayoutJson(layout);
    data.extensions.mvu2shujuku.statStorage = policy;
    result.bridgeScript = core.generateBridgeScript(schema, template, {
        ...options, bridgeCardName: data.name || '', bridgeCardAvatar: data.avatar || '',
        bridgeConvertedAt: data.extensions.mvu2shujuku.convertedAt, statStorage: policy,
    });
    const entry = data.character_book.entries.find(e => e.keys?.includes('__ACU_TEMPLATE_DATA__'));
    if (entry) entry.content = Buffer.from(JSON.stringify(template), 'utf8').toString('base64');
    return result;
}
module.exports=(source,options)=>fixture(source,options);
module.exports.published=(source,options)=>fixture(source,options,true);

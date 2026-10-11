'use strict';
// Exercise retained legacy layout/codec contracts through the same public
// schema builder used by the product. This is not a new-conversion acceptance
// fixture: the current conversion planner intentionally uses new ownership
// boundaries. No old source tree or private card is required.
const core = require('../src/mvu2shujuku');
const createStorage = require('../src/stat-storage');
const codec = require('../src/table-codec')();
module.exports = function legacyLayoutFixture(source, options = {}) {
    const card = structuredClone(source), original = card.data || card;
    const entry = original.character_book.entries.find(e => /initvar/i.test(e.comment || ''));
    const greetingInit = [original.first_mes, ...(original.alternate_greetings || []),
        ...original.character_book.entries.filter(e => e !== entry).map(e => e.content)]
        .map(text => String(text || '').match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/i)).find(Boolean);
    if (!entry && !greetingInit) throw new Error('Legacy fixture requires a literal InitVar or first greeting block');
    const initial = core.parseInitVar(entry ? entry.content : greetingInit[1]);
    const report = core.createReport();
    const shape = core.parseMvuShapes(card, report);
    const variation = require('../src/schema-layout')({
        parseInitVar: core.parseInitVar, analyzeMvuInitMetadata: core.analyzeMvuInitMetadata,
        createStatusUsage: require('../src/status-usage'),
    }).scanGreetingShapeVariation(original);
    for (const path of variation.dynamicPaths) shape.dynamicPaths.add(path);
    for (const name of variation.dynamicGroups) shape.dynamicGroups.add(name);
    shape.dynamicPathSamples = variation.samples;
    const store = createStorage({ readPolicy: () => ({ version: 1 }) });
    const schema = core.buildSchema(store.split(initial).database, core.scanStatusUsage(card), report, shape, {
        vwdDescriptions: options.vwdDescriptions,
    });
    // Version 1 is the retained draft layout contract, including its fallback
    // table. It is explicitly selected here, never the current converter default.
    const policy = store.plan(schema, shape, initial, core.buildLayout(schema).entries, core.toPinyinSlug);
    const template = core.generateTemplate(schema, { ...options, report });
    core.migrateTemplatePromptRuntime(template, original.extensions?.regex_scripts || [], report, schema);
    for (const group of schema) if (group.vwd?.promptVersion === 1) {
        const sheet = Object.values(template).find(s => s?.name === group.tableName);
        codec.bindVwdPromptNote(group.vwd, group.tableName, sheet.sourceData.note);
    }
    const result = core.convert(card, options), data = result.card.data || result.card;
    result.schema = schema;
    result.meta.tableNames = schema.map(g => g.tableName);
    result.meta.tableCount = schema.length;
    result.template = template;
    result.report = report;
    result.reportText = report.toMarkdown();
    result.layout = core.buildLayout(schema);
    data.extensions.mvu2shujuku.layout = core.buildLayoutJson(core.buildLayout(schema));
    data.extensions.mvu2shujuku.statStorage = policy;
    const templateEntry = data.character_book.entries.find(e => e.keys?.includes('__ACU_TEMPLATE_DATA__'));
    if (templateEntry) templateEntry.content = Buffer.from(JSON.stringify(template), 'utf8').toString('base64');
    return result;
};

'use strict';
// 显式计量公开样本说明片段，不发送模型请求，也不参与普通回归。
const path = require('path');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const core = require(root + '/src/mvu2shujuku');
const tokenizer = require(path.join(refs, 'SillyTavern/node_modules/tiktoken')).get_encoding('o200k_base');
const card = require(root + '/test/vwd-card')();
const original = core.convert(card), next = core.convert(card, {vwdDescriptions:true});
const layout = JSON.parse((next.card.data || next.card).extensions.mvu2shujuku.layout);
const entry = layout.find(e => e.group === '好感系统');
const sheet = Object.values(next.template).find(e => e.name === entry.table);
const oldNote = Object.values(original.template).find(e => e.name === entry.table).sourceData.note;
const texts = core.vwdPromptDescriptions(entry, sheet);
const rendered = '\n' + core.vwdNoteFromSlots(entry.vwd.plan, index => texts[entry.vwd.fields.findIndex(f => f.id === entry.vwd.tokens[index])]);
const count = text => tokenizer.encode(text, [], []).length;
const plain = '完成委托后提高好感上限';
const special = '完成委托 <%= 40 + 2 %> {{user}} {[db.状态表.where("row_id",1).get("金币")]}';
const samples = [plain,special].map(text => ({text, rawTokens:count(text), formattedTokens:count(core.formatVwdPromptDescription(text))}));
const times=[];
for(let warm=0;warm<3;warm++) {
 const start=performance.now();for(let i=0;i<10000;i++)core.vwdPromptDescriptions(entry,sheet);
 times.push((performance.now()-start)/10000);
}
const result = {encoding:'o200k_base', scope:'synthetic note text only; model quality and billing not measured',
 oldNoteTokens:count(oldNote), renderedNoteTokens:count(rendered), delta:count(rendered)-count(oldNote), samples,
 renderMillisecondsPerTable:times.at(-1), fields:entry.vwd.fields.length,
 performanceScope:'pure codec incl note/slot checks; excludes SP export, persistence and network'};
console.log(JSON.stringify(result,null,2)); tokenizer.free();

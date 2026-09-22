'use strict';
// 输入 real-host 保存的请求文件，只计量已有文本，不发送模型请求。
// 例：node test/measure-prompts.js .tools/real-host/prompt-native-<runId>.json
const fs = require('fs');
const path = require('path');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(__dirname, '../../参考资料');
const tokenizer = require(path.join(refs, 'SillyTavern/node_modules/tiktoken')).get_encoding('o200k_base');
try {
    const count = text => tokenizer.encode(String(text), [], []).length;
    const results = process.argv.slice(2).map(file => {
        const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { file: path.basename(file), requests: (capture.requests || []).map(request => {
            const texts = (request.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            const tables = texts.filter(text => text.includes('<当前表格数据>\n'));
            const initvar = texts.flatMap(text => [...text.matchAll(/<initvar\b[^>]*>[\s\S]*?<\/initvar>/gi)].map(m => m[0]));
            return { contentChars: texts.reduce((n, s) => n + s.length, 0), contentTokens: texts.reduce((n, s) => n + count(s), 0),
                tableMessageChars: tables.reduce((n, s) => n + s.length, 0), tableMessageTokens: tables.reduce((n, s) => n + count(s), 0),
                initvarBlocks: initvar.length, initvarTokens: initvar.reduce((n, s) => n + count(s), 0) };
        }) };
    });
    console.log(JSON.stringify({ encoding: 'o200k_base', scope: 'sum of message content; excludes role/protocol overhead and output; not billed tokens or model quality', results }, null, 2));
} finally { tokenizer.free(); }

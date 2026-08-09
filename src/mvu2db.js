/*
 * mvu2db.js — MVU 角色卡 → SP·数据库（神·数据库）角色卡转换器
 *
 * 运行环境：
 *  - 酒馆助手（JS-Slash-Runner）脚本：在 SillyTavern 内运行，提供按钮与下载/建卡流程
 *  - Node.js：`require('./mvu2db.js')` 可测试纯函数核心
 *
 * 输出：
 *  1. 转换后的角色卡（JSON，或回包 PNG）
 *  2. 表格模板 JSON（可导入插件，scope=global/chat）
 *  3. 转换报告（Markdown）
 */
(function (root) {
    'use strict';

    const VERSION = '0.1.0';

    /* ================================================================
     * 开局建表核心流程（对应 MVU 的 init 时机 → SP·数据库 的初始化）
     *
     * MVU 在聊天开始（首条消息存在）时用 [InitVar] 初始化变量；
     * 转换后由 SP·数据库 的 initGameSession 在同样时机建表并写入初始行。
     * 本片段是纯 ES5 字符串，同时内嵌进 卡内数据桥脚本 与 扩展本体，
     * 保证两处行为一致；规则只来自插件 API（importTemplateFromData /
     * initGameSession / exportTableAsJson），不含任何特定角色卡内容。
     * ================================================================ */
    const DB_INIT_SNIPPET = [
        'function mvu2dbDecodeB64(b){try{var bin=atob(b);var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder("utf-8").decode(bytes);}catch(e){return decodeURIComponent(escape(atob(b)));}}',
        'function mvu2dbExpectedTableNames(tpl){var names=[];if(!tpl||typeof tpl!=="object")return names;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(s&&typeof s==="object"&&typeof s.name==="string"&&names.indexOf(s.name)===-1)names.push(s.name);}return names;}',
        'function mvu2dbMissingTableNames(api,names){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=true;}var missing=[];for(var i=0;i<names.length;i++){if(!have[names[i]])missing.push(names[i]);}return missing;}',
        'async function mvu2dbEnsureInit(api,b64,presetName){var out={status:"skip",message:"",missing:[]};var tpl=null;try{tpl=JSON.parse(mvu2dbDecodeB64(b64));}catch(e){out.status="error";out.message="模板解码失败: "+(e&&e.message?e.message:e);return out;}var names=mvu2dbExpectedTableNames(tpl);if(!names.length){out.status="error";out.message="模板中没有 sheet_* 表";return out;}out.missing=mvu2dbMissingTableNames(api,names);if(!out.missing.length){out.status="skip";out.message="已有全部表格，跳过开局建表";return out;}var steps=[];if(typeof api.importTemplateFromData==="function"){try{var r1=await Promise.resolve(api.importTemplateFromData(tpl,{scope:"chat",presetName:presetName||""}));steps.push(r1&&r1.success===false?("importTemplateFromData: "+(r1.message||"失败")):"importTemplateFromData: 完成");}catch(e){steps.push("importTemplateFromData异常: "+(e&&e.message?e.message:e));}}if(typeof api.initGameSession==="function"){try{var r2=await Promise.resolve(api.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:presetName||""}));if(r2&&r2.success===false)steps.push("initGameSession: "+(r2.message||"失败"));else steps.push("initGameSession: 完成"+(r2&&r2.runtimeReady===false?"（运行时未就绪）":""));}catch(e){steps.push("initGameSession异常: "+(e&&e.message?e.message:e));}}else{steps.push("initGameSession: 不可用（仅 importTemplateFromData）");}out.missing=mvu2dbMissingTableNames(api,names);out.status=out.missing.length?"partial":"ok";out.message=steps.join("；")+"；剩余缺表："+(out.missing.length?out.missing.join("、"):"无");return out;}',
    ].join('\n');

    /* ================================================================
     * 拼音标识符（与 SP·数据库 插件内部的中文→拼音逻辑一致，基于 pinyin-pro 字典）
     * 角色卡的中文组名/字段名 → 拼音 slug，作为 SQLite 物理标识符。
     * 字典来自 转换器/src/pinyin-data.js（生成自 pinyin-pro，MIT）。
     * ================================================================ */

    function getPinyinMap() {
        if (root.__MVU2DB_PINYIN__) return root.__MVU2DB_PINYIN__;
        try {
            if (typeof require === 'function') {
                root.__MVU2DB_PINYIN__ = require('./pinyin-data.js');
                return root.__MVU2DB_PINYIN__;
            }
        } catch (e) { /* 浏览器端由扩展构建时内联 */ }
        root.__MVU2DB_PINYIN__ = root.__MVU2DB_PINYIN__ || {};
        return root.__MVU2DB_PINYIN__;
    }

    let pinyinReverse = null;
    function pinyinOf(char) {
        if (!pinyinReverse) {
            const map = getPinyinMap();
            pinyinReverse = new Map();
            for (const py of Object.keys(map)) {
                const chars = map[py];
                const first = String(py).split(/\s+/)[0] || py;
                for (let i = 0; i < chars.length; i++) {
                    if (!pinyinReverse.has(chars[i])) pinyinReverse.set(chars[i], first);
                }
            }
        }
        return pinyinReverse.get(char) || '';
    }

    // 中文/符号文本 → 拼音 slug（无声调、小写、非字母数字转下划线），与插件物理表名风格一致
    function toPinyinSlug(value, maxLength) {
        const limit = maxLength || 64;
        let out = '';
        const s = String(value == null ? '' : value);
        for (const ch of s) {
            const code = ch.codePointAt(0);
            if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
                out += pinyinOf(ch);
            } else {
                out += ch;
            }
        }
        return out.normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, Math.max(1, limit))
            .replace(/_+$/g, '');
    }

    const DEFAULT_UPDATE_CONFIG = {
        uiSentinel: -1,
        contextDepth: -1,
        updateFrequency: -1,
        batchSize: -1,
        skipFloors: -1,
    };

    function defaultExportConfig(entryName, { rows = false, keywords = '', injectionTemplate = '' } = {}) {
        return {
            enabled: rows,
            splitByRow: rows,
            entryName: entryName || '',
            entryType: rows ? 'keyword' : 'constant',
            keywords: keywords || '',
            preventRecursion: true,
            injectionTemplate: injectionTemplate || '',
            extraIndexEnabled: false,
            extraIndexEntryName: (entryName || '') + '-索引',
            extraIndexColumns: [],
            extraIndexColumnModes: {},
            extraIndexInjectionTemplate: '',
            sqlInjectionTemplate: '',
            entryPlacement: { position: 'at_depth_as_system', depth: rows ? 10000 : 2, order: 10000 },
            extraIndexPlacement: { position: 'at_depth_as_system', depth: 1000, order: 10010 },
            fixedEntryPlacement: { position: 'at_depth_as_system', depth: rows ? 10000 : 2, order: 99990 },
            fixedIndexPlacement: { position: 'at_depth_as_system', depth: 1000, order: 99991 },
        };
    }

    /* ================================================================
     * 工具函数
     * ================================================================ */

    function deepClone(v) {
        return JSON.parse(JSON.stringify(v));
    }

    // 与 MVU correctlyMerge 语义一致：对象深合并，数组/标量由后者覆盖
    function deepMerge(target, source) {
        if (Array.isArray(source)) return deepClone(source);
        if (!isPlainObject(source)) return source;
        const out = isPlainObject(target) ? deepClone(target) : {};
        for (const k of Object.keys(source)) {
            out[k] = isPlainObject(source[k]) ? deepMerge(out[k], source[k]) : deepClone(source[k]);
        }
        return out;
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    // 确定性 hash → 短 id（用于 sheet uid / 未知标识符）
    function stableHash(value) {
        let h = 2166136261;
        const s = String(value);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function toIdent(zh, used, kind) {
        const slug = toPinyinSlug(zh);
        const base = slug || (kind === 'table' ? `table_${used.size + 1}` : `col_${used.size + 1}`);
        let candidate = base;
        let i = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = `${base}_${i}`;
            i++;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    }

    function stripJsonComments(text) {
        // 去掉 /* */ 与行注释 //（字符串外的），用于 JSON5 预处理
        let out = '';
        let i = 0;
        let inStr = null;
        while (i < text.length) {
            const ch = text[i];
            if (inStr) {
                out += ch;
                if (ch === '\\' && i + 1 < text.length) {
                    out += text[i + 1];
                    i += 2;
                    continue;
                }
                if (ch === inStr) inStr = null;
                i++;
                continue;
            }
            if (ch === '"' || ch === "'") {
                inStr = ch;
                out += ch;
                i++;
                continue;
            }
            if (ch === '/' && text[i + 1] === '*') {
                i = text.indexOf('*/', i + 2);
                i = i === -1 ? text.length : i + 2;
                continue;
            }
            if (ch === '/' && text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') i++;
                continue;
            }
            out += ch;
            i++;
        }
        return out;
    }

    function json5Lite(value) {
        // 尽力把常见 JSON5 变成 JSON：去注释、单引号→双引号、去键引号、去尾逗号
        let s = stripJsonComments(value).trim();
        s = s.replace(/,\s*([}\]])/g, '$1'); // 去尾逗号
        s = s.replace(/'/g, '"'); // 单引号 → 双引号（initvar 中极少含转义单引号）
        s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*|[\u4e00-\u9fff]+)\s*:/g, '$1"$2":'); // 无引号键
        return s;
    }

    /* ================================================================
     * initvar 解析（YAML 子集 + JSON5 兼容）
     * ================================================================ */

    function parseScalar(token) {
        const t = String(token).trim();
        if (t === '') return '';
        if (t === '{}') return {};
        if (t === '[]') return [];
        if (/^\[.*\]$/s.test(t)) {
            // 内联数组 [a, b] / ["a", "b"] / [1, 2]
            const inner = t.slice(1, -1).trim();
            if (!inner) return [];
            const items = [];
            let cur = '';
            let depth = 0;
            let inStr = null;
            for (let i = 0; i < inner.length; i++) {
                const ch = inner[i];
                if (inStr) {
                    cur += ch;
                    if (ch === '\\') { cur += inner[i + 1] || ''; i++; continue; }
                    if (ch === inStr) inStr = null;
                    continue;
                }
                if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
                if (ch === '[' || ch === '{') depth++;
                if (ch === ']' || ch === '}') depth--;
                if (ch === ',' && depth === 0) { items.push(parseScalar(cur)); cur = ''; continue; }
                cur += ch;
            }
            if (cur.trim()) items.push(parseScalar(cur));
            return items;
        }
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (t === 'null' || t === '~') return null;
        const q = t[0];
        if ((q === '"' || q === "'") && t[t.length - 1] === q) {
            return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
        }
        return t;
    }

    // 行解析：返回 {indent, key, value} 或 null
    function parseYamlLine(line) {
        const m = line.match(/^(\s*)([^:]+):\s*(.*)$/);
        if (!m) return null;
        const indent = m[1].replace(/\t/g, '    ').length;
        const key = m[2].trim().replace(/^["']|["']$/g, '');
        const value = m[3].trim();
        return { indent, key, value };
    }

    /**
     * 解析 initvar 条目内容。
     * 先按 JSON5（内容以 { 开头）尝试；再按 YAML 子集（缩进 + key: value）解析。
     * 支持：
     *   - 叶子标量
     *   - ["初始值", "条件描述"] 数组叶子
     *   - 嵌套字典、`- item` 列表
     *   - {}/[] 空容器
     */
    function parseInitVar(content) {
        const text = String(content || '').replace(/^\uFEFF/, '');
        const trimmed = text.trim();
        if (!trimmed) return {};
        if (/^[[{]/s.test(trimmed)) {
            try {
                return JSON.parse(trimmed);
            } catch (e) { /* fallthrough */ }
            try {
                return JSON.parse(json5Lite(trimmed));
            } catch (e) { /* fallthrough */ }
        }
        return parseYamlTree(text);
    }

    function parseYamlTree(text) {
        const lines = text.split(/\r?\n/);
        const root = {};
        // 栈：{ indent, obj }，obj 为当前层容器
        const stack = [{ indent: -1, obj: root, key: null, isList: false }];
        let pendingList = null; // 当前待插入的列表（- item 连续行）

        function current() { return stack[stack.length - 1]; }

        function ensureListOwner(indent) {
            // 如果当前栈顶不是 list 且该 list 还没归属，则在当前 obj 下建一个 _list 容器
            const top = current();
            if (top.isList && top.indent === indent) return top;
            return null;
        }

        for (const raw of lines) {
            const line = raw.replace(/\t/g, '    ');
            if (!line.trim() || /^\s*[#/]/.test(line.trim()) && !/^#/.test(line.trim())) {
                if (!line.trim() || line.trim().startsWith('#')) continue;
            }
            const m = line.match(/^(\s*)(-)?\s*(.*)$/);
            const indent = m[1].length;
            const isDash = m[2] === '-';
            const rest = m[3];
            if (isDash) {
                // 列表项
                const p = parseYamlLine(rest ? `x: ${rest}` : 'x:');
                // 找最近的列表归属
                while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
                const top = current();
                if (!top.isList) {
                    // 隐式列表：键在上一个“只有 key 无 value”的行
                    const parent = stack[stack.length - 1].obj;
                    const listKey = stack[stack.length - 1].key;
                    const list = [];
                    if (listKey) parent[listKey] = list;
                    stack.push({ indent, obj: list, key: null, isList: true });
                }
                const list = current().obj;
                if (p) {
                    // "key: value" 形式 → 列表项是对象
                    const item = {};
                    const v = p.value;
                    if (v !== '') {
                        item[p.key] = parseScalar(v);
                    } else {
                        list.push(item);
                        stack.push({ indent: indent + 2, obj: item, key: p.key, isList: false });
                        continue;
                    }
                    list.push(item);
                    if (v === '') stack.push({ indent: indent + 2, obj: item, key: null, isList: false });
                } else {
                    // 纯标量列表项
                    const v = rest.trim();
                    if (v.startsWith('{') || v.startsWith('[')) {
                        try { list.push(parseInitVar(v)); } catch (e) { list.push(parseScalar(v)); }
                    } else {
                        list.push(parseScalar(v));
                    }
                }
                continue;
            }

            const p = parseYamlLine(line);
            if (!p) continue;
            // 弹出缩进更深的栈
            while (stack.length > 1 && stack[stack.length - 1].indent >= p.indent) stack.pop();
            const top = current();
            const container = top.isList ? top.obj[top.obj.length - 1] : top.obj;
            const target = (container && typeof container === 'object' && !Array.isArray(container)) ? container : top.obj;
            if (p.value === '') {
                // 进入子层（可能是对象，也可能是行表）
                const child = {};
                target[p.key] = child;
                stack.push({ indent: p.indent, obj: child, key: p.key, isList: false });
            } else if (p.value === '{}' || p.value === '[]') {
                target[p.key] = p.value === '{}' ? {} : [];
            } else {
                target[p.key] = parseScalar(p.value);
            }
        }
        return root;
    }

    // 解析 [value, desc] 叶子：返回 { value, desc }
    function leafInfo(v) {
        if (Array.isArray(v)) {
            return { value: v.length > 0 ? v[0] : '', desc: v.length > 1 ? String(v[1]) : '' };
        }
        return { value: v, desc: '' };
    }

    /* ================================================================
     * PNG 解包 / 回包（chara chunk）
     * ================================================================ */

    const CRC_TABLE = (function () {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(buf) {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    // 兼容 Buffer / Uint8Array：按字节解码 latin1
    function latin1ToString(bytes) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('latin1');
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    // 读取 PNG 全部 chunk：返回 [{ type, data, crc, offset }]
    function readPngChunks(buffer) {
        if (!buffer || buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
            throw new Error('不是有效的 PNG 文件');
        }
        const chunks = [];
        let off = 8;
        const dv = buffer instanceof DataView ? buffer : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        while (off + 12 <= buffer.length) {
            const len = dv.getUint32(off);
            const type = String.fromCharCode(
                buffer[off + 4], buffer[off + 5], buffer[off + 6], buffer[off + 7]
            );
            const data = buffer.slice(off + 8, off + 8 + len);
            const crc = dv.getUint32(off + 8 + len);
            chunks.push({ type, data, crc, offset: off });
            off += 12 + len;
            if (type === 'IEND') break;
        }
        return chunks;
    }

    // 从 PNG 字节解析角色卡
    function parseCardPng(buffer) {
        const chunks = readPngChunks(buffer);
        for (const chunk of chunks) {
            if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') continue;
            const nul = chunk.data.indexOf(0);
            if (nul === -1) continue;
            const keyword = latin1ToString(chunk.data.slice(0, nul));
            if (keyword !== 'chara') continue;
            const payload = chunk.data.slice(nul + 1);
            // iTXt: keyword\0 compression(1) method(1) language\0 translated\0 text
            let text;
            if (chunk.type === 'iTXt') {
                if (payload[0] !== 0) throw new Error('chara iTXt 使用了压缩，暂不支持');
                let p = 3;
                while (p < payload.length && payload[p] !== 0) p++;
                p++; // 跳过 language
                while (p < payload.length && payload[p] !== 0) p++;
                p++;
                text = payload.slice(p).toString('utf8');
            } else {
                text = latin1ToString(payload);
            }
            const json = JSON.parse(atobSafe(text));
            return { card: json, chunks, text };
        }
        throw new Error('PNG 中未找到 chara 文本块');
    }

    function atobSafe(b64) {
        if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
        // 浏览器：手动 base64 解码（兼容 UTF-8）
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    function btoaSafe(str) {
        if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        return btoa(bin);
    }

    function toBase64(str) {
        return typeof Buffer !== 'undefined' ? Buffer.from(String(str), 'utf8').toString('base64') : btoaSafe(str);
    }

    // 把新角色卡写回 PNG（替换原 chara 块，无则插入 IEND 前）
    function writeCardPng(originalBuffer, card) {
        const chunks = readPngChunks(originalBuffer);
        const charaText = btoaSafe(JSON.stringify(card));
        const type = chunks.some(c => c.type === 'tEXt') ? 'tEXt' : 'iTXt';
        const hasBuffer = typeof Buffer !== 'undefined';
        const keyword = hasBuffer ? Buffer.from('chara', 'latin1') : new TextEncoder().encode('chara');
        const payload = type === 'tEXt'
            ? concatBytes(keyword, new Uint8Array([0]), hasBuffer ? Buffer.from(charaText, 'latin1') : new TextEncoder().encode(charaText))
            : concatBytes(keyword, new Uint8Array([0, 0, 0, 0, 0]), new TextEncoder().encode(charaText));
        const chunkData = buildChunk(type, payload);
        const out = [];
        out.push(originalBuffer.slice(0, 8));
        let replaced = false;
        for (const chunk of chunks) {
            if (!replaced && (chunk.type === 'tEXt' || chunk.type === 'iTXt')) {
                const nul = chunk.data.indexOf(0);
                if (nul !== -1 && chunk.data.slice(0, nul).toString('latin1') === 'chara') {
                    out.push(chunkData);
                    replaced = true;
                    continue;
                }
            }
            out.push(originalBuffer.slice(chunk.offset, chunk.offset + 12 + chunk.data.length));
        }
        if (!replaced) out.push(chunkData);
        return concatBytes(...out);
    }

    function concatBytes(...arrays) {
        const total = arrays.reduce((n, a) => n + a.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) {
            out.set(a, off);
            off += a.length;
        }
        return out;
    }

    function buildChunk(type, data) {
        const len = data.length;
        const header = new Uint8Array(8);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, len);
        for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
        const crcBuf = concatBytes(header.slice(4), data);
        const crc = new Uint8Array(4);
        new DataView(crc.buffer).setUint32(0, crc32(crcBuf));
        return concatBytes(header, data, crc);
    }

    /* ================================================================
     * 卡解析（JSON / PNG 统一入口）
     * ================================================================ */

    function parseCard(input) {
        // input: 已解析对象 或 JSON 字符串 或 ArrayBuffer/Uint8Array/Buffer（PNG）
        if (input && typeof input === 'object' && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
            if (input.spec || input.data || input.name) return deepClone(input);
            throw new Error('无法识别的角色卡对象');
        }
        if (typeof input === 'string') {
            const t = input.trim();
            if (t.startsWith('{')) return JSON.parse(t);
            throw new Error('JSON 字符串无法解析为角色卡');
        }
        const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength || input.length);
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
            return parseCardPng(buf).card;
        }
        throw new Error('输入既不是 JSON 角色卡也不是 PNG 角色卡');
    }

    /* ================================================================
     * 状态栏 / 脚本用法扫描
     * 从卡内的状态栏 HTML、脚本、开场白中提取每个顶层组的字段访问，
     * 用于给“空字典组”推导列名（组内没有初始字段时）。
     * ================================================================ */

    const STATUS_SOURCE_NAMES = ['状态栏', 'status', '数据桥', '面板'];

    /**
     * 解析 [mvu_update] 条目中的全部 MVU 规则（结构声明 + 数值范围 + 枚举 + 格式 + 强制更新提醒）。
     * 例如（组名与字段均为任意中文/含$名称）：
     *   组A:
     *     type: "{ [条目名]: { 字段1, 字段2, ... } }"
     *   组B:
     *     字段X:
     *       type: number
     *       range: 0~100
     *     字段Y: "值1/值2/值3"
     *   组C:
     *     _强制更新提醒:
     *       - 组C.字段Z — 每次回复后更新
     * 返回：
     *   shapes: { 组名: [字段...] }
     *   objects: { 组名: { 字段: true } }
     *   ranges: { 字段名: [lo, hi] }
     *   enums: { 字段名: [值...] }
     *   formats: { 组名: { 字段名: 文本 } }
     *   checks: { 组名: { 字段名: [行...] } }
     *   reminders: { 组名: [行...] }
     *   numericFields: Set<字段名>
     */
    function parseMvuShapes(card) {
        const d = card.data || card;
        const entries = (d.character_book && d.character_book.entries) || [];
        const shapes = {};
        const objects = {};
        const ranges = {};
        const enums = {};
        const formats = {};
        const checks = {};
        const reminders = {};
        const numericFields = new Set();
        const allContents = [];
        const allCheckItems = [];
        for (const e of entries) {
            const comment = String(e.comment || '');
            const content = String(e.content || '');
            if (!/\[mvu[ _-]?update\]|\[mvuupdate\]/i.test(comment) && !/变量更新规则|变量输出格式/.test(comment) && !/mvu/i.test(comment)) continue;
            allContents.push(content);
            // 顶层组：缩进 ≤2 的中文/含$组名
            const groupRe = /(?:^|\n)( {0,2})([\u4e00-\u9fff$]{1,12})[ \t]*:[ \t]*\n/g;
            const matches = [];
            let gm;
            while ((gm = groupRe.exec(content))) {
                matches.push({ name: gm[2], index: gm.index + gm[0].length });
            }
            for (let mi = 0; mi < matches.length; mi++) {
                const group = matches[mi].name;
                const start = matches[mi].index;
                const end = mi + 1 < matches.length ? matches[mi + 1].index - 1 : content.length;
                const section = content.slice(start, end);

                // 字段级规则：缩进 4 的 key 行开始，直到下一个同级 key
                const fieldRe = /(?:^|\n)( {4})([^\n:]{1,24}?)[ \t]*:[ \t]*([^\n]*)$/gm;
                const fieldStarts = [];
                let fm;
                while ((fm = fieldRe.exec(section))) {
                    const field = fm[2].trim().replace(/^["']|["']$/g, '');
                    if (!/^[\u4e00-\u9fff$]{1,12}$/.test(field) && !/^\$\{[^}]+\}$/.test(field)) continue;
                    fieldStarts.push({ field, index: fm.index + fm[0].length, inline: fm[3].trim(), at: fm.index });
                }
                for (let fi = 0; fi < fieldStarts.length; fi++) {
                    const { field, index, inline } = fieldStarts[fi];
                    const next = fi + 1 < fieldStarts.length ? fieldStarts[fi + 1].at : section.length;
                    const block = section.slice(index, next);
                    if (field === '_强制更新提醒' || field === '_强制更新') {
                        reminders[group] = extractListItems(block);
                        continue;
                    }
                    // 展开 ${A|B|C} 多字段模板键
                    const fieldNames = [];
                    if (field.includes('|')) {
                        for (const part of field.replace(/^\$\{/, '').replace(/\}$/, '').split('|')) {
                            const p = part.trim();
                            if (/^[\u4e00-\u9fff]{1,12}$/.test(p)) fieldNames.push(p);
                        }
                    }
                    if (!fieldNames.length) fieldNames.push(field);
                    const rangeM = block.match(/range\s*:\s*([\d.]+)\s*[~-]\s*([\d.]+)/);
                    for (const fn of fieldNames) {
                        if (rangeM) ranges[fn] = [Number(rangeM[1]), Number(rangeM[2])];
                        if (/type\s*:\s*number/.test(block)) numericFields.add(fn);
                        if (rangeM) numericFields.add(fn);
                    }
                    const typeLine = block.match(/type\s*:\s*"([\s\S]*?)"\s*$/m);
                    const typeBlock = block.match(/type\s*:\s*\|-?\s*\n([\s\S]*?)(?=\n\s*\S|$)/);
                    if (typeLine) {
                        const parsed = parseShapeString(typeLine[1]);
                        if (parsed) {
                            const target = /^\[.*?\]\s*:/.test(typeLine[1]) || /^\{[^}]*:\s*\{/.test(typeLine[1]) ? field : group;
                            shapes[target] = shapes[target] || [];
                            for (const f2 of parsed.fields) if (!shapes[target].includes(f2)) shapes[target].push(f2);
                            if (parsed.objects.length) {
                                objects[target] = objects[target] || {};
                                for (const obj of parsed.objects) objects[target][obj] = true;
                            }
                            if (target === group) {
                                if (!shapes[group].includes(field)) shapes[group].push(field);
                                objects[group] = objects[group] || {};
                                objects[group][field] = true;
                            }
                        }
                    } else if (typeBlock) {
                        const parsed = parseShapeString(typeBlock[1]);
                        if (parsed) {
                            const target = /^\{[^}]*:\s*\{/.test(typeBlock[1]) || /^\[.*?\]\s*:/.test(typeBlock[1]) ? field : group;
                            shapes[target] = shapes[target] || [];
                            for (const f2 of parsed.fields) if (!shapes[target].includes(f2)) shapes[target].push(f2);
                            if (parsed.objects.length) {
                                objects[target] = objects[target] || {};
                                for (const obj of parsed.objects) objects[target][obj] = true;
                            }
                        }
                    }
                    const formatM = block.match(/format\s*:\s*["']([\s\S]*?)["']\s*$/m);
                    if (formatM) {
                        formats[group] = formats[group] || {};
                        for (const fn of fieldNames) formats[group][fn] = formatM[1].trim();
                    }
                    const checkM = block.match(/check\s*:\s*(""?[\s\S]*?)(?=\n {4}[^\n:]{1,24}?:\s*|\n {2}\S|$)/);
                    if (checkM) {
                        const items = extractListItems(checkM[1]);
                        if (items.length) {
                            checks[group] = checks[group] || {};
                            for (const fn of fieldNames) checks[group][fn] = items;
                        }
                    }
                    // 行内枚举值（危机程度: "无/低/中/高/致命"）
                    if (inline && !block.includes('type') && !block.includes('range') && !block.includes('format') && !block.includes('check')) {
                        const vals = String(inline).replace(/^["']|["']$/g, '').split(/[/|]/).map(s => s.trim()).filter(Boolean);
                        if (vals.length >= 2 && vals.length <= 12) {
                            for (const fn of fieldNames) enums[fn] = vals;
                        }
                    }
                }
                // 组级 type 声明（形如 组名: type: "{...}"）
                const groupCheckM = section.match(/\n {4}check\s*:\s*\n([\s\S]*?)(?=\n {4}[^\n:]{1,24}?[ \t]*:|\n {2}\S|$)/);
                if (groupCheckM) allCheckItems.push(...extractListItems(groupCheckM[1]));
                let shapeStr = null;
                if (!/^\s*type\s*:/.test(section)) continue; // 该组没有直接 type 声明（字段由 initvar 提供）
                const q = section.match(/type\s*:\s*"([\s\S]*?)"\s*$/m);
                const b = section.match(/type\s*:\s*\|-?\s*\n([\s\S]*?)(?=\n\s*\S|$)/);
                if (q) shapeStr = q[1];
                else if (b) shapeStr = b[1];
                if (!shapeStr) continue;
                const parsed = parseShapeString(shapeStr);
                if (parsed) {
                    shapes[group] = shapes[group] || [];
                    for (const f2 of parsed.fields) if (!shapes[group].includes(f2)) shapes[group].push(f2);
                    if (parsed.objects.length) objects[group] = objects[group] || {};
                    for (const objField of parsed.objects) objects[group][objField] = true;
                }
            }
        }
        // 从 check 文本提取 “字段(0~100)” 式范围（如 亲密(0~100)）
        for (const group of Object.keys(checks)) {
            for (const field of Object.keys(checks[group])) {
                allCheckItems.push(...checks[group][field]);
            }
        }
        for (const line of allCheckItems) {
            const rm = line.match(/([\u4e00-\u9fff]{1,8})\((\d+)~(\d+)\)/);
            if (rm && !ranges[rm[1]]) {
                ranges[rm[1]] = [Number(rm[2]), Number(rm[3])];
                numericFields.add(rm[1]);
            }
        }
        // 全局 _强制更新提醒（通常在 变量更新规则 顶层，缩进 2）：按 “组.字段” 前缀归属组
        const rmRe = /_强制更新提醒\s*:\s*\n([\s\S]*?)(?=\n\s{0,2}[\u4e00-\u9fff$]{1,12}:[ \t]*\n|\n\s{4}[\u4e00-\u9fff$]{1,12}:[ \t]*\n|$)/;
        const rmM = allContents.join('\n').match(rmRe);
        if (rmM) {
            for (const item of extractListItems(rmM[1])) {
                const prefix = item.match(/^([\u4e00-\u9fff$]{1,12})\./);
                const target = prefix ? prefix[1] : String(item).split(/[ —:：-]/)[0].trim();
                if (/^[\u4e00-\u9fff$]{1,12}$/.test(target)) {
                    reminders[target] = reminders[target] || [];
                    if (!reminders[target].includes(item)) reminders[target].push(item);
                }
            }
        }
        return { shapes, objects, ranges, enums, formats, checks, reminders, numericFields };
    }

    // 从 YAML 片段提取 “- xxx” 列表项
    function extractListItems(text) {
        const items = [];
        const re = /(?:^|\n)\s*-\s+([^\n]+)/g;
        let m;
        while ((m = re.exec(text))) items.push(m[1].trim());
        return items;
    }

    // 解析 "{ [动态键]: { 字段, 字段, 嵌套: { ... } } }" 形状字符串
    function parseShapeString(shapeStr) {
        let s = String(shapeStr || '').trim();
        if (!/^\{/.test(s)) return null;
        let depth = 0;
        const fields = [];
        const objects = [];
        let i = 0;
        let buf = '';
        let inBracket = false;
        let hasDynamicKey = false;
        const collectDepth = () => (hasDynamicKey ? 2 : 1);
        function flushField() {
            const t = buf.trim();
            buf = '';
            if (!t) return;
            let name = t.replace(/^\[.*?\]\s*:\s*/, '').trim();
            name = name.split(':')[0].replace(/^["']|["']$/g, '').trim();
            if (name && /^[\u4e00-\u9fff]{1,12}$/.test(name) && !fields.includes(name)) fields.push(name);
        }
        for (; i < s.length; i++) {
            const ch = s[i];
            if (ch === '{') {
                if (depth > 0) {
                    // 嵌套对象字段：buf 末尾的 key 记为对象字段
                    const rawKey = buf.trim();
                    const key = rawKey.replace(/^["']|["']$/g, '').split(':')[0].trim();
                    if (depth === 1 && /^\[.*\]$/.test(key)) {
                        hasDynamicKey = true; // { [动态键]: { ... } }
                    } else if (key && /^[\u4e00-\u9fff]{1,12}$/.test(key) && depth >= collectDepth()) {
                        if (!fields.includes(key)) fields.push(key);
                        if (!objects.includes(key)) objects.push(key);
                    }
                    buf = '';
                }
                depth++;
                continue;
            }
            if (ch === '}') {
                if (depth === collectDepth()) flushField();
                depth = Math.max(0, depth - 1);
                if (depth === 0) {
                    break;
                }
                continue;
            }
            if (ch === '[') { inBracket = true; buf += ch; continue; }
            if (ch === ']') { inBracket = false; buf += ch; continue; }
            if (inBracket) { buf += ch; continue; }
            if (ch === ',') {
                if (depth === collectDepth()) flushField();
                continue;
            }
            buf += ch;
        }
        if (depth === collectDepth()) flushField();
        return { fields, objects };
    }

    function cardTextBlobs(card) {
        const blobs = [];
        const d = card.data || card;
        const push = (label, text) => { if (text) blobs.push({ label, text: String(text) }); };
        const ext = d.extensions || {};
        (ext.regex_scripts || []).forEach((r, i) => {
            push(`regex:${r.scriptName || i}`, (r.replaceString || '') + '\n' + (r.findRegex || ''));
        });
        const th = ext.tavern_helper || {};
        (th.scripts || []).forEach((s, i) => push(`script:${s.name || i}`, s.content || ''));
        push('first_mes', d.first_mes);
        (d.alternate_greetings || []).forEach((g, i) => push(`greeting:${i}`, g));
        (d.character_book?.entries || []).forEach((e, i) => push(`lore:${e.comment || i}`, e.content || ''));
        return blobs;
    }

    /**
     * 扫描卡片文本，返回 { group: [字段名...] }。
     * 规则：
     *  1. `const X = stat.组名` / `const X = (stat.组名||{})[键]` 建立 变量→组 映射
     *  2. `const X = <已映射>.子表名` → X 计入子表组
     *  3. `X.字段` 访问计入该组
     *  4. `Object.entries(X)...forEach(([k, item]) => ... item.字段 ...)` 计入 X 的组
     *  5. 直接赋值给组的对象字面量键计入该组（如 stat.组[键] = { 字段: ... }）
     */
    function scanStatusUsage(card, groupNames) {
        const usage = {};
        const addField = (group, field) => {
            if (!field || !/^[\u4e00-\u9fff]{1,12}$/.test(field)) return;
            if (!usage[group]) usage[group] = [];
            if (!usage[group].includes(field)) usage[group].push(field);
        };

        // 已知组名来自 initvar 顶层键（扫描只针对这些组做归属）
        const knownGroups = new Set(Array.isArray(groupNames) ? groupNames : []);

        const blobs = cardTextBlobs(card);
        const varToGroup = {};
        // 嵌套对象变量：var → { group, field }，表示 var 是 group[field] 的对象值
        const nestedVar = {};
        // entries 数组变量：var = Object.entries(组变量)
        const entriesArrayVars = new Set();

        // 阶段1：直接 stat 映射（只跑一轮即可稳定）
        for (const { text } of blobs) {
            // const X = ...stat_data.组[键].字段...  → 嵌套对象；只到组 → 组变量
            const re1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:all_variables|getAllVariables\(\))?[^;\n]*?\bstat_data\s*\.\s*([\u4e00-\u9fff]+)((?:\[[^\]]*\])*)((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
            let m;
            while ((m = re1.exec(text))) {
                const v = m[1], g = m[2];
                if (!knownGroups.has(g)) continue;
                const tail = (m[4] || '').trim();
                if (tail === '') varToGroup[v] = g;
                else nestedVar[v] = { group: g, field: tail.replace(/^\s*\.\s*/, '') };
            }
            // const X = stat.组 / const X = (stat.组 || {})[键] / const X = stat.组[键]
            const re1b = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(?\s*stat\s*\.\s*([\u4e00-\u9fff]+)\s*\)?|stat\s*\.\s*([\u4e00-\u9fff]+))\s*(?:\|\|\s*\{\}\s*)?(\[[^\]]*\])?((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
            while ((m = re1b.exec(text))) {
                const g = m[2] || m[3];
                if (!knownGroups.has(g)) continue;
                const tail = (m[5] || '').trim();
                if (tail === '') varToGroup[m[1]] = g;
                else nestedVar[m[1]] = { group: g, field: tail.replace(/^\s*\.\s*/, '') };
            }
            // const X = <已映射>.子表名
            const re1c = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*([\u4e00-\u9fff]+)/g;
            while ((m = re1c.exec(text))) {
                const parentGroup = varToGroup[m[2]];
                if (parentGroup) varToGroup[m[1]] = m[3];
            }
            // const X = Object.entries(Y)（如 sortedBeauties）
            const re1d = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Object\s*\.\s*entries\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
            while ((m = re1d.exec(text))) {
                const srcGroup = varToGroup[m[2]];
                if (srcGroup && knownGroups.has(srcGroup)) {
                    varToGroup[m[1]] = srcGroup;
                    entriesArrayVars.add(m[1]);
                }
            }
        }

        // 阶段2：多轮解析 forEach 条目（用于推导 itemVar 字段与嵌套变量）
        const forEachBlocks = [];
        for (const { text } of blobs) {
            const re4 = /Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)(?:\s*\.\s*[A-Za-z_$][\w$]*\s*\((?:[^()]|\([^()]*\))*\))*\s*\.(?:forEach|map)\(\s*\(\s*\[[^,\]]+,\s*([A-Za-z_$][\w$]*)\]\)\s*=>\s*\{?([\s\S]{0,4000}?)\n\s*\}\);/g;
            let m;
            while ((m = re4.exec(text))) {
                forEachBlocks.push({ srcVar: m[1], itemVar: m[2], body: m[3] });
            }
            // 已映射的 entries 数组变量直接 .forEach（如 sortedBeauties.forEach）
            const re4b = /([A-Za-z_$][\w$]*)\.(?:forEach|map)\(\s*\(\s*\[[^,\]]+,\s*([A-Za-z_$][\w$]*)\]\)\s*=>\s*\{?([\s\S]{0,4000}?)\n\s*\}\);/g;
            while ((m = re4b.exec(text))) {
                if (entriesArrayVars.has(m[1])) {
                    forEachBlocks.push({ srcVar: m[1], itemVar: m[2], body: m[3] });
                }
            }
        }
        let changed = true;
        let round = 0;
        while (changed && round++ < 5) {
            changed = false;
            for (const block of forEachBlocks) {
                const group = varToGroup[block.srcVar];
                if (nestedVar[block.srcVar]) continue; // 嵌套对象不归组
                if (!group) continue;
                // 推导嵌套变量：const Y = itemVar.字段（如 const history = data.历史记录）
                const nestedRe = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:' + block.itemVar + '|data)\\.([\\u4e00-\\u9fff]{1,12})', 'g');
                let nm;
                while ((nm = nestedRe.exec(block.body))) {
                    if (!nestedVar[nm[1]]) {
                        nestedVar[nm[1]] = { group, field: nm[2] };
                        changed = true;
                    }
                }
            }
        }

        // 阶段3：成员访问收集（跳过嵌套对象变量）
        for (const { text } of blobs) {
            const re2 = /([A-Za-z_$][\w$]*)\.([\u4e00-\u9fff]{1,12})/g;
            let m;
            while ((m = re2.exec(text))) {
                const v = m[1], field = m[2];
                if (nestedVar[v]) continue; // 嵌套对象内部字段（如 record.发送者）不作为顶层列
                const group = varToGroup[v];
                if (group) addField(group, field);
                else if (knownGroups.has(v)) addField(v, field);
            }
        }

        // 阶段4：forEach 条目字段（data.数量 之类），嵌套对象变量跳过
        for (const block of forEachBlocks) {
            const group = varToGroup[block.srcVar];
            if (!group || nestedVar[block.srcVar]) continue;
            const reItem = new RegExp('(?:' + block.itemVar + '|data)\\.([\\u4e00-\\u9fff]{1,12})', 'g');
            let im;
            while ((im = reItem.exec(block.body))) {
                if (nestedVar[im[0].split('.')[0]]) continue;
                addField(group, im[1]);
            }
        }

        // 阶段4：直接赋值给组/组变量的对象字面量键
        // 形如：stat.组[键] = { 字段: ... }
        for (const { text } of blobs) {
            const assignRe = /stat_data\s*\.\s*([\u4e00-\u9fff]+)(?:\s*\[[^\]]*\])*(?:\s*\.\s*[\u4e00-\u9fff]+)?\s*=\s*\{([^{}]*)\}/g;
            let m;
            while ((m = assignRe.exec(text))) {
                const g = m[1];
                if (!knownGroups.has(g)) continue;
                const literal = m[2];
                const keyRe = /["']?([\u4e00-\u9fff]{1,12})["']?\s*:/g;
                let km;
                while ((km = keyRe.exec(literal))) {
                    if (!knownGroups.has(km[1])) addField(g, km[1]);
                }
            }
        }

        // 清理：去掉明显不是字段的词
        const stop = new Set(['length', 'forEach', 'map', 'filter', 'reduce', 'keys', 'values', 'entries', 'push', 'indexOf', 'includes', 'slice', 'join', 'split', 'trim', 'replace', 'toLowerCase', 'toUpperCase', 'some', 'every', 'find', 'string', 'number', 'boolean']);
        for (const g of Object.keys(usage)) {
            usage[g] = usage[g].filter(f => !stop.has(f) && !usage[g].includes(f) ? true : !stop.has(f));
            usage[g] = [...new Set(usage[g])];
        }
        return usage;
    }

    /* ================================================================
     * Schema 生成：变量树 → 表/列/行
     * ================================================================ */

    function isLeaf(v) {
        return v === null || typeof v !== 'object' || Array.isArray(v);
    }

    /**
     * 解析一层变量对象，返回列定义列表。
     * 每列: { zh, path, value, desc, type, range }
     * path 是 stat_data 下的完整路径数组（供数据桥重建 + EJS 重写用）。
     */
    function collectColumns(obj, prefixPath, report, opts = {}) {
        const cols = [];
        const usedIdents = new Set(['row_id']);
        for (const key of Object.keys(obj)) {
            const v = obj[key];
            const li = leafInfo(v);
            const path = [...prefixPath, key];
            if (isLeaf(v)) {
                cols.push({
                    zh: key,
                    path,
                    value: li.value,
                    desc: li.desc || '',
                    type: inferType(li.value),
                    range: null,
                    ident: toIdent(key, usedIdents, 'column'),
                    isPair: Array.isArray(v),
                });
                continue;
            }
            // 对象：判断是固定子对象还是条目字典
            const values = Object.values(v);
            const allLeaf = values.length > 0 && values.every(x => isLeaf(x));
            if (allLeaf) {
                // 固定子对象 → 展平：key+子键
                for (const subKey of Object.keys(v)) {
                    const sv = v[subKey];
                    const sli = leafInfo(sv);
                    const flatZh = key + subKey;
                    cols.push({
                        zh: flatZh,
                        path: [...path, subKey],
                        value: sli.value,
                        desc: sli.desc || '',
                        type: inferType(sli.value),
                        range: null,
                        ident: toIdent(flatZh, usedIdents, 'column'),
                    });
                }
            } else {
                // 条目字典或空对象 → 记为子行表
                if (opts.childTables) {
                    opts.childTables.push({ key, value: v, path });
                } else {
                    report.warn(`发现嵌套对象「${key}」，需拆分为子行表（当前未启用子表提取）`, 'schema');
                }
            }
        }
        return cols;
    }

    function inferType(value) {
        if (typeof value === 'number') return 'INTEGER';
        if (typeof value === 'boolean') return 'INTEGER';
        return 'TEXT';
    }

    // 把“条目内嵌套对象”转成 JSON 列
    function jsonColumnFromObject(key, obj, path, usedIdents) {
        let value = obj;
        let desc = '';
        if (Array.isArray(obj)) {
            const li = leafInfo(obj);
            value = li.value;
            desc = li.desc || '';
            if (typeof value === 'object' && value !== null) {
                try { value = JSON.stringify(value); } catch (e) { value = String(value); }
            }
            return {
                zh: key,
                path,
                value,
                desc,
                type: 'TEXT',
                range: null,
                ident: toIdent(key, usedIdents, 'column'),
                isObject: false,
                isPair: true,
            };
        }
        try {
            value = JSON.stringify(obj);
        } catch (e) {
            value = String(obj);
        }
        return {
            zh: key,
            path,
            value,
            desc: desc || '对象（JSON 存储，读取时还原）',
            type: 'TEXT',
            range: null,
            ident: toIdent(key, usedIdents, 'column'),
            isObject: true,
        };
    }

    /**
     * 主入口：initvar → schema
     * schema = { groups: [ { name, tableName, ident, kind, keyCol, keyValue, columns, rows, childTables, source, parentGroup } ] }
     */
    function buildSchema(initvar, usage, report, shapeInfo) {
        const groups = [];
        const seenTables = new Set();
        const usedTableIdents = new Set();
        const shapes = (shapeInfo && shapeInfo.shapes) || {};
        const shapeObjects = (shapeInfo && shapeInfo.objects) || {};
        const ruleRanges = (shapeInfo && shapeInfo.ranges) || {};
        const ruleEnums = (shapeInfo && shapeInfo.enums) || {};
        const ruleFormats = (shapeInfo && shapeInfo.formats) || {};
        const ruleChecks = (shapeInfo && shapeInfo.checks) || {};
        const ruleReminders = (shapeInfo && shapeInfo.reminders) || {};
        const ruleNumeric = (shapeInfo && shapeInfo.numericFields) || new Set();
        const groupNameSet = new Set(Object.keys(initvar));

        // 通用表种类推导：
        //  - 组自身有直接标量字段 → 单例（嵌套对象是子对象字段，如 主角.炼丹.阶级）
        //  - 无直接标量字段且全部为对象 → 条目字典 → 行表（如 道侣.{林若悠:{亲密:88}}）
        //  - 空字典 / 数组 → 行表 / 数组表
        function deriveKind(groupName, raw) {
            const values = Object.values(raw);
            if (values.length === 0) {
                report.note(`顶层组「${groupName}」初始为空字典，按行表处理；若它本应是单例表请人工调整。`);
                return 'rows';
            }
            const leaves = values.filter(v => isLeaf(v)).length;
            if (leaves > 0) return 'singleton';
            if (values.every(v => isPlainObject(v))) return 'rows';
            return 'singleton';
        }

        function fieldRange(field) {
            return ruleRanges[field] || null;
        }

        function fieldIsNumeric(field, value) {
            if (ruleNumeric.has(field)) return true;
            return typeof value === 'number';
        }

        function makeGroupTableName(groupName) {
            return `${groupName}表`;
        }

        for (const groupName of Object.keys(initvar)) {
            if (groupName === '$meta') {
                report.note(`已跳过 MVU 保留元数据组「$meta」（strictTemplate 等），不生成表格。`);
                continue;
            }
            const raw = initvar[groupName];
            if (!isPlainObject(raw)) {
                // 顶层非对象（数组/标量）：按数组表或行表处理
                if (raw !== null) {
                    const tableName = makeGroupTableName(groupName);
                    const keyCol = '名称';
                    const isArray = Array.isArray(raw);
                    const cols = [{ zh: keyCol, path: [groupName], value: '', desc: '', type: 'TEXT', ident: toIdent(keyCol, new Set(['row_id']), 'column') }];
                    const rows = isArray
                        ? raw.map((item, i) => [i + 1, item === null || item === undefined ? '' : String(item)])
                        : [];
                    if (isArray && raw.length && typeof raw[0] === 'object') {
                        report.warn(`顶层变量「${groupName}」为对象数组，已按字符串列转换，请人工核对`, 'schema');
                    }
                    groups.push({
                        name: groupName,
                        tableName,
                        ident: toIdent(tableName, usedTableIdents, 'table'),
                        kind: isArray ? 'array' : 'rows',
                        keyCol,
                        keyValue: '',
                        columns: cols,
                        rows,
                        childTables: [],
                        source: 'top-level-array',
                    });
                    seenTables.add(tableName);
                    continue;
                }
                report.warn(`顶层变量「${groupName}」不是对象，跳过`, 'schema');
                continue;
            }

            const kind = deriveKind(groupName, raw);
            const tableName = makeGroupTableName(groupName);
            if (seenTables.has(tableName)) {
                report.warn(`表名「${tableName}」重复（组「${groupName}」），追加序号`, 'schema');
            }
            seenTables.add(tableName);

            const keyCol = '名称';
            const childTables = [];
            const prefixPath = [groupName];
            // 行表的列由下方 rows 分支从条目字段构造（嵌套对象统一转 JSON 列）；
            // 不从顶层收集子表，避免“每角色一张字段相同的重复表”。
            const columns = kind === 'rows'
                ? []
                : collectColumns(raw, prefixPath, report, { childTables });

            let rows = [];
            if (kind === 'rows') {
                // 条目字典 → 每条目一行
                const fieldOrder = [];
                const entryRows = [];
                const objFields = new Set();
                const pairFields = new Set();
                const fieldDescs = {};
                let sawScalarEntries = false;
                let scalarIsNumber = false;
                for (const entryName of Object.keys(raw)) {
                    const entry = raw[entryName];
                    if (!isPlainObject(entry)) {
                        sawScalarEntries = true;
                        scalarIsNumber = scalarIsNumber || typeof entry === 'number';
                        entryRows.push({ [keyCol]: entryName, value: entry, __scalar: true });
                        continue;
                    }
                    const entryCols = [];
                    const entryUsed = new Set(['row_id']);
                    for (const subKey of Object.keys(entry)) {
                        const sv = entry[subKey];
                        const spath = [...prefixPath, entryName, subKey];
                        if (isLeaf(sv)) {
                            const li = leafInfo(sv);
                            if (Array.isArray(sv)) pairFields.add(subKey);
                            if (li.desc && !fieldDescs[subKey]) fieldDescs[subKey] = li.desc;
                            entryCols.push({
                                zh: subKey,
                                path: spath,
                                value: li.value,
                                desc: li.desc || '',
                                type: inferType(li.value),
                                range: null,
                                ident: toIdent(subKey, entryUsed, 'column'),
                                isObject: false,
                                isPair: Array.isArray(sv),
                            });
                        } else {
                            entryCols.push(jsonColumnFromObject(subKey, sv, spath, entryUsed));
                            objFields.add(subKey);
                            if (!fieldDescs[subKey]) fieldDescs[subKey] = '对象（JSON 存储，读取时还原）';
                        }
                    }
                    for (const c of entryCols) {
                        if (!fieldOrder.includes(c.zh)) fieldOrder.push(c.zh);
                    }
                    const row = { [keyCol]: entryName };
                    for (const c of entryCols) row[c.zh] = c.value;
                    entryRows.push(row);
                }
                // 字段顺序：先 usage 里出现的，再条目里出现的
                const usageFields = (usage[groupName] || []).filter(f => f !== keyCol);
                const shapeFields = (shapes[groupName] || []).filter(f => f !== keyCol);
                const allFields = [...new Set([...shapeFields, ...usageFields, ...fieldOrder])];
                columns.length = 0;
                columns.push({ zh: keyCol, path: [groupName], value: '', desc: '条目名称', type: 'TEXT', ident: toIdent(keyCol, new Set(['row_id']), 'column') });
                const used = new Set(['row_id', columns[0].ident.toLowerCase()]);
                for (const f of allFields) {
                    columns.push({
                        zh: f,
                        path: [groupName, f],
                        value: '',
                        desc: fieldDescs[f] || '',
                        type: fieldIsNumeric(f, rowFirstValue(entryRows, f)) ? 'INTEGER' : inferType(rowFirstValue(entryRows, f)),
                        range: fieldRange(f),
                        ident: toIdent(f, used, 'column'),
                        isObject: objFields.has(f) || !!(shapeObjects[groupName] && shapeObjects[groupName][f]),
                        isPair: pairFields.has(f),
                    });
                }
                if (sawScalarEntries) {
                    const scalarZh = scalarIsNumber ? '数值' : '描述';
                    if (!columns.some(c => c.zh === scalarZh)) {
                        columns.push({
                            zh: scalarZh,
                            path: [groupName, scalarZh],
                            value: '',
                            desc: scalarIsNumber ? '条目数值' : '条目描述',
                            type: scalarIsNumber ? 'INTEGER' : 'TEXT',
                            range: null,
                            ident: toIdent(scalarZh, used, 'column'),
                        });
                    }
                    report.warn(`组「${groupName}」存在非对象条目（标量），已归入「${scalarZh}」列，请人工核对`, 'schema');
                }
                rows = entryRows.map(r => {
                    const rowArr = [r.__rowId || (columns.length + 1), r[keyCol]];
                    for (const c of columns.slice(1)) {
                        let v = r[c.zh];
                        if (v === undefined || v === null) v = '';
                        if (c.isObject && typeof v === 'object') {
                            try { v = JSON.stringify(v); } catch (e) { v = String(v); }
                        }
                        rowArr.push(v);
                    }
                    return rowArr;
                });
            } else {
                // 单例表：keyCol 首列 + initvar 字段 + usage 补充字段
                const keyValue = groupName;
                const used = new Set(['row_id']);
                columns.unshift({
                    zh: keyCol,
                    path: [groupName, keyCol],
                    value: keyValue,
                    desc: '唯一标识',
                    type: 'TEXT',
                    ident: toIdent(keyCol, used, 'column'),
                });
                for (const c of columns) {
                    if (c.ident) used.add(c.ident.toLowerCase());
                }
                // 单例组：跳过子表容器名与固定子对象内部键（如 炼丹.阶级 已展平为 炼丹阶级 列）
                const nestedSubKeys = new Set();
                for (const subKey of Object.keys(raw)) {
                    const sv = raw[subKey];
                    if (isPlainObject(sv) && Object.values(sv).every(x => isLeaf(x))) {
                        for (const k of Object.keys(sv)) nestedSubKeys.add(k);
                    }
                }
                const usageFields = (usage[groupName] || []).filter(f => (
                    f !== keyCol &&
                    !groupNameSet.has(f) &&
                    !childTables.some(ct => ct.key === f) &&
                    !nestedSubKeys.has(f) &&
                    !(isPlainObject(raw[f]) && Object.values(raw[f]).every(x => isLeaf(x)))
                ));
                for (const f of usageFields) {
                    if (columns.some(c => c.zh === f)) continue;
                    columns.push({
                        zh: f,
                        path: [groupName, f],
                        value: '',
                        desc: '',
                        type: 'TEXT',
                        range: fieldRange(f),
                        ident: toIdent(f, used, 'column'),
                    });
                }
                const rowArr = [1];
                for (const c of columns) rowArr.push(c.value === undefined ? '' : c.value);
                rows = [rowArr];
            }

            groups.push({
                name: groupName,
                tableName,
                ident: toIdent(tableName, usedTableIdents, 'table'),
                kind,
                keyCol,
                keyValue: kind === 'singleton' ? groupName : '',
                columns,
                rows,
                childTables,
                source: 'initvar',
                reminders: ruleReminders[groupName] || [],
            });
        }

        // 处理单例/行表内部的嵌套字典 → 子行表
        for (const g of groups) {
            for (const ct of g.childTables) {
                const tableName = makeGroupTableName(ct.key);
                const keyCol = '名称';
                const usageFields = (usage[ct.key] || []).filter(f => f !== keyCol);
                const shapeFields = (shapes[ct.key] || []).filter(f => f !== keyCol);
                const columns = [{ zh: keyCol, path: [...ct.path], value: '', desc: '条目名称', type: 'TEXT', ident: toIdent(keyCol, new Set(['row_id']), 'column') }];
                const used = new Set(['row_id', columns[0].ident.toLowerCase()]);
                const fieldOrder = [];
                const entryRows = [];
                let sawScalarEntries = false;
                let scalarIsNumber = false;
                if (isPlainObject(ct.value)) {
                    for (const entryName of Object.keys(ct.value)) {
                        const entry = ct.value[entryName];
                        if (!isPlainObject(entry)) {
                            sawScalarEntries = true;
                            scalarIsNumber = scalarIsNumber || typeof entry === 'number';
                            entryRows.push({ [keyCol]: entryName, value: entry, __scalar: true });
                            continue;
                        }
                        for (const subKey of Object.keys(entry)) {
                            if (!fieldOrder.includes(subKey)) fieldOrder.push(subKey);
                        }
                        const row = { [keyCol]: entryName };
                        for (const subKey of Object.keys(entry)) {
                            const sv = entry[subKey];
                            row[subKey] = isLeaf(sv) ? leafInfo(sv).value : JSON.stringify(sv);
                            if (!isLeaf(sv) && !columns.some(c => c.zh === subKey)) {
                                fieldOrder.push(subKey);
                            }
                        }
                        entryRows.push(row);
                    }
                }
                const allFields = [...new Set([...shapeFields, ...usageFields, ...fieldOrder])];
                for (const f of allFields) {
                    columns.push({
                        zh: f,
                        path: [...ct.path, f],
                        value: '',
                        desc: '',
                        type: fieldIsNumeric(f, rowFirstValue(entryRows, f)) ? 'INTEGER' : inferType(rowFirstValue(entryRows, f)),
                        range: fieldRange(f),
                        ident: toIdent(f, used, 'column'),
                        isObject: !!(shapeObjects[ct.key] && shapeObjects[ct.key][f]),
                    });
                }
                if (columns.length === 1) columns.push({
                    zh: '描述', path: [...ct.path, '描述'], value: '', desc: '条目描述', type: 'TEXT',
                    ident: toIdent('描述', used, 'column'),
                });
                if (sawScalarEntries) {
                    const scalarZh = scalarIsNumber ? '数值' : '描述';
                    if (!columns.some(c => c.zh === scalarZh)) {
                        columns.push({
                            zh: scalarZh,
                            path: [...ct.path, scalarZh],
                            value: '',
                            desc: scalarIsNumber ? '条目数值' : '条目描述',
                            type: scalarIsNumber ? 'INTEGER' : 'TEXT',
                            range: null,
                            ident: toIdent(scalarZh, used, 'column'),
                        });
                    }
                    report.warn(`子表「${ct.key}」存在非对象条目（标量），已归入「${scalarZh}」列，请人工核对`, 'schema');
                }
                const rows = entryRows.map(r => {
                    const rowArr = [r.__rowId || (columns.length + 1), r[keyCol]];
                    for (const c of columns.slice(1)) {
                        let v = r[c.zh];
                        if (v === undefined || v === null) v = '';
                        if (c.isObject && typeof v === 'object') {
                            try { v = JSON.stringify(v); } catch (e) { v = String(v); }
                        }
                        rowArr.push(v);
                    }
                    return rowArr;
                });
                groups.push({
                    name: ct.key,
                    tableName,
                    ident: toIdent(tableName, usedTableIdents, 'table'),
                    kind: 'rows',
                    keyCol,
                    keyValue: '',
                    columns,
                    rows,
                    childTables: [],
                    source: 'child-table',
                    parentGroup: g.name,
                    reminders: ruleReminders[ct.key] || [],
                });
            }
        }
        return attachFieldRules(groups, shapeInfo);
    }

    function rowFirstValue(entryRows, field) {
        for (const r of entryRows) {
            if (r[field] !== undefined && r[field] !== '') return r[field];
        }
        return '';
    }

    // 给每组列补上来自 [mvu_update] 规则的 枚举/格式/检查 说明（支持展平列，如 炼丹阶级 ← 阶级）
    function attachFieldRules(groups, shapeInfo) {
        const ruleEnums = (shapeInfo && shapeInfo.enums) || {};
        const ruleFormats = (shapeInfo && shapeInfo.formats) || {};
        const ruleChecks = (shapeInfo && shapeInfo.checks) || {};
        const ruleRanges = (shapeInfo && shapeInfo.ranges) || {};
        const ruleNumeric = (shapeInfo && shapeInfo.numericFields) || new Set();
        for (const g of groups) {
            const gFormats = ruleFormats[g.name] || {};
            const gChecks = ruleChecks[g.name] || {};
            for (const c of g.columns) {
                const last = c.path && c.path.length ? c.path[c.path.length - 1] : c.zh;
                c.enum = ruleEnums[c.zh] || ruleEnums[last] || null;
                c.format = gFormats[c.zh] || gFormats[last] || '';
                c.check = gChecks[c.zh] || gChecks[last] || [];
                if (!c.range && (ruleRanges[c.zh] || ruleRanges[last])) c.range = ruleRanges[c.zh] || ruleRanges[last];
                if (c.type !== 'INTEGER' && (ruleNumeric.has(c.zh) || ruleNumeric.has(last))) c.type = 'INTEGER';
            }
        }
        return groups;
    }

    /* ================================================================
     * 转换报告
     * ================================================================ */

    function createReport() {
        return {
            warnings: [],
            notes: [],
            autoRewrites: [],
            manualReview: [],
            warn(msg, tag) {
                this.warnings.push({ tag: tag || 'general', message: msg });
            },
            note(msg) {
                this.notes.push(msg);
            },
            auto(msg) {
                this.autoRewrites.push(msg);
            },
            manual(msg) {
                this.manualReview.push(msg);
            },
            toMarkdown() {
                const L = [];
                L.push('# MVU → 数据库 转换报告');
                L.push('');
                if (this.notes.length) {
                    L.push('## 说明');
                    this.notes.forEach(n => L.push(`- ${n}`));
                    L.push('');
                }
                if (this.autoRewrites.length) {
                    L.push('## 已自动转换');
                    this.autoRewrites.forEach(n => L.push(`- ${n}`));
                    L.push('');
                }
                if (this.manualReview.length) {
                    L.push('## 需人工处理');
                    this.manualReview.forEach(n => L.push(`- ${n}`));
                    L.push('');
                }
                if (this.warnings.length) {
                    L.push('## 警告');
                    this.warnings.forEach(w => L.push(`- [${w.tag}] ${w.message}`));
                    L.push('');
                }
                return L.join('\n');
            },
        };
    }

    /* ================================================================
     * Schema → 模板（generateTemplate）
     * ================================================================ */

    function sqlQuote(v) {
        return String(v == null ? '' : v).replace(/'/g, "''");
    }

    function buildDdl(group) {
        const L = [`CREATE TABLE ${group.ident} ( -- ${group.tableName}`];
        L.push(`  row_id INTEGER PRIMARY KEY, -- 行号`);
        const cols = group.columns || [];
        for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const isKey = i === 0 && group.kind === 'rows';
            const isSingletonKey = i === 0 && group.kind === 'singleton';
            let def = `  ${c.ident} ${c.type}`;
            const range = c.range || null;
            const extras = Array.isArray(group.extraAllowed && group.extraAllowed[c.ident]) ? group.extraAllowed[c.ident] : [];
            let dv = c.value;
            // 默认值若越界也加入放行列表（不修改初始值）
            if (range && typeof dv === 'number' && (dv < range[0] || dv > range[1]) && !extras.includes(dv)) extras.push(dv);
            if (c.type === 'INTEGER') {
                const num = dv === undefined || dv === null || dv === '' ? 0 : Number(dv);
                def += ` NOT NULL DEFAULT ${Number.isFinite(num) ? num : 0}`;
                if (isKey) def += ' UNIQUE';
                if (range) {
                    def += ` CHECK(${c.ident} BETWEEN ${range[0]} AND ${range[1]}`;
                    if (extras.length) def += ` OR ${c.ident} IN (${extras.join(', ')})`;
                    def += ')';
                }
            } else {
                let dvs = dv === undefined || dv === null ? '' : String(dv);
                if (c.isObject && dvs === '') dvs = '{}';
                def += ` NOT NULL DEFAULT '${sqlQuote(dvs)}'`;
                if (isKey) def += ' UNIQUE';
                // 枚举 CHECK：把默认值和越界初始值一并放行，避免初始行/默认值被拒绝
                if (c.enum && c.enum.length <= 8 && c.enum.every(v => !/['"]/.test(v))) {
                    const allowed = [...c.enum];
                    if (dvs !== '' && !allowed.includes(dvs)) allowed.push(dvs);
                    for (const ex of extras) if (!allowed.includes(ex)) allowed.push(ex);
                    def += ` CHECK(${c.ident} IN (${allowed.map(v => `'${sqlQuote(v)}'`).join(', ')}))`;
                }
            }
            if (isSingletonKey && group.keyValue) {
                def = def.replace(/DEFAULT '[^']*'/, `DEFAULT '${sqlQuote(group.keyValue)}'`);
            }
            // 插件校验要求 DDL 列注释与 content 表头逐字一致，描述只写进 note，不拼进注释；
            // 末列不加逗号，否则 sql.js 拒绝建表（SQLite 运行时回退原生模式）。
            def += (i < cols.length - 1 ? ',' : '') + ` -- ${c.zh}`;
            L.push(def);
        }
        L.push(');');
        return L.join('\n');
    }

    function describeGroup(group) {
        if (group.kind === 'singleton') {
            return `单例表，全表固定一条记录（${group.keyCol}='${group.keyValue}'），只做增量更新，不新增、不删除。`;
        }
        if (group.kind === 'array') {
            return '数组表，每行一个元素，通常整体替换。';
        }
        return `条目表，以「${group.keyCol}」为唯一标识；同名记录只存在一行，更新用 UPDATE，新增用 INSERT。`;
    }

    function buildNote(group) {
        const L = [];
        L.push(`${group.tableName}。${describeGroup(group)}`);
        if (group.kind === 'singleton' && group.rows.length) {
            L.push(`本表唯一记录已由开局模板插入（row_id=1，${group.keyCol}='${group.keyValue}'）；填表时禁止 INSERT / DELETE，只允许按需 UPDATE。`);
        }
        if (group.columns.length) {
            L.push('【列定义】');
            group.columns.forEach((c, i) => {
                let desc = c.desc ? String(c.desc).replace(/\n/g, ' ') : '';
                L.push(`- 列${i + 1}: ${c.zh} ${c.ident}${desc ? `（${desc}）` : ''}`);
            });
            L.push('【强制约束】');
            for (const c of group.columns) {
                const parts = [];
                if (c.range) parts.push(`数值范围 ${c.range[0]}~${c.range[1]}`);
                if (c.enum) parts.push(`可选值：${c.enum.join(' / ')}`);
                if (c.format) parts.push(`格式要求：${String(c.format).replace(/\n/g, ' ')}`);
                if (c.isObject) parts.push('对象以 JSON 存储，读取时还原');
                if (parts.length) L.push(`- ${c.zh}：${parts.join('；')}`);
                for (const rule of c.check || []) L.push(`- ${c.zh}：${rule}`);
            }
            for (const c of group.columns) {
                if (c.check && c.check.length > 20) L.push(`- ${c.zh}：…（共 ${c.check.length} 条规则，其余略）`);
            }
            (group.reminders || []).forEach(r => L.push(`- 每次回复必须维护：${r}`));
        }
        L.push('只在正文明确造成状态变化时更新对应字段；不得为凑表而虚构数据。');
        return L.join('\n');
    }

    function buildInitNode(group) {
        if (group.kind === 'singleton') {
            return `开局模板已包含唯一记录（row_id=1，${group.keyCol}='${group.keyValue}'）；自动填表阶段禁止再次初始化，只允许按需 UPDATE。`;
        }
        if (group.kind === 'array') {
            return group.rows.length
                ? `已在模板中初始化 ${group.rows.length} 个元素；此后按 updateNode 规则整体替换。`
                : '无（开局时由剧情按需填充）。';
        }
        if (group.rows.length) {
            const names = group.rows.slice(0, 5).map(r => r[1]).filter(Boolean).join('、');
            return `开局模板已初始化 ${group.rows.length} 条记录${names ? `（${names}${group.rows.length > 5 ? '…' : ''}）` : ''}；开局阶段如有新条目再按 insertNode 规则新增。`;
        }
        return '无（开局时由剧情按需插入首条记录）。';
    }

    function buildNodeProse(group, kind) {
        if (group.kind === 'singleton') {
            if (kind === 'update') return `只允许 UPDATE ${group.ident} SET ... WHERE ${group.keyCol}='${sqlQuote(group.keyValue)}'; 依正文明确变化更新对应字段。`;
            return '禁止。';
        }
        if (group.kind === 'array') {
            if (kind === 'update') return '每轮按最新剧情整体替换本表内容。';
            return '禁止（数组表不支持单行增删，整体替换）。';
        }
        const keyIdent = group.columns[0] ? group.columns[0].ident : 'key';
        const sampleCols = group.columns.slice(1, 4).map(c => c.ident);
        // 示例优先取卡内真实初始数据（与 MVU 提示词示例用具体值一致），无初始行时退回占位符
        const sampleRow = group.rows && group.rows[0] ? group.rows[0] : null;
        const sampleValue = (idx, fallback) => {
            if (sampleRow && sampleRow[idx] !== undefined && sampleRow[idx] !== null && String(sampleRow[idx]) !== '') {
                const col = group.columns[idx - 1];
                const isNum = col && col.type === 'INTEGER' && typeof sampleRow[idx] === 'number';
                return isNum ? String(sampleRow[idx]) : `'${sqlQuote(sampleRow[idx])}'`;
            }
            // 无初始数据：用“列中文名示例”占位，提示该列应填什么（不凭空造值）
            const col = group.columns[idx - 1];
            return col && col.zh ? `'${sqlQuote(col.zh)}示例'` : fallback;
        };
        const keyValue = (sampleRow && sampleRow[1] !== undefined && String(sampleRow[1]) !== '')
            ? `'${sqlQuote(sampleRow[1])}'`
            : "'条目名'";
        if (kind === 'update') {
            return `正文中对应条目的状态、数值或描述明确变化时，更新该记录对应字段。\nSQL示例: UPDATE ${group.ident} SET ${sampleCols[0] || '字段'} = ${sampleValue(2, "'新值'")} WHERE ${keyIdent} = ${keyValue};`;
        }
        if (kind === 'insert') {
            const cols = [keyIdent, ...sampleCols];
            // 列数与 VALUES 一一对应，避免示例语句列值数量不匹配
            const vals = cols.map((c, i) => (i === 0 ? keyValue : sampleValue(i + 1, `'值${i}'`)));
            return `正文中首次出现应记录的${group.keyCol}时，插入完整的新记录。\nSQL示例: INSERT INTO ${group.ident} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
        }
        return `仅在条目彻底离场、失效或不再需要追踪时移除记录。\nSQL示例: DELETE FROM ${group.ident} WHERE ${keyIdent} = ${keyValue};`;
    }

    /**
     * schema → 完整模板对象
     * mode: 'both' | 'native' | 'sqlite'
     */
    function generateTemplate(schema, opts = {}) {
        const mode = opts.mode || 'both';
        const report = opts.report || createReport();
        const template = {
            mate: {
                type: 'chatSheets',
                version: 1,
                updateConfigUiSentinel: -1,
                globalInjectionConfig: {},
            },
        };
        const order = {};
        schema.forEach((g, idx) => {
            // 统计每列“超出规则但必须放行”的初始值（不改动初始值，只放宽 CHECK）
            const extraAllowed = {};
            for (const c of g.columns) extraAllowed[c.ident] = [];
            for (const r of g.rows) {
                for (let ci = 0; ci < g.columns.length; ci++) {
                    const c = g.columns[ci];
                    const v = r[ci + 1];
                    if (c.range && typeof v === 'number' && (v < c.range[0] || v > c.range[1])) {
                        if (!extraAllowed[c.ident].includes(v)) extraAllowed[c.ident].push(v);
                    }
                    if (c.enum && c.enum.length && typeof v === 'string' && !c.enum.includes(v)) {
                        if (!extraAllowed[c.ident].includes(v)) extraAllowed[c.ident].push(v);
                    }
                }
            }
            g.extraAllowed = extraAllowed;
            // 归一化行号 1..N（初始值原样保留）
            const content = [['row_id', ...g.columns.map(c => c.zh)]];
            g.rows.forEach((r, ri) => {
                const row = [ri + 1];
                for (let ci = 0; ci < g.columns.length; ci++) {
                    row.push(r[ci + 1]);
                }
                content.push(row);
            });
            for (const c of g.columns) {
                if (extraAllowed[c.ident] && extraAllowed[c.ident].length) {
                    report.note(`「${g.tableName}」列「${c.zh}」初始值 ${extraAllowed[c.ident].map(v => JSON.stringify(v)).join('、')} 超出规则范围，CHECK 约束已放行这些初始值（数值/枚举规则仍写入 note）。`);
                }
            }
            const uid = 'sheet_' + g.ident;
            template[uid] = {
                uid,
                name: g.tableName,
                sourceData: {
                    note: buildNote(g),
                    initNode: buildInitNode(g),
                    deleteNode: buildNodeProse(g, 'delete'),
                    updateNode: buildNodeProse(g, 'update'),
                    insertNode: buildNodeProse(g, 'insert'),
                    ddl: buildDdl(g),
                },
                content,
                updateConfig: { skipFloors: -1 },
                exportConfig: { enabled: false, splitByRow: false },
                orderNo: idx,
            };
            order[uid] = idx;
        });
        return template;
    }

    /* ================================================================
     * Schema → 数据桥布局（buildLayout）
     * 用于：
     *  1. 生成卡内 getAllVariables() shim（DB 表格 → stat_data 嵌套形状）
     *  2. 生成 Mvu.replaceMvuData 反向写入（diff → updateCell/insertRow/deleteRow）
     *  3. EJS 条件重写时的路径 → 表/行/列 映射
     * ================================================================ */

    function columnLayoutType(c) {
        if (c.type === 'INTEGER') return 'number';
        if (c.isObject) return 'object';
        if (c.isPair) return 'pair';
        return 'text';
    }

    function buildLayout(schema) {
        const entries = [];
        const pathIndex = new Map();
        const tableByName = {};

        for (const g of schema) {
            tableByName[g.tableName] = g;
            if (g.kind === 'array') {
                const entry = {
                    kind: 'array',
                    group: g.name,
                    table: g.tableName,
                    keyCol: g.keyCol,
                    mirrors: [],
                };
                entries.push(entry);
                pathIndex.set(g.name, { table: g.tableName, kind: 'array' });
                continue;
            }
            if (g.kind === 'singleton') {
                const entry = {
                    kind: 'singleton',
                    group: g.name,
                    table: g.tableName,
                    keyCol: g.keyCol,
                    keyValue: g.keyValue,
                    cols: g.columns.map(c => ({
                        zh: c.zh,
                        type: columnLayoutType(c),
                        fallback: c.value === undefined || c.value === null ? '' : c.value,
                        path: c.path || [g.name, c.zh],
                        isPair: !!c.isPair,
                        desc: c.desc || '',
                    })),
                };
                entries.push(entry);
                for (const c of g.columns) {
                    pathIndex.set([g.name, c.zh].join('.'), { table: g.tableName, col: c.zh, rowKey: g.keyValue });
                }
                continue;
            }
            // rows（含子表）
            const writePaths = g.parentGroup ? [[g.parentGroup, g.name]] : [[g.name]];
            const entry = {
                kind: 'rows',
                group: g.name,
                table: g.tableName,
                keyCol: g.keyCol,
                cols: g.columns.map(c => ({
                    zh: c.zh,
                    type: columnLayoutType(c),
                    fallback: '',
                    isPair: !!c.isPair,
                    desc: c.desc || '',
                })),
                writePaths,
            };
            entries.push(entry);
            const colNames = g.columns.map(c => c.zh);
            if (g.parentGroup) {
                for (const c of colNames) {
                    pathIndex.set([g.parentGroup, g.name, c.zh].join('.'), { table: g.tableName, col: c.zh, rows: true, keyCol: g.keyCol });
                }
            } else {
                for (const c of colNames) {
                    pathIndex.set([g.name, c.zh].join('.'), { table: g.tableName, col: c.zh, rows: true, keyCol: g.keyCol });
                }
            }
        }
        return { entries, pathIndex, tableByName };
    }

    /* ================================================================
     * 卡内数据桥脚本生成（generateBridgeScript）
     * 输出一个自包含 tavern_helper 脚本：
     *  - 内嵌模板 base64
     *  - 表格为空时自动 importTemplateFromData({scope:'chat'})
     *  - getAllVariables() shim：DB 表格 → stat_data
     *  - Mvu.getMvuData / Mvu.replaceMvuData 兼容层（可选）
     *  - registerTableUpdateCallback + 'shujuku-table-updated' 广播
     *  - 消息收尾时追加状态栏占位符（可选）并触发重渲染
     * ================================================================ */

    function buildLayoutJson(layout) {
        const safe = layout.entries.map(e => ({
            kind: e.kind,
            group: e.group,
            table: e.table,
            keyCol: e.keyCol || '',
            keyValue: e.keyValue || '',
            cols: (e.cols || []).map(c => e.kind === 'singleton'
                ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
                : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || '']),
            writePaths: e.writePaths || [],
            mirrors: e.mirrors || [],
        }));
        return JSON.stringify(safe);
    }

    /**
     * 生成数据桥脚本
     * opts: { mode, template, templateB64, installMvuShim, appendPlaceholder, bridgeScriptName }
     */
    function generateBridgeScript(schema, template, opts = {}) {
        const layout = buildLayout(schema);
        const layoutJson = buildLayoutJson(layout);
        const templateJson = JSON.stringify(template);
        const b64 = opts.templateB64 || (typeof Buffer !== 'undefined'
            ? Buffer.from(templateJson, 'utf8').toString('base64')
            : btoaSafe(templateJson));
        const installMvuShim = opts.installMvuShim !== false;
        const appendPlaceholder = !!opts.appendPlaceholder;
        const name = opts.bridgeScriptName || 'MVU转数据库-数据桥';
        const ver = opts.version || VERSION;

        const script = [
            `window.__MVU2DB_TEMPLATE_BASE64="${b64}";`,
            `try{if(window.top)window.top.__MVU2DB_TEMPLATE_BASE64="${b64}";}catch(e){}`,
            `(function ${'mvu2dbBridge'}(){`,
            `'use strict';`,
            `var VERSION=${JSON.stringify(ver)};`,
            `var BRIDGE_NAME=${JSON.stringify(name)};`,
            '',
            `function rootWin(){try{return window.top||window;}catch(e){return window;}}`,
            `var rootWindow=rootWin();`,
            `var roots=[];`,
            `function addRoot(r){try{if(r&&roots.indexOf(r)===-1)roots.push(r);}catch(e){}}`,
            `addRoot(window);`,
            `try{addRoot(window.parent);}catch(e){}`,
            `try{addRoot(window.top);}catch(e){}`,
            `addRoot(rootWindow);`,
            '',
            `function getApi(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{var a=roots[i].AutoCardUpdaterAPI;if(a&&typeof a.exportTableAsJson==='function')return a;}catch(e){}`,
            `  }`,
            `  return null;`,
            `}`,
            `function getContext(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{if(roots[i].SillyTavern&&typeof roots[i].SillyTavern.getContext==='function')return roots[i].SillyTavern.getContext();}catch(e){}`,
            `    try{if(typeof roots[i].getContext==='function')return roots[i].getContext();}catch(e){}`,
            `  }`,
            `  return null;`,
            `}`,
            '',
            `var API=getApi();`,
            `if(!API){setTimeout(mvu2dbBridge,2000);return;}`,
            '',
            `var TEMPLATE_B64=window.__MVU2DB_TEMPLATE_BASE64||'';`,
            `function parseTemplate(){`,
            `  try{`,
            `    var bin=atob(TEMPLATE_B64);`,
            `    var bytes=new Uint8Array(bin.length);`,
            `    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);`,
            `    var txt=new TextDecoder('utf-8').decode(bytes);`,
            `    return JSON.parse(txt);`,
            `  }catch(e){`,
            `    try{return JSON.parse(decodeURIComponent(escape(atob(TEMPLATE_B64))));}catch(e2){return null;}`,
            `  }`,
            `}`,
            `var TEMPLATE=parseTemplate();`,
            '',
            // 开局建表核心流程（与扩展本体同一份逻辑：缺表时按插件 API 初始化）
            ...DB_INIT_SNIPPET.split('\n'),
            '',
            `var SD_LAYOUT=${layoutJson};`,
            '',
            `window.getSheetByName=function(tableName){`,
            `  var all={};try{all=API.exportTableAsJson()||{};}catch(e){}`,
            `  for(var key in all){if(key.indexOf('sheet_')===0&&all[key]&&all[key].name===tableName)return all[key];}`,
            `  return null;`,
            `};`,
            `try{rootWindow.getSheetByName=window.getSheetByName;}catch(e){}`,
            '',
            `window.getCellByHeader=function(tableName,rowIndex,colName){`,
            `  var s=window.getSheetByName(tableName);`,
            `  if(!s||!Array.isArray(s.content))return null;`,
            `  var ci=s.content[0]?s.content[0].indexOf(colName):-1;`,
            `  if(ci===-1)return null;`,
            `  return s.content[rowIndex]?s.content[rowIndex][ci]:null;`,
            `};`,
            `try{rootWindow.getCellByHeader=window.getCellByHeader;}catch(e){}`,
            '',
            `window.findRowByColumn=function(tableName,colName,value){`,
            `  var s=window.getSheetByName(tableName);`,
            `  if(!s||!Array.isArray(s.content))return -1;`,
            `  var ci=s.content[0]?s.content[0].indexOf(colName):-1;`,
            `  if(ci===-1)return -1;`,
            `  for(var i=1;i<s.content.length;i++){`,
            `    if(s.content[i]&&String(s.content[i][ci])===String(value))return i;`,
            `  }`,
            `  return -1;`,
            `};`,
            `try{rootWindow.findRowByColumn=window.findRowByColumn;}catch(e){}`,
            '',
            `function sheetOf(name){return window.getSheetByName(name);}`,
            `function text(v,fb){if(v===undefined||v===null||v==='')return fb===undefined?'':fb;return String(v);}`,
            `function number(v,fb){var n=parseFloat(v);return isNaN(n)?(fb===undefined?0:fb):n;}`,
            `function parseObject(v){`,
            `  try{`,
            `    if(!v)return {};`,
            `    if(typeof v==='object')return v;`,
            `    return JSON.parse(String(v));`,
            `  }catch(e){return {};}`,
            `}`,
            `function convertCell(type,v,fb){`,
            `  if(type==='number')return number(v,fb);`,
            `  if(type==='object')return parseObject(v);`,
            `  if(type==='pair'){`,
            `    var base=text(v,fb);`,
            `    if(arguments.length>3&&arguments[3])return [base,arguments[3]];`,
            `    return [base,''];`,
            `  }`,
            `  return text(v,fb);`,
            `}`,
            `function setPath(obj,path,value){`,
            `  var cur=obj;`,
            `  for(var i=0;i<path.length-1;i++){`,
            `    var k=path[i];`,
            `    if(!cur[k]||typeof cur[k]!=='object'||Array.isArray(cur[k]))cur[k]={};`,
            `    cur=cur[k];`,
            `  }`,
            `  cur[path[path.length-1]]=value;`,
            `}`,
            '',
            `var runtimeDisplay={};`,
            '',
            `window.getAllVariables=function(){`,
            `  var data={stat_data:{}};`,
            `  var sd=data.stat_data;`,
            `  try{`,
            `    for(var ei=0;ei<SD_LAYOUT.length;ei++){`,
            `      var L=SD_LAYOUT[ei];`,
            `      var s=sheetOf(L.table);`,
            `      if(!s||!Array.isArray(s.content)||!s.content.length){`,
            `        if(L.kind==='rows'){`,
            `          for(var wi=0;wi<(L.writePaths||[]).length;wi++)setPath(sd,L.writePaths[wi],{});`,
            `        }else if(L.kind==='array'){`,
            `          sd[L.group]=[];`,
            `          for(var mi=0;mi<(L.mirrors||[]).length;mi++)setPath(sd,L.mirrors[mi].path,'');`,
            `        }`,
            `        continue;`,
            `      }`,
            `      var header=s.content[0]||[];`,
            `      var idxs=L.cols.map(function(c){return header.indexOf(c[0]);});`,
            `      if(L.kind==='singleton'){`,
            `        var row=s.content[1]||[];`,
            `        sd[L.group]={};`,
            `        for(var j=0;j<L.cols.length;j++){`,
            `          var cj=L.cols[j];`,
            `          var vj=idxs[j]>=0?row[idxs[j]]:undefined;`,
            `          var cp=cj.length>3&&cj[3]&&cj[3].length?cj[3]:[L.group,cj[0]];`,
            `          setPath(sd,cp,convertCell(cj[1],vj,cj[2],cj[5]));`,
            `        }`,
            `      }else if(L.kind==='array'){`,
            `        var arr=[];`,
            `        for(var r=1;r<s.content.length;r++){`,
            `          var rw=s.content[r];`,
            `          if(rw&&rw[idxs[0]]!==undefined)arr.push(text(rw[idxs[0]]));`,
            `        }`,
            `        sd[L.group]=arr;`,
            `        for(var mi2=0;mi2<(L.mirrors||[]).length;mi2++){`,
            `          var mm=L.mirrors[mi2];`,
            `          setPath(sd,mm.path,mm.mode==='first'?(arr.length?arr[0]:''):arr);`,
            `        }`,
            `      }else{`,
            `        var dict={};`,
            `        var keyIdx=header.indexOf(L.keyCol);`,
            `        for(var r2=1;r2<s.content.length;r2++){`,
            `          var rw2=s.content[r2];`,
            `          if(!rw2)continue;`,
            `          var kv=keyIdx>=0?rw2[keyIdx]:undefined;`,
            `          if(kv===undefined||kv===null||kv==='')continue;`,
            `          var item={};`,
            `          for(var j2=0;j2<L.cols.length;j2++){`,
            `            var cj2=L.cols[j2];`,
            `            if(cj2[0]===L.keyCol){item[cj2[0]]=text(kv);continue;}`,
            `            var vj2=idxs[j2]>=0?rw2[idxs[j2]]:undefined;`,
            `            item[cj2[0]]=convertCell(cj2[1],vj2,cj2[2],cj2[5]);`,
            `          }`,
            `          dict[text(kv)]=item;`,
            `        }`,
            `        for(var wi2=0;wi2<(L.writePaths||[]).length;wi2++)setPath(sd,L.writePaths[wi2],dict);`,
            `      }`,
            `    }`,
            `  }catch(e){`,
            `    console.error('['+BRIDGE_NAME+'] getAllVariables 出错:',e);`,
            `  }`,
            `  try{data.display_data=JSON.parse(JSON.stringify(sd));}catch(e){}`,
            `  try{for(var rk in runtimeDisplay){if(runtimeDisplay.hasOwnProperty(rk))setPath(data.display_data,rk.split('.'),runtimeDisplay[rk]);}}catch(e){}`,
            `  return data;`,
            `};`,
            `try{rootWindow.getAllVariables=window.getAllVariables;}catch(e){}`,
            `function installTavernHelperShim(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{`,
            `      var th=roots[i].TavernHelper;`,
            `      if(!th)continue;`,
            `      if(typeof th.getVariables!=='function')th.getVariables=function(){return window.getAllVariables();};`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `installTavernHelperShim();`,
            '',
            `var currentStat=function(){`,
            `  try{return window.getAllVariables().stat_data||{};}catch(e){return {};}`,
            `};`,
            '',
            `function tableEntryByPath(pathStr){`,
            `  for(var ei=0;ei<SD_LAYOUT.length;ei++){`,
            `    var L=SD_LAYOUT[ei];`,
            `    if(L.kind==='array'){`,
            `      if(pathStr===L.group)return{layout:L,kind:'array'};`,
            `      continue;`,
            `    }`,
            `    var prefix=null;`,
            `    if(L.kind==='singleton')prefix=[L.group];`,
            `    else if((L.writePaths||[]).length)prefix=L.writePaths[0];`,
            `    if(!prefix)continue;`,
            `    if(pathStr===prefix.join('.'))return{layout:L,kind:L.kind,prefix:prefix};`,
            `    if(pathStr.indexOf(prefix.join('.')+'.')===0)return{layout:L,kind:L.kind,prefix:prefix};`,
            `  }`,
            `  return null;`,
            `}`,
            '',
            `function pathParts(pathStr){return String(pathStr).split('.');}`,
            '',
            `async function writeDiffToDb(prev,next){`,
            `  var ops=[];`,
            `  function collect(prevObj,nextObj,pathStr){`,
            `    var keys=Object.keys(nextObj||{});`,
            `    for(var i=0;i<keys.length;i++){`,
            `      var k=keys[i];`,
            `      var np=pathStr?pathStr+'.'+k:k;`,
            `      var nv=nextObj[k];`,
            `      var pv=prevObj?prevObj[k]:undefined;`,
            `      var entry=tableEntryByPath(np);`,
            `      if(entry&&entry.kind==='array'){`,
            `        ops.push({np:np,entry:entry,value:nv,replace:true});`,
            `        continue;`,
            `      }`,
            `      if(nv&&typeof nv==='object'&&!Array.isArray(nv)){`,
            `        collect(pv&&typeof pv==='object'&&!Array.isArray(pv)?pv:{},nv,np);`,
            `      }else{`,
            `        ops.push({np:np,entry:entry,value:nv,prev:pv});`,
            `      }`,
            `    }`,
            `  }`,
            `  collect(prev,next,'');`,
            `  for(var oi=0;oi<ops.length;oi++){`,
            `    var op=ops[oi];`,
            `    var E=op.entry;`,
            `    if(!E)continue;`,
            `    var L=E.layout;`,
            `    var sheet=sheetOf(L.table);`,
            `    if(!sheet)continue;`,
            `    var header=sheet.content&&sheet.content[0]?sheet.content[0]:[];`,
            `    if(op.replace&&E.kind==='array'){`,
            `      // 数组整体替换：先清空旧行，再逐行插入`,
            `      for(var rr=sheet.content.length-1;rr>=1;rr--){try{await Promise.resolve(API.deleteRow(L.table,rr-1));}catch(e){}}`,
            `      var arr=Array.isArray(op.value)?op.value:[];`,
            `      for(var ai=0;ai<arr.length;ai++){`,
            `        var o={};o[String(0)]=String(arr[ai]);`,
            `        try{await Promise.resolve(API.insertRow(L.table,o));}catch(e){console.warn('['+BRIDGE_NAME+'] insertRow 失败:',e);}`,
            `      }`,
            `      continue;`,
            `    }`,
            `    var parts=pathParts(op.np);`,
            `    var isRows=E.kind==='rows';`,
            `    var rowIndex=-1;`,
            `    if(E.kind==='singleton'){`,
            `      rowIndex=1;`,
            `    }else if(isRows){`,
            `      var keyVal=parts[E.prefix.length];`,
            `      if(keyVal===undefined){continue;}`,
            `      rowIndex=window.findRowByColumn(L.table,L.keyCol,keyVal);`,
            `      if(rowIndex===-1){`,
            `        // 新条目：插入`,
            `        var newRow={};`,
            `        for(var nc=0;nc<L.cols.length;nc++){`,
            `          var cc=L.cols[nc];`,
            `          if(cc[0]===L.keyCol){newRow[String(nc)]=String(keyVal);continue;}`,
            `          var cp=parts.slice(E.prefix.length+1);`,
            `          if(cp.length===1&&cp[0]===cc[0])newRow[String(nc)]=String(op.value);`,
            `        }`,
            `        try{await Promise.resolve(API.insertRow(L.table,newRow));}catch(e){console.warn('['+BRIDGE_NAME+'] insertRow 失败:',e);}`,
            `        continue;`,
            `      }`,
            `    }`,
            `    if(rowIndex<0)continue;`,
            `    var colZh=parts[parts.length-1];`,
            `    var colIdx=header.indexOf(colZh);`,
            `    if(colIdx===-1)continue;`,
            `    try{await Promise.resolve(API.updateCell(L.table,rowIndex,colZh,op.value));}catch(e){console.warn('['+BRIDGE_NAME+'] updateCell 失败:',e);}`,
            `  }`,
            `}`,
            '',
            `var mvuShimInstalled=false;`,
            `function installMvuShim(){`,
            `  if(mvuShimInstalled)return;`,
            `  var hostMvu=null;`,
            `  for(var i=0;i<roots.length;i++){try{if(roots[i].Mvu){hostMvu=roots[i].Mvu;break;}}catch(e){}}`,
            `  var fake={};`,
            `  fake.getMvuData=function(opts){`,
            `    var all=window.getAllVariables();`,
            `    return {stat_data:all.stat_data||{},display_data:all.display_data||{},delta_data:{},initialized_lorebooks:{}};`,
            `  };`,
            `  fake.replaceMvuData=async function(data,opts){`,
            `    var next=(data&&data.stat_data)||{};`,
            `    var prev=currentStat();`,
            `    await writeDiffToDb(prev,next);`,
            `    broadcastBridgeEvent();`,
            `    return true;`,
            `  };`,
            `  fake.events={VARIABLE_UPDATE_ENDED:'shujuku-table-updated',VARIABLE_UPDATE_STARTED:'shujuku-table-updating'};`,
            `  for(var i2=0;i2<roots.length;i2++){`,
            `    try{`,
            `      if(!roots[i2].Mvu)roots[i2].Mvu=fake;`,
            `      else if(!roots[i2].Mvu.getMvuData)roots[i2].Mvu.getMvuData=fake.getMvuData;`,
            `      else if(!roots[i2].Mvu.replaceMvuData)roots[i2].Mvu.replaceMvuData=fake.replaceMvuData;`,
            `    }catch(e){}`,
            `  }`,
            `  mvuShimInstalled=true;`,
            `}`,
            (installMvuShim ? `installMvuShim();` : ``),
            '',
            `function broadcastBridgeEvent(){`,
            `  var targets=[];`,
            `  function add(t){try{if(t&&typeof t.dispatchEvent==='function'&&targets.indexOf(t)===-1)targets.push(t);}catch(e){}}`,
            `  add(window);add(rootWindow);`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{`,
            `      var frames=roots[i].document?roots[i].document.querySelectorAll('iframe'):[];`,
            `      for(var f=0;f<frames.length;f++){try{add(frames[f].contentWindow);}catch(e){}}`,
            `    }catch(e){}`,
            `  }`,
            `  var EventCtor=null;`,
            `  try{EventCtor=window.CustomEvent||rootWindow.CustomEvent||CustomEvent;}catch(e){EventCtor=CustomEvent;}`,
            `  for(var t=0;t<targets.length;t++){`,
            `    try{targets[t].dispatchEvent(new EventCtor('shujuku-table-updated'));}catch(e){}`,
            `  }`,
            `}`,
            `rootWindow.__mvu2dbDataBridgeBroadcast=rootWindow.__mvu2dbDataBridgeBroadcast||broadcastBridgeEvent;`,
            '',
            `if(typeof API.registerTableUpdateCallback==='function'){`,
            `  var cbKey='__mvu2dbTableUpdateCallback_'+VERSION;`,
            `  if(!rootWindow[cbKey]){`,
            `    rootWindow[cbKey]=function(){`,
            `      try{broadcastBridgeEvent();}catch(e){}`,
            `    };`,
            `    API.registerTableUpdateCallback(rootWindow[cbKey]);`,
            `  }`,
            `}`,
            '',
            `function currentChatKey(){`,
            `  var ctx=getContext();`,
            `  return String(ctx&&(ctx.chatId||ctx.chat_id||ctx.chatFile||ctx.chatFileName)||'unknown');`,
            `}`,
            `function currentCharName(){`,
            `  var ctx=getContext();`,
            `  try{var n=ctx&&(ctx.name||ctx.charName||ctx.characterName);if(n)return String(n);}catch(e){}`,
            `  return '';`,
            `}`,
            `var initState={running:false,done:false,key:''};`,
            `var initRetries=0;`,
            `async function ensureTemplateInit(){`,
            `  if(!TEMPLATE_B64)return;`,
            `  var key=currentChatKey();`,
            `  if(initState.key!==key)initRetries=0;`,
            `  if(initState.done&&initState.key===key)return;`,
            `  if(initState.running)return;`,
            `  initState.running=true;`,
            `  initState.key=key;`,
            `  try{`,
            `    var out=await mvu2dbEnsureInit(API,TEMPLATE_B64,currentCharName()+'模板');`,
            `    if(out.status==='error'||out.status==='partial'){`,
            `      console.warn('['+BRIDGE_NAME+'] 开局建表未完全成功:',out.message);`,
            `      initState.done=false;`,
            `      // 开场白切换/重渲染可能打断插件的运行时初始化；轮询重试直到建表成功`,
            `      if(initRetries<15){initRetries++;setTimeout(ensureTemplateInit,4000);}`,
            `    }else{`,
            `      console.log('['+BRIDGE_NAME+'] '+out.message);`,
            `      initRetries=0;`,
            `      initState.done=true;`,
            `    }`,
            `  }catch(e){`,
            `    console.warn('['+BRIDGE_NAME+'] 开局建表异常:',e);`,
            `    initState.done=false;`,
            `    if(initRetries<15){initRetries++;setTimeout(ensureTemplateInit,4000);}`,
            `  }`,
            `  initState.running=false;`,
            `}`,
            `function tablesReady(){`,
            `  try{`,
            `    var tpl=parseTemplate();`,
            `    if(!tpl)return false;`,
            `    return mvu2dbMissingTableNames(API,mvu2dbExpectedTableNames(tpl)).length===0;`,
            `  }catch(e){return false;}`,
            `}`,
            `Promise.resolve(ensureTemplateInit()).then(function(){try{applyPendingUpdateBlocks();}catch(e){}});`,
            '',
            `// MVU 更新块兼容：解析 <UpdateVariable>/<json_patch> 中的 _.set/_.add/_.remove 等指令，`,
            `// 先应用到 stat_data 副本，再 diff 写回数据库（与 Mvu.replaceMvuData 同一套机制）。`,
            `function parseCommandValue2(raw){`,
            `  var t=String(raw==null?'':raw).trim();`,
            `  if(t==='true')return true;`,
            `  if(t==='false')return false;`,
            `  if(t==='null')return null;`,
            `  if(t==='undefined')return undefined;`,
            `  try{return JSON.parse(t);}catch(e){}`,
            `  if(/^-?\\d+(\\.\\d+)?$/.test(t))return Number(t);`,
            `  return t.replace(/^['\"]|['\"]$/g,'');`,
            `}`,
            `function splitCommandArgs(argsStr){`,
            `  var out=[];`,
            `  var cur='';`,
            `  var depth=0;`,
            `  var inStr=null;`,
            `  for(var i=0;i<argsStr.length;i++){`,
            `    var ch=argsStr[i];`,
            `    if(inStr){cur+=ch;if(ch==='\\\\'){cur+=argsStr[i+1]||'';i++;continue;}if(ch===inStr)inStr=null;continue;}`,
            `    if(ch==='\\''||ch==='\"'){inStr=ch;cur+=ch;continue;}`,
            `    if(ch==='('||ch==='['||ch==='{')depth++;`,
            `    if(ch===')'||ch===']'||ch==='}')depth--;`,
            `    if(ch===','&&depth===0){out.push(cur.trim());cur='';continue;}`,
            `    cur+=ch;`,
            `  }`,
            `  if(cur.trim())out.push(cur.trim());`,
            `  return out;`,
            `}`,
            `function parseUpdateCommands(text){`,
            `  var cmds=[];`,
            `  var blockRe=/<(updatevariable|json_?patch)>[\\s\\S]*?(?:\\/\\1>)/gi;`,
            `  var m;`,
            `  while((m=blockRe.exec(String(text||'')))){`,
            `    var inner=m[0].replace(/<[^>]+>/g,'').replace(/\\\`\\\`\\\`[^\\\`]*\\\`\\\`\\\`/g,'').trim();`,
            `    if(m[1].toLowerCase().indexOf('json')===0){`,
            `      try{`,
            `        var patch=JSON.parse(inner);`,
            `        if(Array.isArray(patch)){`,
            `          for(var pi=0;pi<patch.length;pi++){`,
            `            var op=patch[pi]||{};`,
            `            if(!op.path&&!op.to)continue;`,
            `            cmds.push({type:op.op==='delta'?'add':op.op||'set',path:String(op.path||op.to||'').replace(/^\\//,'').replace(/\\//g,'.'),value:op.value,from:op.from});`,
            `          }`,
            `        }`,
            `      }catch(e){}`,
            `      continue;`,
            `    }`,
            `    var cmdRe=/\\.(set|assign|insert|remove|unset|delete|add)\\(/g;`,
            `    var cm;`,
            `    while((cm=cmdRe.exec(inner))){`,
            `      var open=inner.indexOf('(',cm.index+cm[0].length-1);`,
            `      if(open===-1)continue;`,
            `      var depth=1;`,
            `      var end=-1;`,
            `      var inS=null;`,
            `      for(var k=open+1;k<inner.length;k++){`,
            `        var c2=inner[k];`,
            `        if(inS){if(c2==='\\\\'){k++;continue;}if(c2===inS)inS=null;continue;}`,
            `        if(c2==='\\''||c2==='\"'){inS=c2;continue;}`,
            `        if(c2==='(')depth++;`,
            `        else if(c2===')'){depth--;if(depth===0){end=k;break;}}`,
            `      }`,
            `      if(end===-1)break;`,
            `      var args=splitCommandArgs(inner.slice(open+1,end));`,
            `      var after=inner.slice(end+1).replace(/^\\s*;\\s*/,'');`,
            `      var reason='';`,
            `      var rmatch=after.match(/^\\/\\/\s*([^\\n]*)/);`,
            `      if(rmatch)reason=rmatch[1].trim();`,
            `      var type=cm[1];`,
            `      var path=String(args[0]||'').replace(/^['\"]|['\"]$/g,'').replace(/^\\//,'').replace(/\\//g,'.');`,
            `      if(type==='remove'||type==='unset'||type==='delete'){cmds.push({type:'delete',path:path,reason:reason});}`,
            `      else if(type==='insert'){cmds.push({type:'insert',path:path,keyOrIndex:args[1]?parseCommandValue2(args[1]):null,value:args[2]?parseCommandValue2(args[2]):undefined,reason:reason});}`,
            `      else if(type==='assign'){cmds.push({type:'assign',path:path,keyOrIndex:args[2]!==undefined?parseCommandValue2(args[1]):undefined,value:args[2]!==undefined?parseCommandValue2(args[2]):parseCommandValue2(args[1]),reason:reason});}`,
            `      else if(type==='add'){cmds.push({type:'add',path:path,value:args[1]!==undefined?parseCommandValue2(args[1]):undefined,reason:reason});}`,
            `      else {cmds.push({type:'set',path:path,value:args[2]!==undefined?parseCommandValue2(args[2]):(args[1]!==undefined?parseCommandValue2(args[1]):undefined),reason:reason});}`,
            `      cmdRe.lastIndex=end+1;`,
            `    }`,
            `  }`,
            `  return cmds;`,
            `}`,
            `function trimDisplay(v){try{return String(JSON.stringify(v)).replace(/^"|"$/g,'').replace(/\\\\"/g,'"');}catch(e){return String(v);}}`,
            `function noteDisplay(display,path,oldV,newV,reason){if(!display)return;var r=reason?(' ('+reason+')'):'';display[path]=trimDisplay(oldV)+'->'+trimDisplay(newV)+r;}`,
            `function applyCommandsToStat(stat,cmds,display){`,
            `  for(var ci=0;ci<cmds.length;ci++){`,
            `    var cmd=cmds[ci];`,
            `    if(!cmd.path)continue;`,
            `    var parts=String(cmd.path).split('.').filter(function(p){return p!=='';});`,
            `    if(cmd.type==='delete'){`,
            `      var oldDel=null;`,
            `      if(parts.length===1){oldDel=stat[parts[0]];try{delete stat[parts[0]];}catch(e){}}`,
            `      else{`,
            `        var cur=stat;`,
            `        var ok=true;`,
            `        for(var d=0;d<parts.length-1;d++){cur=cur?cur[parts[d]]:null;if(!cur){ok=false;break;}}`,
            `        if(ok){oldDel=cur[parts[parts.length-1]];try{delete cur[parts[parts.length-1]];}catch(e){}}`,
            `      }`,
            `      if(Array.isArray(oldDel)&&oldDel.length===2)oldDel=oldDel[0];`,
            `      noteDisplay(display,cmd.path,oldDel,'(移除)',cmd.reason);`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='insert'){`,
            `      var container=stat;`,
            `      var ok2=true;`,
            `      for(var d2=0;d2<parts.length-1;d2++){container=container?container[parts[d2]]:null;if(!container){ok2=false;break;}}`,
            `      if(!ok2)continue;`,
            `      var key=cmd.keyOrIndex;`,
            `      if(key==='-'||key===null){`,
            `        if(Array.isArray(container))container.push(cmd.value);`,
            `        else if(container&&typeof container==='object')container[String(Date.now())]=cmd.value;`,
            `      }else if(Array.isArray(container)&&/^\\d+$/.test(String(key))){container.splice(Number(key),0,cmd.value);}`,
            `      else if(container&&typeof container==='object'){container[key]=cmd.value;}`,
            `      noteDisplay(display,cmd.path,'(新增)',cmd.value,cmd.reason);`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='assign'&&cmd.keyOrIndex!==undefined){`,
            `      var acont=stat;`,
            `      var aok=true;`,
            `      for(var d5=0;d5<parts.length-1;d5++){acont=acont?acont[parts[d5]]:null;if(!acont){aok=false;break;}}`,
            `      if(aok&&acont&&typeof acont==='object'){`,
            `        var akey=cmd.keyOrIndex;`,
            `        if(akey==='-'&&Array.isArray(acont))acont.push(cmd.value);`,
            `        else if(Array.isArray(acont)&&/^\\d+$/.test(String(akey)))acont.splice(Number(akey),0,cmd.value);`,
            `        else if(acont&&typeof acont==='object')acont[akey]=cmd.value;`,
            `        noteDisplay(display,cmd.path,(Array.isArray(acont)&&acont.length&&acont[0]!==cmd.value?acont[0]:'(变更)'),cmd.value,cmd.reason);`,
            `      }`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='assign'&&cmd.value&&typeof cmd.value==='object'&&!Array.isArray(cmd.value)){`,
            `      var tgt=stat;`,
            `      var ok3=true;`,
            `      for(var d3=0;d3<parts.length-1;d3++){tgt=tgt?tgt[parts[d3]]:null;if(!tgt){ok3=false;break;}}`,
            `      if(ok3&&tgt&&typeof tgt==='object'){for(var ak of Object.keys(cmd.value))tgt[ak]=cmd.value[ak];continue;}`,
            `    }`,
            `    var target=stat;`,
            `    var ok4=true;`,
            `    for(var d4=0;d4<parts.length-1;d4++){`,
            `      if(target[parts[d4]]===undefined)target[parts[d4]]={};`,
            `      target=target[parts[d4]];`,
            `      if(!target||typeof target!=='object'){ok4=false;break;}`,
            `    }`,
            `    if(!ok4)continue;`,
            `    var last=parts[parts.length-1];`,
            `    var existing=target[last];`,
            `    if(cmd.type==='add'){`,
            `      var base=Array.isArray(existing)&&existing.length?existing[0]:existing;`,
            `      var delta=parseFloat(cmd.value);`,
            `      var dateVal=null;`,
            `      if(typeof base==='string'){var dtest=new Date(base);if(!isNaN(dtest.getTime())&&isNaN(Number(base)))dateVal=dtest;}`,
            `      if(dateVal&&!isNaN(delta)){`,
            `        var nd=new Date(dateVal.getTime()+delta);`,
            `        target[last]=nd.toISOString();`,
            `        noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `      }else{`,
            `        var num=parseFloat(base);`,
            `        if(!isNaN(num)&&!isNaN(delta)){`,
            `          target[last]=parseFloat((num+delta).toPrecision(12));`,
            `          noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `        }else if(Array.isArray(existing)){`,
            `          existing.push(cmd.value);`,
            `          noteDisplay(display,cmd.path,'(数组追加)',cmd.value,cmd.reason);`,
            `        }else{`,
            `          target[last]=cmd.value;`,
            `          noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `        }`,
            `      }`,
            `    }else{`,
            `      var oldSet=Array.isArray(existing)&&existing.length===2?existing[0]:existing;`,
            `      target[last]=cmd.value;`,
            `      noteDisplay(display,cmd.path,oldSet,target[last],cmd.reason);`,
            `    }`,
            `  }`,
            `  return stat;`,
            `}`,
            `var appliedBlocks=null;`,
            `function applyPendingUpdateBlocks(){`,
            `  var ctx=getContext();`,
            `  var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];`,
            `  if(!chat.length)return;`,
            `  if(!tablesReady())return;`,
            `  if(!appliedBlocks)appliedBlocks={};`,
            `  var key=currentChatKey();`,
            `  for(var mi=0;mi<chat.length;mi++){`,
            `    var msg=chat[mi];`,
            `    if(!msg||msg.is_user)continue;`,
            `    var text=String(msg.mes||msg.message||'');`,
            `    if(!/<updatevariable|<json_?patch/i.test(text))continue;`,
            `    var msgKey=key+':'+mi+':'+String(msg.swipe_id||0);`,
            `    if(appliedBlocks[msgKey])continue;`,
            `    appliedBlocks[msgKey]=true;`,
            `    var cmds=parseUpdateCommands(text);`,
            `    if(!cmds.length)continue;`,
            `    Promise.resolve().then(function(){`,
            `      try{`,
            `        var prev=currentStat();`,
            `        var next=JSON.parse(JSON.stringify(prev));`,
            `        var disp={};`,
            `        applyCommandsToStat(next,cmds,disp);`,
            `        return writeDiffToDb(prev,next).then(function(){`,
            `          for(var dk in disp){if(disp.hasOwnProperty(dk))runtimeDisplay[dk]=disp[dk];}`,
            `          broadcastBridgeEvent();`,
            `        });`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] 应用 MVU 更新块失败:',e);}`,
            `    });`,
            `  }`,
            `}`,
            (appendPlaceholder ? [
                ``,
                `var placeholderRuntime=null;`,
                `function installMessageRuntime(){`,
                `  if(placeholderRuntime&&placeholderRuntime.bound)return;`,
                `  var ctx=getContext();`,
                `  var es=ctx&&ctx.eventSource;`,
                `  var et=ctx&&(ctx.event_types||ctx.eventTypes);`,
                `  var evName=et&&et.MESSAGE_RECEIVED;`,
                `  if(!es||!evName||typeof es.on!=='function'){`,
                `    if(!placeholderRuntime)placeholderRuntime={bound:false,timer:null};`,
                `    placeholderRuntime.timer=setTimeout(installMessageRuntime,1500);`,
                `    return;`,
                `  }`,
                `  function onMessage(){`,
                `    setTimeout(function(){`,
                `      Promise.resolve(ensureTemplateInit()).then(function(){try{applyPendingUpdateBlocks();}catch(e){}});`,
                `      try{broadcastBridgeEvent();}catch(e){}`,
                `    },250);`,
                `  }`,
                `  es.on(evName,onMessage);`,
                `  if(placeholderRuntime){placeholderRuntime.bound=true;placeholderRuntime.handler=onMessage;}`,
                `  else placeholderRuntime={bound:true,handler:onMessage};`,
                `}`,
                `installMessageRuntime();`,
            ].join('\n') : ``),
            ``,
            `console.log('['+BRIDGE_NAME+'] 数据桥已就绪：getAllVariables/getSheetByName/getCellByHeader/findRowByColumn');`,
            `})();`,
        ].join('\n');
        return script;
    }

    /* ================================================================
     * EJS 条件重写（rewriteEjsConditions）
     * MVU 卡里常见的条件写法：
     *   <% if (getvar('stat_data.组.字段') >= 50) { %> ... <% } %>
     *   <% if (getvar("stat_data").组["字段"][0] >= 50) { %> ... <% } %>
     *   <% if (_.has(getvar("stat_data"), '组.条目.字段.[0]')) { %>
     *   <% if (Object.keys(getvar('stat_data.组')).length > 3) { %>
     * → 插件 <if cell="..."> / <if cond="..."> / <if db="...">
     * ================================================================ */

    function resolveCellForPath(layout, parts) {
        for (const e of layout.entries) {
            if (e.kind === 'singleton') {
                if (parts.length === 2 && parts[0] === e.group) {
                    const col = parts[1];
                    if (e.cols.some(c => c.zh === col)) {
                        return { table: e.table, rowKey: e.keyValue, col };
                    }
                }
            } else if (e.kind === 'rows') {
                const prefix = e.writePaths && e.writePaths[0] ? e.writePaths[0] : [e.group];
                if (parts.length >= prefix.length && prefix.every((p, i) => parts[i] === p)) {
                    if (parts.length === prefix.length) {
                        // 组本身 → 行数聚合
                        return { table: e.table, count: true };
                    }
                    if (parts.length === prefix.length + 1) {
                        // 仅行标识 → 行存在性（用主键列判空）
                        const rowKey = parts[prefix.length];
                        return { table: e.table, rowKey, col: e.keyCol };
                    }
                    if (parts.length === prefix.length + 2) {
                        const rowKey = parts[prefix.length];
                        const col = parts[prefix.length + 1];
                        if (e.cols.some(c => c.zh === col)) {
                            return { table: e.table, rowKey, col };
                        }
                    }
                }
            }
        }
        return null;
    }

    function normalizeCondAtom(atom, layout) {
        // atom: 如 getvar('stat_data.组.字段') >= 50 或 !getvar(...) 或 Object.keys(...)
        let s = atom.trim();
        let negated = false;
        while (s.startsWith('!')) {
            negated = !negated;
            s = s.slice(1).trim();
        }
        // 提取路径（支持官方教程规范写法）
        let pathStr = null;
        let aggregate = false;
        // getvar("stat_data").组["字段"][0] 成员访问形式
        const memberMatch = s.match(/getvar\(\s*["']stat_data["']\s*\)\.([\u4e00-\u9fffA-Za-z_$]+)((?:\[[^\]]*\]|\.[\u4e00-\u9fffA-Za-z_$]+)*)/);
        const hasMatch = s.match(/_\s*\.\s*has\s*\(\s*getvar\(\s*["']stat_data["']\s*\)\s*,\s*['"]([^'"]+)['"]/);
        const indexedMatch = s.match(/getvar\(\s*['"]([^'"]+)['"]\s*\)(\[[^\]]*\])+/);
        if (memberMatch) {
            const segs = [];
            segs.push(memberMatch[1]);
            const tail = memberMatch[2] || '';
            const segRe = /(?:\.([\u4e00-\u9fffA-Za-z_$]+)|\[["']?([^"'\]]+)["']?\])/g;
            let sm;
            while ((sm = segRe.exec(tail))) segs.push(sm[1] || sm[2]);
            pathStr = segs.filter(seg => !/^\d+$/.test(seg)).join('.');
        } else if (hasMatch) {
            pathStr = hasMatch[1].replace(/\.(\d+)$/, '').replace(/\.\[\d+\]$/, '');
        } else if (indexedMatch) {
            pathStr = indexedMatch[1];
        } else {
        const getvarMatch = s.match(/getvar\(\s*['"]([^'"]+)['"]\s*\)/);
        const underscoreMatch = s.match(/_\s*\.\s*get\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/);
        const keysMatch = s.match(/Object\s*\.\s*keys\s*\(\s*getvar\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*\.\s*length/);
            if (keysMatch) {
                pathStr = keysMatch[1];
                aggregate = true;
            } else if (getvarMatch) {
                pathStr = getvarMatch[1];
            } else if (underscoreMatch) {
                pathStr = underscoreMatch[1];
            } else {
                return null;
            }
        }
        pathStr = pathStr.replace(/^stat_data\./, '').replace(/^stat\./, '');
        const parts = pathStr.split('.');
        // 长操作符优先（===/!== 必须先于 ==/!= 匹配，否则会被拆成 == + 残留字符）
        const opMatch = s.replace(/^[^=!<>]*/, '').match(/^(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
        const cell = resolveCellForPath(layout, parts);
        if (!cell) return { unsupported: true, raw: atom, pathStr };
        let expr;
        if (cell.count) {
            // 聚合：仅 SQLite 模式可用
            if (!opMatch) return { unsupported: true, raw: atom, pathStr, aggregate: true };
            expr = `db:${cell.table}.count() ${opMatch[1]} ${opMatch[2].trim()}`;
            return { expr, negated, aggregate: true, pathStr, kind: 'db' };
        }
        if (opMatch) {
            const value = opMatch[2].trim().replace(/^['"](.*)['"]$/, '$1');
            if (/[\s/'"]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) {
                return { unsupported: true, raw: atom, pathStr };
            }
            expr = `cell:${cell.table}/${cell.rowKey}/${cell.col} ${opMatch[1]} ${value}`;
        } else {
            expr = `cell:${cell.table}/${cell.rowKey}/${cell.col}`;
        }
        if (negated) expr = `!${expr}`;
        return { expr, negated, cell, pathStr, kind: 'cell' };
    }

    function mapCondToIfType(cond) {
        // cond: 由若干 atom.expr 用 && / || / 括号组合
        if (/^cell:/.test(cond) && !/[&,!]/.test(cond)) {
            return { type: 'cell', value: cond.slice(5) };
        }
        if (/^db:/.test(cond) && !/[&,!]/.test(cond)) {
            return { type: 'db', value: cond.slice(3) };
        }
        return { type: 'cond', value: cond };
    }

    /**
     * 重写文本中的 EJS if 块。
     * 返回 { text, items }；items 每项 { original, rewritten, status }
     */
    function rewriteEjsConditions(text, layout, report) {
        const items = [];
        let out = String(text || '');
        const blockRe = /<%[-=]?\s*if\s*\(([\s\S]*?)\)\s*\{[\s\S]*?%>/g;
        const closeRe = /<%[-=]?\s*}\s*%>/g;
        const elseRe = /<%[-=]?\s*}\s*else\s*\{\s*%>/g;
        const elseIfRe = /<%[-=]?\s*}\s*else\s+if\s*\(([\s\S]*?)\)\s*\{\s*%>/g;

        // 简化处理：只处理“if(cond){...}else{...}”或“if(cond){...}”的单层块
        function processBlock(match, condRaw, offset, full) {
            const cond = condRaw.trim();
            const openEnd = match.length;
            const rest = full.slice(offset + openEnd);
            // 解析 if / else-if / else 链：统计嵌套的 <% if ... { %> 与闭合标签，
            // 记录每个分支的边界（bodyStart/bodyEnd 相对 rest）。
            let depth = 1;
            let closeIdx = -1;
            const branches = [{ cond, bodyStart: 0 }];
            const tokenRe = /<%[-=]?\s*if\s*\([\s\S]*?\)\s*\{[\s\S]*?%>|<%[-=]?\s*}\s*(?:else\s*(?:if\s*\([\s\S]*?\))?\s*\{)?\s*%>/g;
            tokenRe.lastIndex = 0;
            let tm;
            while ((tm = tokenRe.exec(rest))) {
                const token = tm[0];
                if (/^\s*<%[-=]?\s*if\s*\(/i.test(token)) {
                    depth++; // 嵌套 if 开标签
                    continue;
                }
                if (/else\s*(?:if\s*\([\s\S]*?\))?\s*\{/i.test(token)) {
                    const lastBranch = branches[branches.length - 1];
                    lastBranch.bodyEnd = tm.index;
                    const em = token.match(/else\s+if\s*\(([\s\S]*?)\)\s*\{/i);
                    branches.push(em
                        ? { cond: em[1].trim(), bodyStart: tm.index + token.length }
                        : { cond: null, bodyStart: tm.index + token.length });
                    continue;
                }
                depth -= 1;
                if (depth === 0) { closeIdx = tm.index; break; }
            }
            if (closeIdx === -1) return null;
            branches[branches.length - 1].bodyEnd = closeIdx;

            // 逐分支：递归处理嵌套 EJS；映射条件（任一条件无法转换则整条链保留人工）
            const mappedBranches = [];
            let ok = true;
            let aggregateUsed = false;
            for (const b of branches) {
                let body = rest.slice(b.bodyStart, b.bodyEnd);
                if (/<%/g.test(body)) {
                    const rw = rewriteEjsConditions(body, layout, report);
                    body = rw.text;
                    items.push(...rw.items);
                }
                let ifStr = null;
                if (b.cond !== null) {
                    const atoms = b.cond.split(/\s+(&&|\|\|)\s+/);
                    const logical = b.cond.match(/\s+(&&|\|\|)\s+/g) || [];
                    const mapped = [];
                    for (let i = 0; i < atoms.length; i++) {
                        const res = normalizeCondAtom(atoms[i], layout);
                        if (!res || res.unsupported) { ok = false; break; }
                        if (res.aggregate) aggregateUsed = true;
                        mapped.push(res.expr);
                    }
                    if (!ok) break;
                    let condStr = mapped[0];
                    for (let i = 0; i < logical.length; i++) {
                        condStr += (logical[i] === '&&' ? ' & ' : ', ') + mapped[i + 1];
                    }
                    const ifType = mapCondToIfType(condStr);
                    const attr = ifType.type === 'cell' ? 'cell' : ifType.type === 'db' ? 'db' : 'cond';
                    ifStr = `<if ${attr}="${ifType.value}">`;
                }
                mappedBranches.push({ body, ifStr });
            }
            if (!ok) return null;

            // 组装嵌套结构：<if C1>B1<else><if C2>B2<else>…B最后…</if></if>
            // 插件解析器支持 <else> 内嵌套 <if>（parseSingleIfBlock 递归处理）。
            function assembleChain(idx) {
                const b = mappedBranches[idx];
                if (idx === mappedBranches.length - 1) {
                    return b.ifStr ? b.ifStr + b.body + '</if>' : b.body;
                }
                return b.ifStr + b.body + '<else>' + assembleChain(idx + 1) + '</if>';
            }
            const rewritten = assembleChain(0);
            // 原块 = 开标签 + 主体（含 else 分支）+ 闭合标签
            const closeToken = rest.slice(closeIdx).match(/<%[-=]?\s*}\s*%>/);
            const origLen = closeToken ? closeIdx + closeToken[0].length : rest.length;
            const orig = match + rest.slice(0, origLen);
            return { rewritten, orig, aggregateUsed };
        }

        let guard = 0;
        while (guard++ < 20) {
            const m = blockRe.exec(out);
            if (!m) break;
            const res = processBlock(m[0], m[1], m.index, out);
            if (!res) {
                // 无法自动转换：保留原样，标记人工
                report.manual(`EJS 条件未自动转换（条目内）：\`${m[0].slice(0, 120)}...\``);
                blockRe.lastIndex = m.index + m[0].length;
                continue;
            }
            items.push({
                original: res.orig.slice(0, 200),
                rewritten: res.rewritten.slice(0, 200),
                status: 'auto',
                aggregate: !!res.aggregateUsed,
            });
            out = out.slice(0, m.index) + res.rewritten + out.slice(m.index + res.orig.length);
            blockRe.lastIndex = m.index + res.rewritten.length;
        }
        // 处理孤立 <%- ... -%> 输出块（getwi 等）——保留并提示
        const orphanRe = /<%[-=]\s*await\s+getwi[\s\S]*?-?%>/g;
        const orphans = out.match(orphanRe);
        if (orphans) {
            report.note(`检测到 ${orphans.length} 处 getwi 世界书引用（非 MVU 语法），已原样保留；若目标环境不支持请人工处理。`);
        }
        return { text: out, items };
    }

    /* ================================================================
     * 卡片转换（transformCard / convert）
     * ================================================================ */

    function patchStatusBarMvuEvents(text) {
        // 把“监听 Mvu 变量更新结束”改成“监听 shujuku 表格更新事件”
        const re = /eventOn\s*\(\s*Mvu\s*\.\s*events\s*\.\s*VARIABLE_UPDATE_ENDED\s*,\s*\(\)\s*=>\s*\{/g;
        let t = String(text || '');
        let count = 0;
        t = t.replace(re, () => {
            count++;
            return `(() => { if (window.addEventListener) window.addEventListener('shujuku-table-updated', () => {`;
        });
        // 处理缺少箭头参数的变体 eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {
        if (count === 0) {
            const re2 = /eventOn\s*\(\s*Mvu\s*\.\s*events\s*\.\s*VARIABLE_UPDATE_ENDED\s*,\s*\(\s*\)\s*=>\s*\{/g;
            t = t.replace(re2, () => {
                count++;
                return `(() => { if (window.addEventListener) window.addEventListener('shujuku-table-updated', () => {`;
            });
        }
        return { text: t, count };
    }

    const MVU_REGEX_REMOVE_PATTERNS = [
        /变量更新/i,
        /去除变量/i,
        /完整变量/i,
    ];

    // 仅当正则明确解析 MVU 专属语法时才移除；显示用正则（data_block/状态栏等）原样保留
    function isMvuRegex(r) {
        const name = String(r.scriptName || '');
        const content = String(r.replaceString || '') + '\n' + String(r.findRegex || '');
        if (MVU_REGEX_REMOVE_PATTERNS.some(p => p.test(name))) return true;
        return /format_message_variable|status_current_variables|<UpdateVariable\b/i.test(content);
    }

    function isMvuScriptContent(content) {
        return /Mvu\s*\.|MagVarUpdate|magvar|registerMvuSchema/i.test(String(content || ''));
    }

    /**
     * 转换角色卡。
     * opts: {
     *   mode: 'both'|'native'|'sqlite',
     *   installMvuShim: boolean（默认自动：卡内检测到 MVU API 则装）
     *   appendPlaceholder: boolean（默认 true：消息收尾触发状态栏刷新）
     *   template: 预生成的模板（可选）
     *   report: 复用报告（可选）
     *   nameSuffix: string（默认 '_数据库'，追加到角色卡名）
     * }
     */
    function transformCard(card, opts = {}) {
        const report = opts.report || createReport();
        const mode = opts.mode || 'both';
        const nameSuffix = opts.nameSuffix !== undefined ? opts.nameSuffix : '_数据库';
        const data = card.data || card;
        const cb = data.character_book || {};
        const entries = Array.isArray(cb.entries) ? cb.entries : [];

        // 1. initvar（支持多个 [initvar] 条目，按出现顺序合并）
        const initEntries = entries.filter(e => /\[initvar\]/i.test(String(e.comment || '')));
        let initvar = {};
        let greetingBlockCount = 0;
        if (initEntries.length) {
            for (const initEntry of initEntries) {
                let content = String(initEntry.content || '');
                // MVU 的包裹剥离顺序：<initvar> XML 包裹 → ``` 代码块包裹
                const wrapped = content.match(/^\s*<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>\s*$/i);
                if (wrapped) content = wrapped[1];
                const codeblock = content.match(/^\s*```[^\n]*\n?([\s\S]*?)\n?\s*```\s*$/);
                if (codeblock) content = codeblock[1];
                const parsed = parseInitVar(content);
                initvar = deepMerge(initvar, parsed);
            }
            report.note(`已解析 ${initEntries.length} 个 [initvar] 条目（合并）：顶层组 ${Object.keys(initvar).join('、') || '（空）'}。`);
        } else {
            // MVU 规范：额外问候语中的 <initvar> 块会覆盖世界书 [InitVar]，也作为结构来源
            const greetingSources = [data.first_mes, ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])];
            const blockRe = /<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/gi;
            for (const g of greetingSources) {
                let m;
                while ((m = blockRe.exec(String(g || '')))) {
                    greetingBlockCount++;
                    const parsed = parseInitVar(m[1]);
                    initvar = deepMerge(initvar, parsed);
                }
            }
            if (greetingBlockCount) {
                report.note(`角色卡世界书未找到 [InitVar]，已改用额外问候语中的 ${greetingBlockCount} 个 <initvar> 块推导结构。`);
            }
        }
        if (!initEntries.length && Object.keys(initvar).length === 0) {
            const msg =
                `未找到 [InitVar] 世界书条目，无法识别为 MVU 变量卡。` +
                `（当前角色卡：${data.name || '未知'}；世界书条目数=${entries.length}；` +
                `first_mes/额外问候语中 <initvar> 块数=${greetingBlockCount}。）` +
                `MVU 变量卡必须在世界书条目 comment 中含 [InitVar]（可禁用状态），或在问候语中用 <initvar> 声明初始结构。` +
                (entries.length === 0 ? `若角色列表里的对象不包含世界书数据，请改用「选择文件」导入卡文件后转换。` : `若 [InitVar] 写在全局世界书/联动世界书中，请将其并入卡内后重试。`) +
                `已中止转换，卡未被修改。`;
            console.error('[mvu2db] ' + msg);
            const e = new Error(msg);
            e.code = 'NOT_MVU_CARD';
            throw e;
        }
        if (Object.keys(initvar).length === 0) {
            const e = new Error('已找到 [InitVar] 条目但解析后为空，无法推导表格结构。已中止转换，卡未被修改。');
            e.code = 'EMPTY_INITVAR';
            throw e;
        }

        const usage = scanStatusUsage(card, Object.keys(initvar));
        report.note(`状态栏/脚本字段扫描：${Object.keys(usage).map(g => `${g}(${usage[g].length})`).join('、') || '无'}。`);

        const shapeInfo = parseMvuShapes(card);
        if (Object.keys(shapeInfo.shapes).length) {
            report.note(`已从 [mvu_update] 结构声明解析列：${Object.keys(shapeInfo.shapes).map(g => `${g}(${shapeInfo.shapes[g].length})`).join('、')}。`);
        }
        const schema = buildSchema(initvar, usage, report, shapeInfo);
        const layout = buildLayout(schema);
        const template = opts.template || generateTemplate(schema, { mode, report });

        // 2. 检测卡内是否依赖 MVU API
        const blobs = cardTextBlobs(card);
        const usesMvu = blobs.some(b => /Mvu\s*\./i.test(b.text));
        const installMvuShim = opts.installMvuShim !== undefined ? !!opts.installMvuShim : usesMvu;

        const bridgeScript = generateBridgeScript(schema, template, {
            mode,
            template,
            installMvuShim,
            appendPlaceholder: opts.appendPlaceholder !== false,
            bridgeScriptName: opts.bridgeScriptName || `${data.name || '角色'}·数据库数据桥`,
        });

        // 3. 世界书处理
        const newEntries = [];
        for (const e of entries) {
            const comment = String(e.comment || '');
            const content = String(e.content || '');
            const isInit = /\[initvar\]/i.test(comment);
            // MVU 变量输出/更新规则条目：comment 或 content 命中 MVU 专属标记即删除
            // （教程示例“蓝灯 D1”comment 是任意名字，必须靠 content 里的专属宏识别）
            const mvuMarker = /\[mvu[ _-]?update\]|\[mvuupdate\]|变量列表|变量输出格式|status_current_variables?|format_message_variable|get_message_variable|<UpdateVariable|<JSONPatch|<initvar>|\.set\s*\(\s*['"]/i;
            const isMvuUpdate = mvuMarker.test(comment) || (mvuMarker.test(content) && /stat_data|UpdateVariable|JSONPatch|status_current_variable|get_message_variable|format_message_variable/i.test(content));
            if (isInit || isMvuUpdate) {
                report.note(`已删除 MVU 世界书条目「${comment}」（${isInit ? '初始变量' : '更新规则'}已迁移为数据库模板/规则）。`);
                continue;
            }
            // EJS 重写
            const rw = rewriteEjsConditions(content, layout, report);
            if (rw.items.length) {
                for (const it of rw.items) {
                    if (it.status === 'auto') {
                        report.auto(`条目「${comment}」EJS 条件已重写为 <if ${it.aggregate ? 'db' : 'cell/cond'}>：\`${it.rewritten}\``);
                    }
                }
            }
            const copy = deepClone(e);
            copy.content = rw.text;
            newEntries.push(copy);
        }
        // 把模板以 base64 写入世界书条目（keys: __ACU_TEMPLATE_DATA__），供插件/开场页按需导入
        const tplB64 = toBase64(JSON.stringify(template));
        const maxId = entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
        newEntries.push({
            id: maxId + 1,
            keys: ['__ACU_TEMPLATE_DATA__'],
            comment: 'SP·数据库 表格模板（勿删勿改）',
            content: tplB64,
            enabled: true,
            constant: false,
            selective: false,
            position: 'before_char',
            insertion_order: 9990,
            depth: 2,
            prevent_recursion: true,
            use_regex: false,
        });
        report.note('已把表格模板写入世界书条目 __ACU_TEMPLATE_DATA__（base64），供扩展/卡内桥在开局时自动建表（对应 MVU 的 init 时机，调用 SP·数据库 的 initGameSession）。');
        cb.entries = newEntries;

        // 4. 正则处理
        const regexes = Array.isArray(data.extensions && data.extensions.regex_scripts) ? data.extensions.regex_scripts : [];
        const keptRegexes = [];
        for (const r of regexes) {
            const name = String(r.scriptName || '');
            if (isMvuRegex(r)) {
                report.note(`已移除 MVU 专属正则「${name}」（解析 <UpdateVariable>/format_message_variable 等 MVU 语法）。`);
                continue;
            }
            if (/状态栏|placeholder/i.test(name)) {
                const patched = patchStatusBarMvuEvents(r.replaceString || '');
                if (patched.count) {
                    report.auto(`正则「${name}」的状态栏刷新事件已由 Mvu.events.VARIABLE_UPDATE_ENDED 改为监听 shujuku-table-updated。`);
                }
                const copy = deepClone(r);
                copy.replaceString = patched.text;
                if (!copy.replaceString && r.replaceString) copy.replaceString = r.replaceString;
                keptRegexes.push(copy);
                continue;
            }
            if (isMvuScriptContent(r.replaceString || '')) {
                report.manual(`正则「${name}」含 MVU API 调用；转换器保留它并依赖数据桥 MVU 兼容层，若逻辑异常请人工改为数据库 API。`);
            }
            keptRegexes.push(deepClone(r));
        }
        if (data.extensions) data.extensions.regex_scripts = keptRegexes;

        // 5. tavern_helper 脚本处理
        const th = (data.extensions && data.extensions.tavern_helper) || {};
        const scripts = Array.isArray(th.scripts) ? th.scripts : [];
        const keptScripts = [];
        for (const s of scripts) {
            const content = String(s.content || '');
            if (isMvuScriptContent(content)) {
                report.note(`已移除 tavern_helper 脚本「${s.name}」（MVU 相关：${content.slice(0, 80)}…）。`);
                continue;
            }
            report.manual(`保留 tavern_helper 脚本「${s.name}」（未检测到 MVU API；若依赖 MVU 变量请人工检查）。`);
            keptScripts.push(deepClone(s));
        }
        keptScripts.push({
            name: opts.bridgeScriptName || `${data.name || '角色'}·数据库数据桥`,
            enabled: true,
            content: bridgeScript,
        });
        th.scripts = keptScripts;
        if (!data.extensions) data.extensions = {};
        if (!data.extensions.tavern_helper) data.extensions.tavern_helper = {};
        data.extensions.tavern_helper = th;

        // 6. 转换标记
        if (!data.extensions) data.extensions = {};
        const origName = data.name || '角色';
        if (nameSuffix && !String(data.name || '').endsWith(nameSuffix)) {
            data.name = String(data.name || '') + nameSuffix;
            report.note(`角色卡名已追加后缀：${origName} → ${data.name}。`);
        }
        // 世界书独立：内嵌世界书与外部世界书引用都加后缀，
        // 避免导入转换卡时以同名覆盖原卡的世界书。
        if (data.character_book && typeof data.character_book.name === 'string' && nameSuffix) {
            const bookName = data.character_book.name;
            if (bookName && !bookName.endsWith(nameSuffix)) {
                data.character_book.name = bookName + nameSuffix;
                report.note(`内嵌世界书名称已追加后缀：${bookName} → ${data.character_book.name}（避免同名覆盖）。`);
            }
        }
        if (data.extensions && typeof data.extensions.world === 'string' && nameSuffix) {
            const worldName = data.extensions.world;
            if (worldName && !worldName.endsWith(nameSuffix)) {
                data.extensions.world = worldName + nameSuffix;
                report.note(`外部世界书引用已追加后缀：${worldName} → ${data.extensions.world}。`);
            }
        }
        data.extensions.mvu2db = {
            converter: 'mvu2db',
            version: VERSION,
            mode,
            convertedAt: new Date().toISOString(),
            originalName: origName,
            templateUid: Object.keys(template).filter(k => k.startsWith('sheet_')).map(k => template[k].uid),
            note: '由 MVU 变量角色卡转换而来；表格数据由 SP·数据库 插件维护，状态栏通过数据桥读取。',
        };

        return { card, schema, layout, template, bridgeScript, report };
    }

    /**
     * 转换入口。
     * input: 角色卡对象 / JSON 字符串 / PNG ArrayBuffer|Uint8Array
     * opts: { mode, asPng, ...transformCard opts }
     * 返回 { card, template, reportText, files, meta }
     *   files: [{ name, mime, data(字符串|Uint8Array), kind }]
     */
    function convert(input, opts = {}) {
        const report = createReport();
        const sourceCard = parseCard(input);
        const isPngInput = (() => {
            try {
                if (input && typeof input === 'object' && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) return false;
                const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array((input && input.buffer) || input, (input && input.byteOffset) || 0, (input && input.byteLength) || input.length);
                return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
            } catch (e) { return false; }
        })();
        const mode = opts.mode || 'both';
        report.note(`模式：${mode === 'both' ? 'native + SQLite 双模式（DDL 与 DSL/SQL 说明都写入模板）' : mode === 'native' ? 'native（AI 输出 insertRow/updateRow/deleteRow DSL）' : 'sqlite（AI 输出 SQL）'}。`);

        const { card, schema, template, bridgeScript } = transformCard(sourceCard, { ...opts, mode, report });

        const files = [];
        const cardName = ((card.data || card).name || 'converted').replace(/[\\/:*?"<>|]/g, '_');
        const asPng = opts.asPng !== false && isPngInput;
        if (asPng && input) {
            const png = writeCardPng(input, card);
            files.push({ name: `${cardName}-DB.png`, mime: 'image/png', data: png, kind: 'card' });
        } else {
            files.push({ name: `${cardName}-DB.json`, mime: 'application/json', data: JSON.stringify(card, null, 2), kind: 'card' });
        }
        files.push({ name: `${cardName}-表格模板.json`, mime: 'application/json', data: JSON.stringify(template, null, 2), kind: 'template' });
        files.push({ name: `${cardName}-转换报告.md`, mime: 'text/markdown', data: report.toMarkdown(), kind: 'report' });
        files.push({ name: `${cardName}-数据桥.js`, mime: 'text/javascript', data: bridgeScript, kind: 'bridge' });

        return {
            card,
            template,
            schema,
            bridgeScript,
            report,
            reportText: report.toMarkdown(),
            files,
            meta: { mode, isPngInput, asPng, tableCount: schema.length, tableNames: schema.map(g => g.tableName) },
        };
    }

    /* ================================================================
     * 原生扩展装配（assembleExtension）
     * 生成 { manifest, index.js, style.css, README }
     * index.js = 核心源码 + UI（自包含，可直接放入 SillyTavern 扩展目录）
     * ================================================================ */

    function extensionManifest(opts = {}) {
        return {
            display_name: 'MVU转数据库',
            loading_order: 300,
            requires: [],
            optional: [],
            dependencies: [],
            js: 'index.js',
            css: 'style.css',
            author: 'mvu2db',
            version: VERSION,
            homePage: 'https://github.com/wmdl2/mvu2shujuku',
            auto_update: false,
            minimum_client_version: '1.12.0',
        };
    }

    function extensionStyle() {
        return [
            '#mvu2db-settings .mvu2db-card {',
            '  border: 1px solid var(--SmartThemeBorderColor, #555);',
            '  border-radius: 8px;',
            '  padding: 12px;',
            '  margin: 8px 0;',
            '  background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.2));',
            '}',
            '#mvu2db-settings .mvu2db-row {',
            '  margin: 8px 0;',
            '  display: flex;',
            '  flex-wrap: wrap;',
            '  gap: 8px;',
            '  align-items: center;',
            '}',
            '#mvu2db-settings .mvu2db-row > * { flex: 0 0 auto; }',
            '#mvu2db-settings .menu_button {',
            '  width: auto;',
            '  white-space: nowrap;',
            '  background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.10));',
            '  border: 1px solid var(--SmartThemeBorderColor, #888);',
            '  border-radius: 6px;',
            '  padding: 5px 12px;',
            '  cursor: pointer;',
            '  color: var(--SmartThemeBodyColor, inherit);',
            '}',
            '#mvu2db-settings .menu_button:hover {',
            '  background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.20));',
            '  border-color: var(--SmartThemeBorderColor, #ccc);',
            '}',
            '#mvu2db-settings .menu_button[style*="display:none"] { display: none !important; }',
            '#mvu2db-settings .mvu2db-label { display: block; margin-bottom: 4px; font-weight: 600; }',
            '#mvu2db-settings .mvu2db-mode-group label { margin-right: 12px; }',
            '#mvu2db-settings .mvu2db-help {',
            '  font-size: 12px; opacity: 0.8;',
            '  margin: 4px 0 10px; padding: 6px 8px;',
            '  border-left: 3px solid var(--SmartThemeBorderColor, #666);',
            '  background: rgba(0,0,0,0.15);',
            '}',
            '#mvu2db-settings .mvu2db-help code { font-family: monospace; background: rgba(255,255,255,0.1); padding: 0 3px; border-radius: 3px; }',
            '#mvu2db-settings textarea.mvu2db-report {',
            '  width: 100%; min-height: 220px;',
            '  font-family: monospace; font-size: 12px;',
            '  white-space: pre-wrap; word-break: break-all;',
            '  background: var(--SmartThemeBlurTintColor, #111);',
            '  color: var(--SmartThemeBodyColor, #ddd);',
            '}',
            '#mvu2db-settings .mvu2db-downloads button { margin: 4px 6px 4px 0; }',
            '#mvu2db-settings .mvu2db-hint { font-size: 12px; opacity: 0.75; }',
        ].join('\n');
    }

    function extensionIndexUi() {
        // 返回 index.js 的 UI 部分（不含核心源码）
        return String.raw`
// ============================================================
// MVU转数据库 · SillyTavern 原生扩展 UI
// 依赖上方内联的核心源码（MVU2DB_CORE）
// ============================================================
(function () {
    'use strict';

    const PLUGIN_ID = 'mvu2db';
    const PANEL_ID = PLUGIN_ID + '-settings';
    const SETTINGS_KEY = 'mvu2db';
    const state = { timer: null };

    // 开局建表核心流程（与卡内数据桥同一份逻辑：缺表时调用 SP·数据库 的 initGameSession）
${DB_INIT_SNIPPET}

    const DB_TEMPLATE_KEY = '__ACU_TEMPLATE_DATA__';
    const autoInitState = { running: false, done: '', inited: false, retries: 0 };

    function autoInitChatId() {
        try {
            const context = getContextSafe();
            return String(context.chatId || context.chat_id || context.chatFile || context.chatFileName || 'unknown');
        } catch (e) { return 'unknown'; }
    }

    // 对应 MVU 的 init 时机：进入聊天/收到首条消息时，若卡内有模板且表格缺失则自动建表。
    // 只处理本转换器产出的卡（世界书含 __ACU_TEMPLATE_DATA__），其余卡一律不动。
    async function autoInitDatabase() {
        if (autoInitState.running) return;
        const api = getAcuApi();
        if (!api) return;
        let character = null;
        try { character = currentCharacter(); } catch (e) {}
        if (!character) return;
        const cb = character.character_book;
        if (!(cb && Array.isArray(cb.entries) && cb.entries.length)) {
            try { character = await fetchFullCharacter(character); } catch (e) {}
        }
        const fullCb = character && character.character_book;
        const entries = fullCb && Array.isArray(fullCb.entries) ? fullCb.entries : [];
        const entry = entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) !== -1);
        if (!entry || !entry.content) return;
        const key = autoInitChatId();
        if (autoInitState.done === key) return;
        autoInitState.running = true;
        try {
            const presetName = String((character && character.name) || '') + '模板';
            const out = await mvu2dbEnsureInit(api, entry.content, presetName);
            if (out.status === 'error' || out.status === 'partial') {
                console.warn('[mvu2db] 开局自动建表未完全成功：' + out.message);
                autoInitState.done = '';
                // 开场白切换/重渲染可能打断插件初始化；轮询重试直到建表成功（最多约 1 分钟）
                autoInitState.retries += 1;
                if (autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
            } else {
                console.log('[mvu2db] 开局自动建表：' + out.message);
                autoInitState.retries = 0;
                autoInitState.done = key;
            }
        } catch (e) {
            console.warn('[mvu2db] 开局自动建表异常：' + (e && e.message ? e.message : e));
            autoInitState.done = '';
            autoInitState.retries += 1;
            if (autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
        } finally {
            autoInitState.running = false;
        }
    }

    function bindAutoInit(context) {
        const es = context && (context.eventSource || context.event_source);
        const et = context && (context.event_types || context.eventTypes);
        if (!es || !et || typeof es.on !== 'function') return;
        try {
            if (!autoInitState.inited) {
                es.on(et.CHAT_CHANGED, () => {
                    autoInitState.retries = 0;
                    hostWindow.setTimeout(autoInitDatabase, 600);
                });
                es.on(et.MESSAGE_RECEIVED, () => hostWindow.setTimeout(autoInitDatabase, 600));
                autoInitState.inited = true;
            }
        } catch (e) {}
    }

    function getHostWindow() {
        try {
            if (window.parent && window.parent !== window && window.parent.document) return window.parent;
        } catch (_) {}
        return window;
    }
    const hostWindow = getHostWindow();
    const hostDocument = hostWindow.document || document;

    function getContextSafe() {
        if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
            throw new Error('SillyTavern.getContext() 不可用：请确认当前运行在 SillyTavern 原生扩展环境内');
        }
        return window.SillyTavern.getContext();
    }

    // 查找 SP·数据库 插件暴露的 window.AutoCardUpdaterAPI（兼容 iframe/顶层窗口）
    function getAcuApi() {
        const roots = [];
        const add = (r) => { try { if (r && roots.indexOf(r) === -1) roots.push(r); } catch (e) {} };
        add(window);
        try { add(window.parent); } catch (e) {}
        try { add(window.top); } catch (e) {}
        for (const r of roots) {
            try {
                const a = r.AutoCardUpdaterAPI;
                if (a && typeof a.importTemplateFromData === 'function') return a;
            } catch (e) {}
        }
        return null;
    }

    function getSettings() {
        const context = getContextSafe();
        if (!context.extensionSettings) context.extensionSettings = {};
        if (!context.extensionSettings[SETTINGS_KEY]) {
            context.extensionSettings[SETTINGS_KEY] = {
                mode: 'both',
                installMvuShim: 'auto',
                appendPlaceholder: true,
                asPng: 'auto',
            };
        }
        return context.extensionSettings[SETTINGS_KEY];
    }

    function saveSettings() {
        try {
            const context = getContextSafe();
            if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
            else if (typeof context.saveSettings === 'function') context.saveSettings();
        } catch (e) {}
    }

    function toast(message, type) {
        try {
            if (hostWindow.toastr && typeof hostWindow.toastr[type || 'info'] === 'function') {
                hostWindow.toastr[type || 'info'](message, 'MVU转数据库');
                return;
            }
        } catch (e) {}
        console.log('[mvu2db][' + (type || 'info') + ']', message);
    }

    function download(name, mime, data) {
        let blob;
        if (typeof data === 'string') blob = new Blob([data], { type: mime });
        else blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = hostDocument.createElement('a');
        a.href = url;
        a.download = name;
        hostDocument.body.appendChild(a);
        a.click();
        hostDocument.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function currentCharacter() {
        const context = getContextSafe();
        try {
            if (context.characters && context.characterId != null) return context.characters[context.characterId];
        } catch (e) {}
        try {
            const st = hostWindow.SillyTavern_API || hostWindow.SillyTavern;
            if (st && st.characters && st.characterId != null) return st.characters[st.characterId];
        } catch (e) {}
        return null;
    }

    function populateCharacterSelect(panel, context) {
        const sel = panel.querySelector('#mvu2db-char-select');
        if (!sel) return;
        const chars = Array.isArray(context.characters) ? context.characters : [];
        const currentIdx = context.characterId != null ? context.characterId : -1;
        const prevValue = sel.value;
        panel.__mvu2dbChars = chars;
        panel.__mvu2dbCurrentIdx = currentIdx;
        const searchBox = panel.querySelector('#mvu2db-char-search');
        const keyword = searchBox ? String(searchBox.value || '').trim().toLowerCase() : '';
        sel.innerHTML = '';
        const filtered = keyword
            ? chars.map((ch, i) => ({ ch, i })).filter(({ ch }) => String(ch && ch.name || '').toLowerCase().includes(keyword))
            : chars.map((ch, i) => ({ ch, i }));
        if (!filtered.length) {
            const opt = hostDocument.createElement('option');
            opt.value = '-1';
            opt.textContent = keyword ? '（无匹配角色）' : '（角色列表为空）';
            sel.appendChild(opt);
            return;
        }
        filtered.forEach(({ ch, i }) => {
            const opt = hostDocument.createElement('option');
            opt.value = String(i);
            opt.textContent = (ch && ch.name) ? ch.name : ('角色 ' + i);
            sel.appendChild(opt);
        });
        // 保留原选择；否则优先选当前角色
        if (prevValue !== '' && filtered.some(f => String(f.i) === prevValue)) sel.value = prevValue;
        else if (currentIdx >= 0 && filtered.some(f => f.i === currentIdx)) sel.value = String(currentIdx);
    }

    function selectedCharacter(panel) {
        const sel = panel && panel.querySelector('#mvu2db-char-select');
        if (sel && sel.value !== '' && sel.value !== '-1') {
            const idx = Number(sel.value);
            const context = getContextSafe();
            if (context.characters && context.characters[idx]) return context.characters[idx];
        }
        return currentCharacter();
    }

    // 酒馆开启 lazyLoadCharacters 时，角色列表对象只有元数据（无世界书）。
    // 通过 /api/characters/get 按头像取完整卡数据。
    async function fetchFullCharacter(character) {
        if (!character) return null;
        const cb = character.character_book;
        if (cb && Array.isArray(cb.entries) && cb.entries.length) return character;
        console.log('[mvu2db] 角色列表对象缺世界书，尝试 /api/characters/get 取完整卡。avatar=', character.avatar, 'name=', character && character.name);
        try {
            const context = getContextSafe();
            const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar_url: character.avatar }),
            });
            console.log('[mvu2db] /api/characters/get 状态:', res.status);
            if (res.ok) {
                const full = await res.json();
                const target = (full && full.data && full.data.character_book) ? full.data : full;
                console.log('[mvu2db] 完整卡对象 keys:', Object.keys(full || {}).join(','), '| character_book.entries=', target && target.character_book ? target.character_book.entries.length : 'N/A');
                if (target && target.character_book && Array.isArray(target.character_book.entries) && target.character_book.entries.length) return target;
            }
        } catch (e) {}
        return character;
    }

    function readFileAsBytes(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    let lastResult = null;

    async function doConvert(inputBytes, sourceIsPng) {
        const settings = getSettings();
        const core = window.MVU2DB_CORE;
        if (!core || typeof core.convert !== 'function') {
            throw new Error('转换核心未加载（MVU2DB_CORE 不可用）');
        }
        const mode = settings.mode === 'native' ? 'native' : settings.mode === 'sqlite' ? 'sqlite' : 'both';
        const opts = {
            mode,
            asPng: settings.asPng === 'auto' ? sourceIsPng : settings.asPng === 'png',
            appendPlaceholder: settings.appendPlaceholder !== false,
        };
        if (settings.installMvuShim !== 'auto') {
            opts.installMvuShim = settings.installMvuShim === 'yes';
        }
        const result = core.convert(inputBytes, opts);
        if (inputBytes instanceof Uint8Array || inputBytes instanceof ArrayBuffer) {
            result.meta.avatarBytes = inputBytes;
            result.meta.avatarMime = sourceIsPng ? 'image/png' : 'application/json';
        }
        lastResult = result;
        renderResult(result);
        return result;
    }

    async function fetchAvatarBlob(character) {
        const context = getContextSafe();
        const ch = character || currentCharacter();
        if (!ch || !ch.avatar) return null;
        try {
            const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
            const res = await fetch('/characters/' + encodeURIComponent(ch.avatar), { headers });
            if (!res.ok) return null;
            return await res.blob();
        } catch (e) {
            return null;
        }
    }

    async function saveCardToSillyTavern() {
        if (!lastResult) {
            toast('请先转换', 'error');
            return false;
        }
        const panel = hostDocument.getElementById(PANEL_ID);
        const context = getContextSafe();
        const log = [];
        const displayName = ((lastResult.card && (lastResult.card.data || lastResult.card).name) || '角色');
        try {
            // 统一成 chara_card_v3 包装（服务端按 json_data 整体导入，保留世界书等全部内容）
            let cardData = lastResult.card;
            if (cardData && !cardData.data && cardData.name) {
                cardData = { spec: 'chara_card_v3', spec_version: '3.0', data: cardData };
            }
            let avatarBlob = null;
            if (lastResult.meta && lastResult.meta.avatarBytes) {
                avatarBlob = new Blob([lastResult.meta.avatarBytes], { type: lastResult.meta.avatarMime || 'application/json' });
            } else {
                avatarBlob = await fetchAvatarBlob(selectedCharacter(panel));
            }

            // 优先用新版 API；老版本 createCharacterData 是表单状态对象时走直接接口
            let saved = false;
            if (typeof context.createCharacterData === 'function') {
                await context.createCharacterData(undefined, avatarBlob || new Blob(), cardData, false);
                saved = true;
            } else {
                // 直接走 /api/characters/create：必须把角色卡所有字段都放进表单，
                // 服务端 charaFormatData 会用表单字段覆盖卡内同名字段，缺字段会被清空。
                const d = cardData.data || cardData;
                const ex = d.extensions || {};
                const dp = ex.depth_prompt || {};
                const appendStr = (key, value) => {
                    if (value !== undefined && value !== null) formData.append(key, String(value));
                };
                const formData = new FormData();
                formData.append('ch_name', displayName);
                formData.append('json_data', JSON.stringify(cardData));
                appendStr('description', d.description);
                appendStr('personality', d.personality);
                appendStr('scenario', d.scenario);
                appendStr('first_mes', d.first_mes);
                appendStr('mes_example', d.mes_example);
                appendStr('creator_notes', d.creator_notes);
                appendStr('system_prompt', d.system_prompt);
                appendStr('post_history_instructions', d.post_history_instructions);
                appendStr('creator', d.creator);
                appendStr('character_version', d.character_version);
                appendStr('talkativeness', d.talkativeness !== undefined ? d.talkativeness : ex.talkativeness);
                appendStr('fav', ex.fav === true);
                appendStr('world', ex.world);
                appendStr('depth_prompt_prompt', dp.prompt);
                appendStr('depth_prompt_depth', dp.depth);
                appendStr('depth_prompt_role', dp.role);
                const tags = Array.isArray(d.tags) ? d.tags.join(',') : d.tags;
                appendStr('tags', tags);
                const greetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : (d.alternate_greetings ? [d.alternate_greetings] : []);
                for (const g of greetings) formData.append('alternate_greetings', g);
                formData.append('extensions', JSON.stringify(ex));
                if (avatarBlob) formData.append('avatar', avatarBlob, 'avatar.png');
                const headers = typeof context.getRequestHeaders === 'function'
                    ? context.getRequestHeaders({ omitContentType: true })
                    : {};
                const res = await fetch('/api/characters/create', {
                    method: 'POST',
                    headers,
                    body: formData,
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                saved = true;
            }
            if (!saved) throw new Error('角色卡保存失败（未知原因）');
            log.push('✓ 角色卡已保存：' + displayName);
            if (typeof context.getCharacters === 'function') {
                try {
                    await context.getCharacters();
                    if (panel) populateCharacterSelect(panel, context);
                } catch (e) {}
            }
        } catch (e) {
            const msg = (e && e.message ? e.message : e);
            toast('保存失败，已回退到下载：' + msg, 'error');
            for (const f of lastResult.files) {
                if (f.kind === 'card') download(f.name, f.mime, f.data);
            }
            showInfoPopup('保存失败', '角色卡保存失败，已回退到下载。\n\n' + msg + '\n\n如需排查请把此日志发给开发者。');
            return false;
        }

        // 第二步：把表格模板存为插件的“全局模板预设”（失败不阻断角色卡保存）
        let presetName = '';
        const acu = getAcuApi();
        if (acu && lastResult.template) {
            presetName = displayName + '模板';
            try {
                const presetResult = await acu.importTemplateFromData(lastResult.template, { scope: 'global', presetName });
                if (presetResult && presetResult.success === false) {
                    log.push('✗ 表格模板导入插件失败：' + (presetResult.message || '未知原因'));
                } else {
                    log.push('✓ 表格模板已保存为插件预设：' + presetName);
                }
            } catch (e) {
                log.push('✗ 表格模板导入插件异常：' + (e && e.message ? e.message : e));
            }
        } else {
            log.push('⚠ 未找到 SP·数据库 插件 API，模板未导入（可下载“表格模板 JSON”手动导入插件）。');
        }

        // 第三步：弹窗汇总
        const hasError = log.some(line => line.startsWith('✗'));
        const body = log.join('\n') + (hasError
            ? '\n\n有失败项，请把上方日志发给开发者排查。'
            : (presetName
                ? '\n\n进入新聊天且表格为空时会自动建表，无需手动切换；模板已存为插件预设「' + presetName + '」备用，也可在插件模板面板手动切换。'
                : ''));
        showInfoPopup(hasError ? '保存完成（有失败项）' : '保存完成', body);
        return !hasError;
    }

    // 弹窗：优先用酒馆通用弹窗，失败退回 toast
    function showInfoPopup(title, body) {
        const context = getContextSafe();
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        try {
            if (context.callGenericPopup && context.POPUP_TYPE) {
                const html = '<h3>' + esc(title) + '</h3><pre style="white-space:pre-wrap;text-align:left;max-height:50vh;overflow:auto;">' + esc(body) + '</pre>';
                context.callGenericPopup(html, context.POPUP_TYPE.TEXT, '', { okButton: '知道了' });
                return;
            }
        } catch (e) {}
        try {
            if (hostWindow.alert) hostWindow.alert(title + '\n\n' + body);
        } catch (e2) {}
        toast(title + '：' + body, 'info');
    }

    function renderResult(result) {
        const panel = hostDocument.getElementById(PANEL_ID);
        if (!panel) return;
        const box = panel.querySelector('.mvu2db-result');
        if (!box) return;
        box.innerHTML = '';
        const head = hostDocument.createElement('div');
        head.className = 'mvu2db-row';
        head.innerHTML = '<b>转换完成</b>：' + result.meta.tableCount + ' 张表（' + result.meta.tableNames.join('、') + '）';
        box.appendChild(head);
        const downloads = hostDocument.createElement('div');
        downloads.className = 'mvu2db-downloads mvu2db-row';
        for (const f of result.files) {
            const btn = hostDocument.createElement('button');
            btn.className = 'menu_button';
            btn.textContent = '下载 ' + f.name;
            btn.addEventListener('click', () => download(f.name, f.mime, f.data));
            downloads.appendChild(btn);
        }
        box.appendChild(downloads);
        const report = hostDocument.createElement('textarea');
        report.className = 'mvu2db-report';
        report.value = result.reportText;
        report.readOnly = true;
        box.appendChild(report);
        // 转换完成后才出现“保存到 sillytavern”按钮
        const saveBtn = panel.querySelector('#mvu2db-save-card');
        if (saveBtn) saveBtn.style.display = '';
        toast('转换完成，共 ' + result.meta.tableCount + ' 张表');
    }

    function findSettingsMount() {
        const selectors = [
            '#extensions_settings2',
            '#extensions_settings',
            '#third_party_extension_settings',
            '.extensions_settings',
        ];
        for (const selector of selectors) {
            const node = hostDocument.querySelector(selector);
            if (node) return node;
        }
        return null;
    }

    function renderSettingsPanel(panel) {
        const settings = getSettings();
        panel.innerHTML = [
            '<div class="inline-drawer">',
            '  <div class="inline-drawer-toggle inline-drawer-header">',
            '    <b>MVU转数据库</b>',
            '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>',
            '  </div>',
            '  <div class="inline-drawer-content">',
            '    <div class="mvu2db-card">',
            '      <div class="mvu2db-row">',
            '        <label class="mvu2db-label" for="mvu2db-char-select">选择角色卡</label>',
            '        <input id="mvu2db-char-search" type="text" placeholder="搜索角色…" title="输入角色名过滤下拉列表" />',
            '        <select id="mvu2db-char-select" title="从酒馆角色列表选择要转换的角色卡"></select>',
            '        <button id="mvu2db-pick-file" class="menu_button" title="从磁盘选择 .json / .png 角色卡文件">选择文件…</button>',
            '        <input id="mvu2db-file" type="file" accept=".json,.png,application/json,image/png" hidden />',
            '        <span id="mvu2db-file-name" class="mvu2db-hint"></span>',
            '      </div>',
            '      <div class="mvu2db-row mvu2db-mode-group">',
            '        <span class="mvu2db-label" title="native：AI 输出 insertRow/updateRow/deleteRow DSL；sqlite：AI 输出 SQL；双模式跟随插件当前设置">填表模式</span>',
            '        <label><input type="radio" name="mvu2db-mode" value="both" ' + (settings.mode === 'both' ? 'checked' : '') + ' /> 双模式（推荐）</label>',
            '        <label><input type="radio" name="mvu2db-mode" value="native" ' + (settings.mode === 'native' ? 'checked' : '') + ' /> native（insertRow DSL）</label>',
            '        <label><input type="radio" name="mvu2db-mode" value="sqlite" ' + (settings.mode === 'sqlite' ? 'checked' : '') + ' /> sqlite（SQL）</label>',
            '      </div>',
            '      <div class="mvu2db-row">',
            '        <label class="mvu2db-label" for="mvu2db-shim">MVU 兼容层</label>',
            '        <select id="mvu2db-shim">',
            '          <option value="auto" ' + (settings.installMvuShim === 'auto' ? 'selected' : '') + '>自动（检测到 MVU API 才装）</option>',
            '          <option value="yes" ' + (settings.installMvuShim === 'yes' ? 'selected' : '') + '>总是安装</option>',
            '          <option value="no" ' + (settings.installMvuShim === 'no' ? 'selected' : '') + '>不安装</option>',
            '        </select>',
            '      </div>',
            '      <div class="mvu2db-help">',
            '        MVU（MagVarUpdate）是旧角色卡用的变量框架：游戏状态存在 <code>stat_data</code>，脚本/状态栏通过 MVU API 读写变量',
            '        （入口是全局对象 <code>Mvu</code>，方法 <code>getMvuData</code> / <code>replaceMvuData</code>）。',
            '        转换后数据桥会提供同名兼容对象，把旧脚本的 MVU API 调用自动翻译成数据库操作，旧脚本才能继续工作。',
            '        若卡片脚本没用到 MVU API，选“不安装”即可。',
            '      </div>',
            '      <div class="mvu2db-row">',
            '        <label title="状态栏刷新由数据库表格更新回调驱动；此选项额外在 AI 回复结束时补一次刷新并处理消息里的 <UpdateVariable>/<json_patch> 更新块"><input type="checkbox" id="mvu2db-placeholder" ' + (settings.appendPlaceholder !== false ? 'checked' : '') + ' /> 表格更新后自动刷新状态栏（含消息收尾兜底）</label>',
            '      </div>',
            '      <div class="mvu2db-help">',
            '        状态栏刷新以「表格更新回调」为主：数据库一有变动就广播 <code>shujuku-table-updated</code> 事件。',
            '        勾选上方选项后，还会在每次 AI 回复结束时补一次刷新，并顺带处理开场白/消息里的 <code>&lt;UpdateVariable&gt;</code> / <code>&lt;json_patch&gt;</code> 旧式更新块。',
            '      </div>',
            '      <div class="mvu2db-row">',
            '        <label class="mvu2db-label" for="mvu2db-png">输出格式</label>',
            '        <select id="mvu2db-png">',
            '          <option value="auto" ' + (settings.asPng === 'auto' ? 'selected' : '') + '>跟随输入（PNG 输入 → PNG 输出）</option>',
            '          <option value="json" ' + (settings.asPng === 'json' ? 'selected' : '') + '>总是 JSON</option>',
            '          <option value="png" ' + (settings.asPng === 'png' ? 'selected' : '') + '>总是 PNG</option>',
            '        </select>',
            '      </div>',
            '      <div class="mvu2db-row">',
            '        <button id="mvu2db-convert-current" class="menu_button">转换所选角色卡</button>',
            '        <button id="mvu2db-convert-file" class="menu_button">转换所选文件</button>',
            '        <button id="mvu2db-save-card" class="menu_button" style="display:none" title="转换完成后出现：把角色卡保存进 sillytavern 角色列表，并顺带把表格模板存为插件预设">保存角色卡和模板到sillytavern</button>',
            '        <button id="mvu2db-clear" class="menu_button">清空结果</button>',
            '      </div>',
            '      <div class="mvu2db-result"></div>',
            '      <div class="mvu2db-hint">',
            '        前提：已安装 SP·数据库 插件（不自动安装，也不迁移旧聊天）。转换只产出 角色卡 + 表格模板 + 转换报告。',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>',
        ].join('\n');
    }

    function bindSettingsPanel(panel, context) {
        const bind = (id, fn) => {
            const el = panel.querySelector(id);
            if (el && el.dataset.bound !== 'true') {
                el.dataset.bound = 'true';
                el.addEventListener('click', fn);
            }
        };
        populateCharacterSelect(panel, context);
        const searchBox = panel.querySelector('#mvu2db-char-search');
        if (searchBox && searchBox.dataset.bound !== 'true') {
            searchBox.dataset.bound = 'true';
            searchBox.addEventListener('input', () => populateCharacterSelect(panel, context));
        }
        bind('#mvu2db-convert-current', async () => {
            const ch = selectedCharacter(panel);
            if (!ch) { toast('请先在角色卡下拉栏中选择角色', 'error'); return; }
            toast('正在转换…');
            try {
                const full = await fetchFullCharacter(ch);
                console.log('[mvu2db] 待转换对象：name=', full && full.name, '| keys=', Object.keys(full || {}).join(','), '| character_book.entries=', full && full.character_book ? full.character_book.entries.length : 'N/A');
                await doConvert(full, false);
            } catch (e) {
                toast('转换失败：' + (e && e.message ? e.message : e), 'error');
            }
        });
        bind('#mvu2db-pick-file', () => {
            const input = panel.querySelector('#mvu2db-file');
            if (input) input.click();
        });
        const fileInput = panel.querySelector('#mvu2db-file');
        if (fileInput && fileInput.dataset.bound !== 'true') {
            fileInput.dataset.bound = 'true';
            fileInput.addEventListener('change', () => {
                const nameEl = panel.querySelector('#mvu2db-file-name');
                if (nameEl) nameEl.textContent = fileInput.files && fileInput.files.length ? '已选择：' + fileInput.files[0].name : '';
            });
        }
        bind('#mvu2db-convert-file', async () => {
            const input = panel.querySelector('#mvu2db-file');
            if (!input || !input.files || !input.files.length) { toast('请先选择文件', 'error'); return; }
            const file = input.files[0];
            toast('正在转换 ' + file.name + ' …');
            try {
                const bytes = await readFileAsBytes(file);
                const isPng = /\.png$/i.test(file.name) || (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50);
                await doConvert(bytes, isPng);
            } catch (e) {
                toast('转换失败：' + (e && e.message ? e.message : e), 'error');
            }
        });
        bind('#mvu2db-clear', () => {
            lastResult = null;
            const box = panel.querySelector('.mvu2db-result');
            if (box) box.innerHTML = '';
            const saveBtn = panel.querySelector('#mvu2db-save-card');
            if (saveBtn) saveBtn.style.display = 'none';
        });
        bind('#mvu2db-save-card', async () => {
            await saveCardToSillyTavern();
        });
        const modeInputs = panel.querySelectorAll('input[name="mvu2db-mode"]');
        modeInputs.forEach((el) => {
            if (el.dataset.bound !== 'true') {
                el.dataset.bound = 'true';
                el.addEventListener('change', () => {
                    getSettings().mode = panel.querySelector('input[name="mvu2db-mode"]:checked').value;
                    saveSettings();
                });
            }
        });
        const shimSel = panel.querySelector('#mvu2db-shim');
        if (shimSel && shimSel.dataset.bound !== 'true') {
            shimSel.dataset.bound = 'true';
            shimSel.addEventListener('change', () => {
                getSettings().installMvuShim = shimSel.value;
                saveSettings();
            });
        }
        const ph = panel.querySelector('#mvu2db-placeholder');
        if (ph && ph.dataset.bound !== 'true') {
            ph.dataset.bound = 'true';
            ph.addEventListener('change', () => {
                getSettings().appendPlaceholder = ph.checked;
                saveSettings();
            });
        }
        const pngSel = panel.querySelector('#mvu2db-png');
        if (pngSel && pngSel.dataset.bound !== 'true') {
            pngSel.dataset.bound = 'true';
            pngSel.addEventListener('change', () => {
                getSettings().asPng = pngSel.value;
                saveSettings();
            });
        }
    }

    function ensureSettingsPanel(context) {
        const mount = findSettingsMount();
        if (!mount) {
            hostWindow.clearTimeout(state.timer);
            state.timer = hostWindow.setTimeout(() => ensureSettingsPanel(context), 1500);
            return;
        }
        let panel = hostDocument.getElementById(PANEL_ID);
        if (!panel) {
            panel = hostDocument.createElement('section');
            panel.id = PANEL_ID;
            panel.className = PLUGIN_ID + '-settings';
            renderSettingsPanel(panel);
            mount.appendChild(panel);
        }
        bindSettingsPanel(panel, context);
    }

    function main() {
        const context = getContextSafe();
        ensureSettingsPanel(context);
        bindAutoInit(context);
        hostWindow.setTimeout(autoInitDatabase, 1500);
        console.log('[mvu2db] 扩展已加载（' + (window.MVU2DB_CORE ? window.MVU2DB_CORE.VERSION : '核心缺失') + '）');
    }

    try {
        main();
    } catch (error) {
        console.error('[mvu2db] 初始化失败:', error);
        try {
            if (hostWindow.toastr && typeof hostWindow.toastr.error === 'function') {
                hostWindow.toastr.error(error && error.message ? error.message : String(error), 'MVU转数据库');
            }
        } catch (e) {}
    }
})();
`;
    }

    /**
     * 装配原生扩展文件。返回 { manifest, 'index.js', 'style.css', README }
     * opts: { coreSource: mvu2db.js 源码字符串（用于内联） }
     */
    function assembleExtension(opts = {}) {
        const coreSource = opts.coreSource || '';
        const pinyinInline = opts.pinyinInline || '';
        const indexJs = [
            '// MVU转数据库 · SillyTavern 原生扩展',
            '// 生成自 转换器/src/mvu2db.js（' + VERSION + '），核心源码内联如下',
            '// @ts-nocheck',
            '(function (root) {',
            coreSource,
            pinyinInline ? '\n' + pinyinInline : '',
            '})(typeof globalThis !== "undefined" ? globalThis : this);',
            '',
            extensionIndexUi(),
        ].join('\n');
        return {
            'manifest.json': JSON.stringify(extensionManifest(), null, 2),
            'index.js': indexJs,
            'style.css': extensionStyle(),
            'README.md': [
                '# MVU转数据库（SillyTavern 原生扩展）',
                '',
                '把 MVU 变量角色卡转换为 SP·数据库 角色卡。',
                '',
                '## 安装',
                '1. 在 SillyTavern 的 Extensions 面板粘贴本仓库 GitHub 链接，或把本目录放入 `data/<user>/extensions/`。',
                '2. 刷新页面，扩展设置面板出现「MVU转数据库」。',
                '3. 前提：已安装 SP·数据库 插件。',
                '',
                '## 使用',
                '1. 打开扩展设置面板。',
                '2. 选择模式（双模式 / native / sqlite），从下拉栏选择角色卡或选择文件。',
                '3. 点击转换：保存为角色卡（直接进酒馆）或下载 角色卡 + 表格模板 + 转换报告。',
                '',
                '## 说明',
                '- 转换不自动安装数据库插件；不迁移旧聊天；只转换角色卡本身。',
                '- 开局自动建表对应 MVU 的 init 时机：模板以 base64 写入卡内世界书条目（__ACU_TEMPLATE_DATA__），扩展与卡内数据桥在进入聊天/首条消息时按需调用 SP·数据库 的 initGameSession 建表，开场白保持原样。',
                '- 状态栏继续通过 getAllVariables() 读取 stat_data；数据桥会把数据库表格重建为 stat_data 形状。',
                '- 卡内 MVU 相关正则/脚本/更新规则会被移除；依赖 MVU API 的脚本通过 MVU 兼容层尽力适配。',
            ].join('\n'),
        };
    }


    root.MVU2DB_CORE = {
        VERSION,
        parseCard,
        parseCardPng,
        writeCardPng,
        parseInitVar,
        parseScalar,
        leafInfo,
        json5Lite,
        stableHash,
        scanStatusUsage,
        parseMvuShapes,
        buildSchema,
        buildLayout,
        generateTemplate,
        generateBridgeScript,
        rewriteEjsConditions,
        toPinyinSlug,
        transformCard,
        convert,
        assembleExtension,
        extensionManifest,
        extensionStyle,
        createReport,
        defaultExportConfig,
        DEFAULT_UPDATE_CONFIG,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = root.MVU2DB_CORE;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

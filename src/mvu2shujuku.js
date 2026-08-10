/*
 * mvu2shujuku.js — MVU 角色卡 → SP·数据库（神·数据库）角色卡转换器
 *
 * 运行环境：
 *  - 酒馆助手（JS-Slash-Runner）脚本：在 SillyTavern 内运行，提供按钮与下载/建卡流程
 *  - Node.js：`require('./mvu2shujuku.js')` 可测试纯函数核心
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
        'function mvu2shujukuDecodeB64(b){try{var bin=atob(b);var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder("utf-8").decode(bytes);}catch(e){return decodeURIComponent(escape(atob(b)));}}',
        'function mvu2shujukuExpectedTableNames(tpl){var names=[];if(!tpl||typeof tpl!=="object")return names;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(s&&typeof s==="object"&&typeof s.name==="string"&&names.indexOf(s.name)===-1)names.push(s.name);}return names;}',
        'function mvu2shujukuSheetByName(tpl,name){if(!tpl||typeof tpl!=="object")return null;for(var k in tpl){if(k.indexOf("sheet_")===0&&tpl[k]&&tpl[k].name===name)return tpl[k];}return null;}',
        'function mvu2shujukuHasExtraRows(api,tpl){try{var all=api.exportTableAsJson()||{};for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var ts=tpl[k];if(!ts||typeof ts!=="object"||typeof ts.name!=="string")continue;var rs=null;for(var k2 in all){if(k2.indexOf("sheet_")===0&&all[k2]&&all[k2].name===ts.name){rs=all[k2];break;}}if(!rs)continue;var tRows=Array.isArray(ts.content)?ts.content.length-1:0;var rRows=Array.isArray(rs.content)?rs.content.length-1:0;var rSeed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;if(rRows+rSeed>tRows)return true;}return false;}catch(e){return false;}}',
        'function mvu2shujukuTablesSafeToAnchor(api,tpl){try{var all=api.exportTableAsJson()||{};var names=mvu2shujukuExpectedTableNames(tpl);for(var i=0;i<names.length;i++){var name=names[i];var rs=null;for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&all[k].name===name){rs=all[k];break;}}if(!rs)continue;var rows=(Array.isArray(rs.content)?rs.content.length:0)-1;var seed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;var ts=mvu2shujukuSheetByName(tpl,name);var tRows=ts&&Array.isArray(ts.content)?ts.content.length-1:0;if(rows+seed>tRows)return false;if(rows>0&&ts&&Array.isArray(ts.content)&&ts.content[1]&&Array.isArray(rs.content)&&rs.content[1]){var th=ts.content[0]||[];var r1=rs.content[1]||[];for(var ci=1;ci<th.length;ci++){if(String(ts.content[1][ci]==null?"":ts.content[1][ci])!==String(r1[ci]==null?"":r1[ci]))return false;}}}return true;}catch(e){return false;}}',
        'function mvu2shujukuMissingTableNames(api,names){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=true;}var missing=[];for(var i=0;i<names.length;i++){if(!have[names[i]])missing.push(names[i]);}return missing;}',
        'function mvu2shujukuExpectedColumns(tpl){var map={};if(!tpl||typeof tpl!=="object")return map;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(!s||typeof s!=="object"||typeof s.name!=="string")continue;var hdr=Array.isArray(s.content)&&Array.isArray(s.content[0])?s.content[0]:[];var cols=[];for(var i=1;i<hdr.length;i++){if(cols.indexOf(hdr[i])===-1)cols.push(hdr[i]);}map[s.name]=cols;}return map;}',
        'function mvu2shujukuMissingColumns(api,expected){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=all[k];}var mismatch=[];for(var name in expected){var sheet=have[name];if(!sheet)continue;var hdr=Array.isArray(sheet.content)&&Array.isArray(sheet.content[0])?sheet.content[0]:[];var exp=expected[name];for(var i=0;i<exp.length;i++){if(hdr.indexOf(exp[i])===-1){mismatch.push(name+"(缺列:"+exp[i]+")");break;}}}return mismatch;}',
        'var mvu2shujukuInitSessionHung=false;',
        'function mvu2shujukuWithTimeout(promise,ms,label){var done=false;var tid=null;var timeoutPromise=new Promise(function(resolve){tid=setTimeout(function(){if(!done){done=true;resolve({timeout:true,message:label+" 超时("+(ms/1000)+"s)"});}},ms);});return Promise.race([Promise.resolve(promise).then(function(v){if(!done){done=true;if(tid)clearTimeout(tid);}return v;}),timeoutPromise]);}',
        'async function mvu2shujukuEnsureInit(api,b64,presetName,to){var out={status:"skip",message:"",missing:[]};var t1=(to&&to.importMs)||15000;var t2=(to&&to.initMs)||20000;var tpl=null;try{tpl=JSON.parse(mvu2shujukuDecodeB64(b64));}catch(e){out.status="error";out.message="模板解码失败: "+(e&&e.message?e.message:e);return out;}var names=mvu2shujukuExpectedTableNames(tpl);if(!names.length){out.status="error";out.message="模板中没有 sheet_* 表";return out;}out.missing=mvu2shujukuMissingTableNames(api,names);var colMiss=[];var needsImport=out.missing.length>0;if(!needsImport){colMiss=mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));needsImport=colMiss.length>0;}if(!needsImport){var emptyS=[];try{var all2=api.exportTableAsJson()||{};for(var k2 in all2){if(k2.indexOf("sheet_")!==0)continue;var sh2=all2[k2];if(!sh2||typeof sh2!=="object"||typeof sh2.name!=="string")continue;if(Array.isArray(sh2.content)&&sh2.content.length>1)continue;if(Array.isArray(sh2.seedRows)&&sh2.seedRows.length)continue;var ts=mvu2shujukuSheetByName(tpl,sh2.name);if(!ts||!Array.isArray(ts.content)||ts.content.length!==2)continue;emptyS.push(sh2.name);}}catch(e){}if(emptyS.length){for(var ei=0;ei<emptyS.length;ei++){try{var ts2=mvu2shujukuSheetByName(tpl,emptyS[ei]);var hdr2=ts2.content[0];var row2=ts2.content[1];var obj2={};for(var ci=1;ci<hdr2.length;ci++){obj2[hdr2[ci]]=(row2[ci]!==undefined&&row2[ci]!==null)?row2[ci]:"";}await Promise.resolve(api.insertRow(emptyS[ei],obj2));}catch(e){}}out.status="skip";out.message="已为仅表头的单例/JSON表补初始行："+emptyS.join("、");return out;}out.status="skip";out.message="已有全部表格且结构匹配，跳过开局建表";return out;}var steps=[];var initOk=false;if(typeof api.initGameSession==="function"&&!mvu2shujukuInitSessionHung){try{var r2=await mvu2shujukuWithTimeout(api.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:presetName||""}),t2,"initGameSession");if(r2&&r2.timeout){mvu2shujukuInitSessionHung=true;steps.push("initGameSession: 超时，已跳过后续重试");}else if(r2&&r2.success===false){steps.push("initGameSession: "+(r2.message||"失败"));}else{initOk=true;steps.push("initGameSession: 完成"+(r2&&r2.runtimeReady===false?"（运行时未就绪）":""));}}catch(e){steps.push("initGameSession异常: "+(e&&e.message?e.message:e));}}else if(typeof api.initGameSession!=="function"){steps.push("initGameSession: 不可用");}if(!initOk&&typeof api.importTemplateFromData==="function"){try{var r1=await mvu2shujukuWithTimeout(api.importTemplateFromData(tpl,{scope:"chat",presetName:presetName||""}),t1,"importTemplateFromData");steps.push(r1&&r1.timeout?r1.message:(r1&&r1.success===false?("importTemplateFromData: "+(r1.message||"失败")):"importTemplateFromData: 完成"));}catch(e){steps.push("importTemplateFromData异常: "+(e&&e.message?e.message:e));}}out.missing=mvu2shujukuMissingTableNames(api,names);colMiss=out.missing.length?[]:mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));out.status=(out.missing.length||colMiss.length)?"partial":"ok";out.message=steps.join("；")+"；剩余缺表："+(out.missing.length?out.missing.join("、"):"无")+(colMiss.length?"；结构不匹配："+colMiss.join("、"):"");return out;}',
    ].join('\n');

    /* ================================================================
     * 拼音标识符（与 SP·数据库 插件内部的中文→拼音逻辑一致，基于 pinyin-pro 字典）
     * 角色卡的中文组名/字段名 → 拼音 slug，作为 SQLite 物理标识符。
     * 字典来自 转换器/src/pinyin-data.js（生成自 pinyin-pro，MIT）。
     * ================================================================ */

    function getPinyinMap() {
        if (root.__MVU2SHUJUKU_PINYIN__) return root.__MVU2SHUJUKU_PINYIN__;
        try {
            if (typeof require === 'function') {
                root.__MVU2SHUJUKU_PINYIN__ = require('./pinyin-data.js');
                return root.__MVU2SHUJUKU_PINYIN__;
            }
        } catch (e) { /* 浏览器端由扩展构建时内联 */ }
        root.__MVU2SHUJUKU_PINYIN__ = root.__MVU2SHUJUKU_PINYIN__ || {};
        return root.__MVU2SHUJUKU_PINYIN__;
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

    function utf8ToString(bytes) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('utf8');
        return new TextDecoder('utf-8').decode(bytes);
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

    // 最小 1x1 透明 PNG：JSON 输入选择“总是 PNG”时作为基底，写入角色卡数据
    const MINI_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    function miniPngBuffer() {
        if (typeof Buffer !== 'undefined') return Buffer.from(MINI_PNG_B64, 'base64');
        const bin = atob(MINI_PNG_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
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
                // iTXt: compression_flag(1) compression_method(1) language\0 translated_keyword\0 text
                let p = 2; // 跳过压缩标志与方法
                while (p < payload.length && payload[p] !== 0) p++; // 跳过 language（空则立即停）
                p++;
                while (p < payload.length && payload[p] !== 0) p++; // 跳过 translated（空则立即停）
                p++;
                text = utf8ToString(payload.slice(p));
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
            // 无现有 chara 块时，把新块插在 IEND 之前（IEND 之后的块解析器读不到）
            if (chunk.type === 'IEND' && !replaced) {
                out.push(chunkData);
                replaced = true;
            }
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
        // IEND 缺失时的兜底
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
            // EJS 条件里的 getvar('stat_data.组.条目.字段') / getvar('stat_data.组.字段')
            const reGetvar = /getvar\s*\(\s*['"]stat_data\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+))?)?['"]/g;
            let gm;
            while ((gm = reGetvar.exec(text))) {
                const group = gm[1];
                if (!knownGroups.has(group)) continue;
                // 三段式 组.条目.字段 → 条目行表的列；两段式 组.字段 → 单例列（若 initvar 已含则跳过重复）
                const field = gm[3] || gm[2];
                if (field) addField(group, field);
            }
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
                // 状态栏/规则扫描到字段 → 仍可按字段建行表；完全无字段信息 → 整组 JSON（任意形状还原）
                const knownFields = [...(usage[groupName] || []), ...(shapes[groupName] || [])]
                    .filter(f => f !== '名称' && f !== '描述' && f !== '数值' && f !== '内容');
                if (knownFields.length === 0) {
                    report.note(`顶层组「${groupName}」初始为空字典且无字段线索，运行期结构未知，按整组 JSON 存储（任意形状均还原）。`);
                    return 'json';
                }
                report.note(`顶层组「${groupName}」初始为空字典，已按状态栏/规则扫描到的字段建行表。`);
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
                    // 数组表的值列用「内容」（数组项本身），不叫「名称」；行表才用「名称」作业务键
                    const valueZh = isArray ? '内容' : keyCol;
                    const cols = [{ zh: valueZh, path: [groupName, valueZh], value: '', desc: isArray ? '条目内容' : '', type: 'TEXT', ident: toIdent(valueZh, new Set(['row_id']), 'column') }];
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
            if (kind === 'json') {
                // 空字典组：运行期可能是“字典→对象 / 字典→标量 / 组本身是标量”等任意形状，
                // 统一存成单行 JSON（内容列），读取时原样还原；不猜列名。
                const usedJson = new Set(['row_id']);
                const columns = [
                    {
                        zh: keyCol,
                        path: [groupName, keyCol],
                        value: groupName,
                        desc: '唯一标识',
                        type: 'TEXT',
                        ident: toIdent(keyCol, usedJson, 'column'),
                    },
                    {
                        zh: '内容',
                        path: [groupName, '内容'],
                        value: '',
                        desc: '整组数据（JSON 存储，读取时还原任意形状；内部数据，AI 不应直接修改）',
                        type: 'TEXT',
                        ident: toIdent('内容', usedJson, 'column'),
                        isObject: true,
                    },
                ];
                let initial;
                try { initial = JSON.stringify(raw); } catch (e) { initial = '{}'; }
                groups.push({
                    name: groupName,
                    tableName,
                    ident: toIdent(tableName, usedTableIdents, 'table'),
                    kind: 'json',
                    keyCol,
                    keyValue: groupName,
                    columns,
                    rows: [[1, groupName, initial]],
                    childTables: [],
                    source: 'initvar',
                    reminders: ruleReminders[groupName] || [],
                });
                continue;
            }
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
                // 通用溢出列：运行期脚本/前端可能写入模板未声明的动态字段，统一存 JSON，读取时自动还原
                if (!columns.some(c => c.zh === '_扩展数据')) {
                    columns.push({
                        zh: '_扩展数据',
                        path: [groupName, '_扩展数据'],
                        value: '',
                        desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                        type: 'TEXT',
                        range: null,
                        ident: toIdent('_扩展数据', used, 'column'),
                        isObject: true,
                    });
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
                // 单例表：不加业务键列（整表固定一行，row_id=1 即身份；名称列已去掉，避免 stat_data 多出 系统.名称 这类冗余字段）
                const keyValue = groupName;
                const used = new Set(['row_id']);
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
                // 通用溢出列：运行期脚本/前端可能写入模板未声明的动态字段，统一存 JSON，读取时自动还原
                if (!columns.some(c => c.zh === '_扩展数据')) {
                    columns.push({
                        zh: '_扩展数据',
                        path: [groupName, '_扩展数据'],
                        value: '',
                        desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                        type: 'TEXT',
                        range: null,
                        ident: toIdent('_扩展数据', used, 'column'),
                        isObject: true,
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
                if (!columns.some(c => c.zh === '_扩展数据')) {
                    columns.push({
                        zh: '_扩展数据',
                        path: [...ct.path, '_扩展数据'],
                        value: '',
                        desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                        type: 'TEXT',
                        range: null,
                        ident: toIdent('_扩展数据', used, 'column'),
                        isObject: true,
                    });
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
            // 整组 JSON 表：内容不透明，不套用 [mvu_update] 按字段名的规则（避免误命中同名列）
            if (g.kind === 'json') continue;
            const gFormats = ruleFormats[g.name] || {};
            const gChecks = ruleChecks[g.name] || {};
            for (const c of g.columns) {
                // 内部溢出列：不接受按字段名的规则
                if (c.zh === '_扩展数据') continue;
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
            const isSingletonKey = i === 0 && group.kind === 'json';
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
            return `单例表，全表固定一条记录（row_id=1），只做增量更新，不新增、不删除。`;
        }
        if (group.kind === 'json') {
            return `整组 JSON 存储表：本组数据以 JSON 整体保存、读取时还原任意形状（对象/字典/标量）；内部数据，AI 不应直接修改。`;
        }
        if (group.kind === 'array') {
            return '数组表，每行一个元素，通常整体替换。';
        }
        return `条目表，以「${group.keyCol}」为唯一标识；同名记录只存在一行，更新用 UPDATE，新增用 INSERT。`;
    }

    function buildNote(group) {
        const L = [];
        if (group.kind === 'json') {
            L.push(`整组 JSON 存储表（row_id=1）。本表整组数据由脚本/前端读写，AI 不应直接修改本表，也不要新增或删除记录。`);
        } else if (group.kind === 'singleton') {
            // 单例表不重复描述（“全表固定一条记录”等），直接给出开局记录说明
            L.push(`本表唯一记录已由开局模板插入（row_id=1）；填表时禁止 INSERT / DELETE，只允许按需 UPDATE。`);
        } else {
            L.push(`${group.tableName}。${describeGroup(group)}`);
        }
        // JSON 表整组由脚本/前端管理：完全不展示列定义与约束；其余表隐藏内部列（_扩展数据）
        const aiCols = group.kind === 'json' ? [] : group.columns.filter(c => c.zh !== '_扩展数据');
        if (aiCols.length) {
            L.push('【列定义】');
            // 对齐默认模板：列定义只列中文名 + 标识符；字段说明与约束放【强制约束】
            aiCols.forEach((c, i) => L.push(`- 列${i + 1}: ${c.zh} ${c.ident}`));
            L.push('【强制约束】');
            for (const c of aiCols) {
                const parts = [];
                if (c.range) parts.push(`数值范围 ${c.range[0]}~${c.range[1]}`);
                if (c.enum) parts.push(`可选值：${c.enum.join(' / ')}`);
                if (c.format) parts.push(`格式要求：${String(c.format).replace(/\n/g, ' ')}`);
                if (c.isObject) parts.push('对象以 JSON 存储，读取时还原');
                // 真实字段说明（如 [值,说明] 的更新条件）；通用描述（唯一标识/条目名称/JSON 提示）不重复
                const desc = c.desc ? String(c.desc).replace(/\n/g, ' ').trim() : '';
                const generic = desc === '唯一标识' || desc === '条目名称' || desc === '对象（JSON 存储，读取时还原）';
                if (desc && !generic) parts.push(desc);
                if (parts.length) L.push(`- ${c.zh}：${parts.join('；')}`);
                for (const rule of c.check || []) L.push(`- ${c.zh}：${rule}`);
            }
            for (const c of aiCols) {
                if (c.check && c.check.length > 20) L.push(`- ${c.zh}：…（共 ${c.check.length} 条规则，其余略）`);
            }
            (group.reminders || []).forEach(r => L.push(`- 每次回复必须维护：${r}`));
        }
        if (group.kind !== 'json') {
            L.push('只在正文明确造成状态变化时更新对应字段；不得为凑表而虚构数据。');
        }
        return L.join('\n');
    }

    function buildInitNode(group) {
        if (group.kind === 'json') {
            return `开局模板已初始化整组数据（row_id=1）；此后整组 JSON 由脚本/前端写入，自动填表阶段禁止修改本表。`;
        }
        if (group.kind === 'singleton') {
            return `开局模板已包含唯一记录（row_id=1）；自动填表阶段禁止再次初始化，只允许按需 UPDATE。`;
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
        if (group.kind === 'json') {
            if (kind === 'update') return '整组 JSON 由脚本/前端整体写入，AI 不应直接修改本表。';
            return '禁止。';
        }
        if (group.kind === 'singleton') {
            if (kind === 'update') {
                // 用首个业务列给出具体示例（有初始值用真实值，否则“列名示例”）
                const col = group.columns[0];
                const ident = col ? col.ident : '字段';
                const zh = col ? col.zh : '字段';
                const raw = group.rows && group.rows[0] && group.rows[0][1] !== undefined && group.rows[0][1] !== null && String(group.rows[0][1]) !== ''
                    ? group.rows[0][1]
                    : `'${zh}示例'`;
                const val = typeof raw === 'number' ? String(raw) : `'${sqlQuote(String(raw))}'`;
                return `只允许 UPDATE ${group.ident} SET ${ident} = ${val} WHERE row_id=1; 依正文明确变化更新对应字段。`;
            }
            return '禁止。';
        }
        if (group.kind === 'array') {
            if (kind === 'update') return '每轮按最新剧情整体替换本表内容。';
            return '禁止（数组表不支持单行增删，整体替换）。';
        }
        const keyIdent = group.columns[0] ? group.columns[0].ident : 'key';
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
        // 示例列排除内部溢出列（_扩展数据）：AI 不应直接修改该列
        const exampleCols = group.columns.filter(c => c.zh !== '_扩展数据');
        const allIdents = exampleCols.map(c => c.ident);
        const firstNonKey = allIdents[1] || '字段';
        if (kind === 'update') {
            return `正文中对应条目的状态、数值或描述明确变化时，更新该记录对应字段。\nSQL示例: UPDATE ${group.ident} SET ${firstNonKey} = ${sampleValue(2, "'新值'")} WHERE ${keyIdent} = ${keyValue};`;
        }
        if (kind === 'insert') {
            // 完整列示例：全部列都列出，列数与 VALUES 一一对应
            const cols = allIdents;
            // 列数与 VALUES 一一对应，避免示例语句列值数量不匹配
            const vals = exampleCols.map((c, i) => {
                if (i === 0) return keyValue;
                const colIdx = group.columns.indexOf(c);
                return sampleValue(colIdx + 1, `'值${i}'`);
            });
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
            if (g.kind === 'json') {
                const entry = {
                    kind: 'json',
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
                    writePaths: [[g.name]],
                };
                entries.push(entry);
                pathIndex.set(g.name, { table: g.tableName, json: true });
                continue;
            }
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
     *  - registerTableUpdateCallback → 广播 Mvu.events.VARIABLE_UPDATE_ENDED（与 MVU 原版一致）
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
     * 用布局（buildLayoutJson 输出的条目数组）+ 插件表格数据重建 stat_data/display_data。
     * 与卡内数据桥 getAllVariables 同逻辑；扩展侧也用它提供 EJS 数据读取，零冗余（惰性读表格）。
     */
    function statDataFromTables(layoutEntries, tables) {
        const data = { stat_data: {} };
        const sd = data.stat_data;
        const entries = Array.isArray(layoutEntries) ? layoutEntries : [];
        const tbl = tables && typeof tables === 'object' ? tables : {};
        const sheetOf = (name) => {
            for (const k in tbl) {
                if (k.indexOf('sheet_') === 0 && tbl[k] && tbl[k].name === name) return tbl[k];
            }
            return null;
        };
        const text = (v, fb) => (v === undefined || v === null || v === '' ? (fb === undefined ? '' : fb) : String(v));
        const number = (v, fb) => { const n = parseFloat(v); return isNaN(n) ? (fb === undefined ? 0 : fb) : n; };
        const parseObject = (v) => { try { if (!v) return {}; if (typeof v === 'object') return v; return JSON.parse(String(v)); } catch (e) { return {}; } };
        const convertCell = (type, v, fb, desc) => {
            if (type === 'number') return number(v, fb);
            if (type === 'object') return parseObject(v);
            if (type === 'pair') return [text(v, fb), desc || ''];
            return text(v, fb);
        };
        const setPath = (obj, path, value) => {
            let cur = obj;
            for (let i = 0; i < path.length - 1; i++) {
                if (!cur[path[i]] || typeof cur[path[i]] !== 'object' || Array.isArray(cur[path[i]])) cur[path[i]] = {};
                cur = cur[path[i]];
            }
            cur[path[path.length - 1]] = value;
        };
        for (const L of entries) {
            const s = sheetOf(L.table);
            if (!s || !Array.isArray(s.content) || !s.content.length) {
                if (L.kind === 'rows') { for (const wp of L.writePaths || []) setPath(sd, wp, {}); }
                else if (L.kind === 'array') { sd[L.group] = []; for (const m of L.mirrors || []) setPath(sd, m.path, ''); }
                else if (L.kind === 'json') { sd[L.group] = {}; }
                continue;
            }
            // content 只有表头时，用插件的 seedRows 还原初始行（首楼被删/重置后常见）
            const sRows = s.content.length > 1 ? s.content : ((Array.isArray(s.seedRows) && s.seedRows.length) ? [s.content[0]].concat(s.seedRows.slice()) : s.content);
            const header = sRows[0] || [];
            const idxs = (L.cols || []).map(c => header.indexOf(c[0]));
            if (L.kind === 'singleton') {
                const row = sRows[1] || [];
                sd[L.group] = {};
                for (let j = 0; j < (L.cols || []).length; j++) {
                    const c = L.cols[j];
                    if (c[0] === '_扩展数据') continue;
                    const vj = idxs[j] >= 0 ? row[idxs[j]] : undefined;
                    const cp = c.length > 3 && c[3] && c[3].length ? c[3] : [L.group, c[0]];
                    setPath(sd, cp, convertCell(c[1], vj, c[2], c[5]));
                }
                const sovIdx = header.indexOf('_扩展数据');
                if (sovIdx >= 0 && row[sovIdx]) {
                    const sov = parseObject(row[sovIdx]);
                    for (const sok in sov) { if (Object.prototype.hasOwnProperty.call(sov, sok)) sd[L.group][sok] = sov[sok]; }
                }
            } else if (L.kind === 'array') {
                const arr = [];
                for (let r = 1; r < sRows.length; r++) {
                    const rw = sRows[r];
                    if (rw && rw[idxs[0]] !== undefined) arr.push(text(rw[idxs[0]]));
                }
                sd[L.group] = arr;
                for (const m of L.mirrors || []) setPath(sd, m.path, m.mode === 'first' ? (arr.length ? arr[0] : '') : arr);
            } else if (L.kind === 'json') {
                const jrow = sRows[1] || [];
                const jidx = header.indexOf('内容');
                const jv = jidx >= 0 ? jrow[jidx] : undefined;
                const jparsed = parseObject(jv);
                sd[L.group] = (jparsed === null || jparsed === undefined) ? {} : jparsed;
                for (const m of L.mirrors || []) setPath(sd, m.path, m.mode === 'first' ? (jparsed && typeof jparsed === 'object' && !Array.isArray(jparsed) ? jparsed : '') : jparsed);
            } else {
                const dict = {};
                const keyIdx = header.indexOf(L.keyCol);
                for (let r2 = 1; r2 < sRows.length; r2++) {
                    const rw2 = sRows[r2];
                    if (!rw2) continue;
                    const kv = keyIdx >= 0 ? rw2[keyIdx] : undefined;
                    if (kv === undefined || kv === null || kv === '') continue;
                    const item = {};
                    for (let j2 = 0; j2 < (L.cols || []).length; j2++) {
                        const c2 = L.cols[j2];
                        if (c2[0] === '_扩展数据') continue;
                        if (c2[0] === L.keyCol) { item[c2[0]] = text(kv); continue; }
                        const vj2 = idxs[j2] >= 0 ? rw2[idxs[j2]] : undefined;
                        item[c2[0]] = convertCell(c2[1], vj2, c2[2], c2[5]);
                    }
                    const ovIdx = header.indexOf('_扩展数据');
                    if (ovIdx >= 0 && rw2[ovIdx]) {
                        const ov = parseObject(rw2[ovIdx]);
                        for (const ok in ov) { if (Object.prototype.hasOwnProperty.call(ov, ok)) item[ok] = ov[ok]; }
                    }
                    dict[text(kv)] = item;
                }
                for (const wp2 of L.writePaths || []) setPath(sd, wp2, dict);
            }
        }
        try { data.display_data = JSON.parse(JSON.stringify(sd)); } catch (e) {}
        return data;
    }

    /**
     * 把 stat_data 的差异写回数据库表格（Mvu.replaceMvuData 等价物）。
     * api: AutoCardUpdaterAPI；layoutEntries: buildLayoutJson 输出；prev/next: stat_data 前后快照。
     * 与卡内数据桥 writeDiffToDb 同逻辑，供扩展在桥不运行时提供写库能力。
     */
    async function writeStatDiffToDb(api, layoutEntries, prevStat, nextStat) {
        const entries = Array.isArray(layoutEntries) ? layoutEntries : [];
        const pathParts = (s) => String(s || '').split('.');
        const tableEntryByPath = (pathStr) => {
            let best = null;
            for (const L of entries) {
                if (L.kind === 'array') {
                    if (pathStr === L.group) return { layout: L, kind: 'array' };
                    continue;
                }
                const prefix = L.kind === 'singleton' ? [L.group] : ((L.writePaths || [])[0] || [L.group]);
                const pre = prefix.join('.');
                if (pathStr === pre || pathStr.indexOf(pre + '.') === 0) {
                    // 最长前缀优先：避免单例组遮蔽其子表路径（如 主角.储物袋.* 应路由到子表）
                    if (!best || prefix.length > best.prefix.length) best = { layout: L, kind: L.kind, prefix };
                }
            }
            return best;
        };
        let tables = {};
        try { tables = api.exportTableAsJson() || {}; } catch (e) {}
        const sheetOf = (name) => {
            for (const k in tables) {
                if (k.indexOf('sheet_') === 0 && tables[k] && tables[k].name === name) return { key: k, sheet: tables[k] };
            }
            return null;
        };
        const findRowByColumn = (sheet, colName, value) => {
            if (!sheet || !Array.isArray(sheet.content)) return -1;
            const ci = sheet.content[0] ? sheet.content[0].indexOf(colName) : -1;
            if (ci === -1) return -1;
            for (let i = 1; i < sheet.content.length; i++) {
                if (sheet.content[i] && String(sheet.content[i][ci]) === String(value)) return i;
            }
            return -1;
        };
        const sameValue = (a, b) => {
            const sa = a === undefined || a === null ? '' : String(a);
            const sb = b === undefined || b === null ? '' : String(b);
            return sa === sb;
        };
        const ops = [];
        const collect = (prevObj, nextObj, pathStr) => {
            const keys = Object.keys(nextObj || {});
            for (const k of keys) {
                const np = pathStr ? pathStr + '.' + k : k;
                const nv = nextObj[k];
                const pv = prevObj ? prevObj[k] : undefined;
                const entry = tableEntryByPath(np);
                if (entry && entry.kind === 'array') {
                    ops.push({ np, entry, value: nv, replace: true });
                    continue;
                }
                if (entry && entry.kind === 'json') {
                    ops.push({ np, entry, value: nv, json: true });
                    continue;
                }
                if (entry && (entry.kind === 'singleton' || entry.kind === 'rows')) {
                    const pre = entry.prefix.join('.');
                    const rel = np === pre ? [] : np.slice(pre.length + 1).split('.');
                    const fIdx = entry.kind === 'rows' ? 1 : 0;
                    if (rel.length > fIdx) {
                        const fld = rel[fIdx];
                        const declared = entry.layout.cols.some(c => c[0] === fld);
                        if (!declared) {
                            ops.push({ np, entry, value: nv, overflow: true, mergeKey: entry.kind === 'rows' ? rel[1] : rel[0], rowKey: entry.kind === 'rows' ? rel[0] : undefined });
                            continue;
                        }
                    }
                }
                if (nv && typeof nv === 'object' && !Array.isArray(nv)) {
                    collect(pv && typeof pv === 'object' && !Array.isArray(pv) ? pv : {}, nv, np);
                } else {
                    ops.push({ np, entry, value: nv, prev: pv });
                }
            }
        };
        collect(prevStat || {}, nextStat || {}, '');

        // 单例/整组JSON表若缺初始行（插件可能只保留表头+seedRows，未物化到 content），先按模板补行，
        // 避免 updateCell: Row index 1 out of bounds 导致写入落空
        const seedNeeded = {};
        for (const op of ops) {
            if (op && op.entry && op.entry.layout && (op.entry.kind === 'singleton' || op.entry.kind === 'json')) {
                // 只对真正有变化的操作补行：值未变化的 op 不会产生写入，也不需要物化初始行
                if (op.overflow || op.json || op.value !== op.prev) {
                    seedNeeded[op.entry.layout.table] = op.entry;
                }
            }
        }
        if (Object.keys(seedNeeded).length) {
            let tplSrc = null;
            try { tplSrc = await Promise.resolve(api.getTableTemplate({ scope: 'chat' })) || null; } catch (e) { tplSrc = null; }
            // 插件拿不到模板时，退回扩展启动时缓存的卡内模板（__ACU_TEMPLATE_DATA__）
            if (!tplSrc) {
                try {
                    const holder = (typeof window !== 'undefined' ? window : globalThis);
                    if (holder && holder.__mvu2shujukuTemplateCache) tplSrc = holder.__mvu2shujukuTemplateCache;
                } catch (e) {}
            }
            for (const tableName in seedNeeded) {
                const SE = seedNeeded[tableName];
                const SE0 = SE.layout || SE;
                const found2 = sheetOf(SE0.table);
                if (!found2 || !Array.isArray(found2.sheet.content) || found2.sheet.content.length > 1) continue;
                let sObj = null;
                if (tplSrc && typeof tplSrc === 'object') {
                    for (const k in tplSrc) {
                        if (k.indexOf('sheet_') === 0 && tplSrc[k] && tplSrc[k].name === SE0.table) {
                            const s = tplSrc[k];
                            const hdr = Array.isArray(s.content) && Array.isArray(s.content[0]) ? s.content[0] : [];
                            const row = Array.isArray(s.content) && s.content[1] ? s.content[1] : [];
                            sObj = {};
                            for (let i = 1; i < hdr.length; i++) sObj[hdr[i]] = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
                            break;
                        }
                    }
                }
                if (!sObj) { sObj = {}; if (SE.kind === 'json') { sObj[SE0.keyCol] = SE0.keyValue; sObj['内容'] = '{}'; } }
                try {
                    await Promise.resolve(api.insertRow(SE0.table, sObj));
                    console.log('[mvu2shujuku][debug] 已为表「' + SE0.table + '」补初始行（原表仅表头）。');
                } catch (e) {
                    console.warn('[mvu2shujuku][debug] 补初始行失败:', e);
                }
            }
            try { tables = api.exportTableAsJson() || {}; } catch (e) {}
        }

        // 解析差异操作并跳过值未变化的写入
        const resolved = [];
        const directOps = [];
        const newRows = new Map();
        const parseObj = (v) => { try { if (!v) return {}; if (typeof v === 'object') return v; return JSON.parse(String(v)); } catch (e) { return {}; } };
        for (const op of ops) {
            const E = op.entry;
            if (!E) continue;
            const L = E.layout;
            const found = sheetOf(L.table);
            if (!found) continue;
            const sheet = found.sheet;
            const header = sheet.content && sheet.content[0] ? sheet.content[0] : [];
            if (op.json && E.kind === 'json') {
                const jcIdx = header.indexOf('内容');
                if (jcIdx === -1) {
                    console.warn('[mvu2shujuku][debug] 整组JSON表「' + L.table + '」缺少「内容」列（旧模板/旧聊天），写入已跳过；请重新转换角色卡并新开聊天。');
                    continue;
                }
                const jNew = op.value === undefined || op.value === null ? '{}' : JSON.stringify(op.value);
                const jCur = sheet.content[1] ? sheet.content[1][jcIdx] : undefined;
                if (sameValue(jCur, jNew)) continue;
                directOps.push({ kind: 'json', key: found.key, sheet, header, layout: L, value: jNew });
                continue;
            }
            if (op.overflow) {
                const ovcIdx = header.indexOf('_扩展数据');
                if (ovcIdx === -1) {
                    console.warn('[mvu2shujuku][debug] 表「' + L.table + '」缺少「_扩展数据」列（旧模板/旧聊天），动态字段写入已跳过；请重新转换角色卡并新开聊天。');
                    continue;
                }
                let ovRow = 1;
                if (E.kind === 'rows') {
                    const ovKey = op.rowKey;
                    if (ovKey === undefined) continue;
                    ovRow = findRowByColumn(sheet, L.keyCol, ovKey);
                    if (ovRow === -1) {
                        // 行可能只存在于 seedRows：跳过，避免 INSERT 撞 UNIQUE
                        const srH2 = header;
                        const srF2 = Array.isArray(sheet.seedRows) && sheet.seedRows.length
                            ? findRowByColumn({ content: [srH2, ...sheet.seedRows] }, L.keyCol, ovKey)
                            : -1;
                        if (srF2 !== -1) {
                            console.log('[mvu2shujuku][debug] 表「' + L.table + '」键「' + ovKey + '」存在于 seedRows，溢出字段跳过（等待插件物化）。');
                            continue;
                        }
                        // 合并进同一新行（与已声明字段同一条 INSERT，避免重复 INSERT 撞 UNIQUE）
                        const nk2 = L.table + '\u0000' + ovKey;
                        let nr2 = newRows.get(nk2);
                        if (!nr2) { nr2 = { table: L.table, header, layout: L, keyCol: L.keyCol, keyVal: ovKey, cells: {} }; newRows.set(nk2, nr2); }
                        const ovCell = JSON.stringify({ [op.mergeKey]: op.value });
                        const prevOv = nr2.cells['_扩展数据'];
                        if (prevOv) {
                            try { const m = JSON.parse(prevOv); m[op.mergeKey] = op.value; nr2.cells['_扩展数据'] = JSON.stringify(m); } catch (e) { nr2.cells['_扩展数据'] = ovCell; }
                        } else {
                            nr2.cells['_扩展数据'] = ovCell;
                        }
                        continue;
                    }
                }
                const ovCur = parseObj(sheet.content[ovRow] ? sheet.content[ovRow][ovcIdx] : undefined);
                const ovMerged = JSON.parse(JSON.stringify(ovCur || {}));
                ovMerged[op.mergeKey] = op.value;
                const ovStr = JSON.stringify(ovMerged);
                if (sameValue(sheet.content[ovRow] ? sheet.content[ovRow][ovcIdx] : undefined, ovStr)) continue;
                directOps.push({ kind: 'overflow', key: found.key, sheet, header, layout: L, rowIndex: ovRow, value: ovStr });
                continue;
            }
            if (op.replace && E.kind === 'array') {
                const arr = Array.isArray(op.value) ? op.value : [];
                const oldVals = sheet.content.slice(1).map(r => (r ? r[1] : undefined));
                const unchanged = oldVals.length === arr.length && oldVals.every((v, i) => sameValue(v, arr[i]));
                if (unchanged) continue;
                resolved.push({ kind: 'array', key: found.key, sheet, header, layout: L, arr });
                continue;
            }
            const parts = pathParts(op.np);
            let rowIndex = -1;
            let newRowArr = null;
            let newRowObj = null;
            if (E.kind === 'singleton') {
                // 显式定位 row_id=1（模板单例行）：垫脚行等其他 row_id 的行不应成为写入目标，
                // 否则数据会落在垫脚行上、随后被去重删掉
                rowIndex = 1;
                for (let ri = 1; ri < sheet.content.length; ri++) {
                    const r = sheet.content[ri];
                    if (r && String(r[0]) === '1') { rowIndex = ri; break; }
                }
            } else if (E.kind === 'rows') {
                const keyVal = parts[E.prefix.length];
                if (keyVal === undefined) continue;
                rowIndex = findRowByColumn(sheet, L.keyCol, keyVal);
                if (rowIndex === -1) {
                    // 行可能只存在于 seedRows（插件未物化到 content）：避免 INSERT 撞 UNIQUE，本次跳过
                    const srHeader = header;
                    const srFound = Array.isArray(sheet.seedRows) && sheet.seedRows.length
                        ? findRowByColumn({ content: [srHeader, ...sheet.seedRows] }, L.keyCol, keyVal)
                        : -1;
                    if (srFound !== -1) {
                        console.log('[mvu2shujuku][debug] 表「' + L.table + '」键「' + keyVal + '」存在于 seedRows，跳过 INSERT（等待插件物化）。');
                        continue;
                    }
                    // 同一新行的多个字段合并为一条 INSERT，避免重复 INSERT 撞 UNIQUE
                    const colZh = parts[parts.length - 1];
                    const nk = L.table + '\u0000' + keyVal;
                    let nr = newRows.get(nk);
                    if (!nr) { nr = { table: L.table, header, layout: L, keyCol: L.keyCol, keyVal, cells: {} }; newRows.set(nk, nr); }
                    nr.cells[colZh] = op.value;
                    continue;
                }
            }
            if (rowIndex < 0 && !newRowArr) continue;
            const colZh = parts[parts.length - 1];
            const colIdx = header.indexOf(colZh);
            if (colIdx === -1) continue;
            if (!newRowArr) {
                const cur = sheet.content[rowIndex] ? sheet.content[rowIndex][colIdx] : undefined;
                if (sameValue(cur, op.value)) continue;
            }
            resolved.push({ kind: 'cell', key: found.key, sheet, header, layout: L, rowIndex, colIdx, colZh, value: op.value, newRowArr, newRowObj });
        }
        // 把合并后的新行转换成单个 resolved 条目（批量 SQL 一条 INSERT / 回退路径一次 insertRow）
        for (const nr of newRows.values()) {
            const arr = new Array(nr.header.length).fill('');
            const obj = {};
            for (const colZh of Object.keys(nr.cells)) {
                const cIdx = nr.header.indexOf(colZh);
                if (cIdx >= 0) { arr[cIdx] = String(nr.cells[colZh]); obj[colZh] = nr.cells[colZh]; }
            }
            const ki = nr.header.indexOf(nr.keyCol);
            if (ki >= 0) { arr[ki] = String(nr.keyVal); obj[nr.keyCol] = String(nr.keyVal); }
            resolved.push({ kind: 'cell', key: nr.table, sheet: null, header: nr.header, layout: nr.layout, rowIndex: -1, colIdx: -1, colZh: '', value: undefined, newRowArr: arr, newRowObj: obj });
        }
        if (resolved.length === 0 && directOps.length === 0) return 0;

        // 多操作批量写入：走插件 executeSqlBatch（增量事务，一次提交），
        // 避免逐格 updateCell 导致的几十次整表持久化卡顿。
        // 不用 importTableAsJson 整体导入：那是整表替换 + 完整检查点，
        // 中途调用会过度重写、刷世界书并膨胀聊天，且存在导出-导回间的竞态窗口。
        // SQL 中文表名/列名由插件自动重绑（与 AI 填表同一条链路）；失败时回退逐条写入。
        if (resolved.length >= 2 && typeof api.executeSqlBatch === 'function') {
            try {
                const sqlLit = (v, numeric) => {
                    if (v === undefined || v === null || v === '') return "''";
                    if (numeric || typeof v === 'number') {
                        const n = Number(v);
                        if (isFinite(n)) return String(n);
                    }
                    return "'" + String(v).replace(/'/g, "''") + "'";
                };
                const colType = (L, zh) => {
                    if (L && Array.isArray(L.cols)) {
                        const c = L.cols.find(x => x && x[0] === zh);
                        if (c) return String(c[1] || '').toLowerCase();
                    }
                    return '';
                };
                const isNum = (t) => /number|int|float|real|numeric|decimal/.test(t);
                const statements = [];
                for (const r of resolved) {
                    const L = r.layout;
                    const tname = L.table;
                    if (r.kind === 'array') {
                        for (let i = 1; i < r.sheet.content.length; i++) {
                            const rid = r.sheet.content[i] ? r.sheet.content[i][0] : undefined;
                            if (rid === undefined || rid === null || rid === '') continue;
                            statements.push('DELETE FROM ' + tname + ' WHERE row_id = ' + Number(rid) + ';');
                        }
                        const vcol = r.header[1] || '内容';
                        for (let ai = 0; ai < r.arr.length; ai++) {
                            statements.push('INSERT INTO ' + tname + ' (' + vcol + ') VALUES (' + sqlLit(r.arr[ai], false) + ');');
                        }
                        continue;
                    }
                    if (r.newRowArr) {
                        const cols = [];
                        const vals = [];
                        for (let nc = 0; nc < L.cols.length; nc++) {
                            const cc = L.cols[nc];
                            const cIdx = r.header.indexOf(cc[0]);
                            const v = cIdx >= 0 ? r.newRowArr[cIdx] : '';
                            if (cc[0] === L.keyCol || (v !== undefined && v !== null && v !== '')) {
                                cols.push(cc[0]);
                                vals.push(sqlLit(v, isNum(colType(L, cc[0]))));
                            }
                        }
                        if (cols.length) statements.push('INSERT INTO ' + tname + ' (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ');');
                        continue;
                    }
                    const rid = r.sheet.content[r.rowIndex] ? r.sheet.content[r.rowIndex][0] : undefined;
                    if (rid === undefined || rid === null || rid === '') continue;
                    statements.push('UPDATE ' + tname + ' SET ' + r.colZh + ' = ' + sqlLit(r.value, isNum(colType(L, r.colZh))) + ' WHERE row_id = ' + Number(rid) + ';');
                }
                if (statements.length) {
                    const out = await Promise.resolve(api.executeSqlBatch(statements.join('\n'), { skipChatSave: false }));
                    if (!out || out.success === false) throw new Error((out && out.error) || 'executeSqlBatch 返回失败');
                    await runDirectOps();
                    return resolved.length + directOps.length;
                }
            } catch (e) {
                console.warn('[mvu2shujuku][debug] SQL 批量写入失败，回退逐条写入：' + (e && e.message ? e.message : e));
            }
        }

        // 逐条写入（回退路径，保持原行为）
        for (const r of resolved) {
            const L = r.layout;
            try {
                if (r.kind === 'array') {
                    for (let rr = r.sheet.content.length - 1; rr >= 1; rr--) {
                        // deleteRow 的 rowIndex 是 content 数组索引（0=表头，1=第一数据行），
                        // rr 正是数组索引，直接传 rr；传 rr-1 会误删表头/前一数据行。
                        try { await Promise.resolve(api.deleteRow(L.table, rr)); } catch (e) {}
                    }
                    for (let ai = 0; ai < r.arr.length; ai++) {
                        const o = {}; o[r.header[1] || '名称'] = String(r.arr[ai]);
                        try { await Promise.resolve(api.insertRow(L.table, o)); } catch (e) {}
                    }
                    continue;
                }
                if (r.newRowObj) {
                    try { await Promise.resolve(api.insertRow(L.table, r.newRowObj)); } catch (e) {}
                    continue;
                }
                try { await Promise.resolve(api.updateCell(L.table, r.rowIndex, r.colZh, r.value)); } catch (e) {}
            } catch (e) {}
        }
        await runDirectOps();
        return resolved.length + directOps.length;

        async function runDirectOps() {
            for (const d of directOps) {
                try {
                    if (d.kind === 'json') await Promise.resolve(api.updateCell(d.layout.table, 1, '内容', d.value));
                    else if (d.kind === 'overflow') await Promise.resolve(api.updateCell(d.layout.table, d.rowIndex, '_扩展数据', d.value));
                    else if (d.kind === 'overflow-insert') await Promise.resolve(api.insertRow(d.layout.table, d.rowObj));
                } catch (e) {
                    console.warn('[mvu2shujuku][debug] 整组JSON/溢出列写入失败:', e);
                }
            }
        }
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
        const statusPlaceholderNeeded = !!opts.statusPlaceholderNeeded;
        const name = opts.bridgeScriptName || 'MVU转数据库-数据桥';
        const ver = opts.version || VERSION;

        const script = [
            `window.__MVU2SHUJUKU_TEMPLATE_BASE64="${b64}";`,
            `try{if(window.top)window.top.__MVU2SHUJUKU_TEMPLATE_BASE64="${b64}";}catch(e){}`,
            `(function ${'mvu2shujukuBridge'}(){`,
            `'use strict';`,
            `var VERSION=${JSON.stringify(ver)};`,
            `var BRIDGE_NAME=${JSON.stringify(name)};`,
            `console.log('['+BRIDGE_NAME+'] 桥启动 v'+VERSION);`,
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
            `// 尽早提供 eventOn/eventOff：前端（body.load 注入）可能在 TH 全局就绪前就调用 eventOn，`,
            `// 若此时没有 eventOn，前端的 VARIABLE_UPDATE_ENDED 监听会注册失败，导致写入后不刷新`,
            `(function installEventOnEarly(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    var w=roots[i];`,
            `    if(!w||typeof w.addEventListener!=='function')continue;`,
            `    if(typeof w.eventOn==='function')continue;`,
            `    w.eventOn=function(evName,handler){`,
            `      var wrapped=function(e){try{var d=e&&e.detail;if(d&&Object.prototype.hasOwnProperty.call(d,'after')){handler(d.after,d.before);}else{handler(d);}}catch(err){}};`,
            `      w.addEventListener(evName,wrapped);`,
            `      return {stop:function(){try{w.removeEventListener(evName,wrapped);}catch(e2){}}};`,
            `    };`,
            `    w.eventOff=function(evName,handler){try{w.removeEventListener(evName,handler);}catch(e2){}};`,
            `  }`,
            `})();`,
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
            `console.log('['+BRIDGE_NAME+'] 插件 API 就绪:', !!API);`,
            `if(!API){setTimeout(mvu2shujukuBridge,2000);return;}`,
            '',
            `var TEMPLATE_B64=window.__MVU2SHUJUKU_TEMPLATE_BASE64||'';`,
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
            `// 合并写入：前端一次操作常连续触发多次 replaceMvuData（如同步资源+追加操作日志），`,
            `// 短窗口内合并为一次持久化，读路径直接返回待写快照保证写后立即读一致`,
            `var pendingStatOverlay=null;`,
            `var statOverlayTimer=null;`,
            `var statOverlayGen=0;`,
            `function mvuWrap(stat){return {stat_data:stat,display_data:stat,delta_data:{},initialized_lorebooks:{}};}`,
            `function flushStatOverlay(){`,
            `  statOverlayTimer=null;`,
            `  var target=pendingStatOverlay;`,
            `  if(target===null)return;`,
            `  var gen=statOverlayGen;`,
            `  (async function(){`,
            `    try{`,
            `      // 对齐参考卡：写库直接 diff 落表，不做锚点重建/表重置（运行时保持最小）`,
            `      try{API=getApi();}catch(e){}`,
            `      var prev=currentStat();`,
            `      await writeDiffToDb(prev,target);`,
            `      broadcastBridgeEvent(mvuWrap(target),mvuWrap(prev));`,
            `    }catch(e){console.warn('['+BRIDGE_NAME+'] 合并写库异常:',e);}`,
            `    finally{if(statOverlayGen===gen)pendingStatOverlay=null;}`,
            `  })();`,
            `}`,
            `function scheduleStatOverlay(next){`,
            `  statOverlayGen++;`,
            `  pendingStatOverlay=next;`,
            `  if(statOverlayTimer)clearTimeout(statOverlayTimer);`,
            `  statOverlayTimer=setTimeout(flushStatOverlay,150);`,
            `}`,
            '',
            `window.getAllVariables=function(){`,
            `  var data={stat_data:{}};`,
            `  var sd=data.stat_data;`,
            `  try{`,
            `    // 现取 API：插件可能晚于脚本加载就绪，避免捕获时 API 为 null 导致读空`,
            `    try{API=getApi();}catch(e){}`,
            `    // 一次导出全表快照，避免每张表都调 exportTableAsJson 造成卡顿`,
            `    var tablesSnap={};`,
            `    try{tablesSnap=API.exportTableAsJson()||{};}catch(e){}`,
            `    function sheetOfSnap(name){for(var k in tablesSnap){if(k.indexOf('sheet_')===0&&tablesSnap[k]&&tablesSnap[k].name===name)return tablesSnap[k];}return null;}`,
            `    for(var ei=0;ei<SD_LAYOUT.length;ei++){`,
            `      var L=SD_LAYOUT[ei];`,
            `      var s=sheetOfSnap(L.table);`,
            `      if(!s||!Array.isArray(s.content)||!s.content.length){`,
            `        if(L.kind==='rows'){`,
            `          for(var wi=0;wi<(L.writePaths||[]).length;wi++)setPath(sd,L.writePaths[wi],{});`,
            `        }else if(L.kind==='array'){`,
            `          sd[L.group]=[];`,
            `          for(var mi=0;mi<(L.mirrors||[]).length;mi++)setPath(sd,L.mirrors[mi].path,'');`,
            `        }else if(L.kind==='json'){`,
            `          sd[L.group]={};`,
            `        }`,
            `        continue;`,
            `      }`,
            `      // content 只有表头时，用插件的 seedRows 还原初始行（首楼被删/重置后常见）`,
            `      var sRows=s.content.length>1?s.content:((Array.isArray(s.seedRows)&&s.seedRows.length)?[s.content[0]].concat(s.seedRows.slice()):s.content);`,
            `      var header=sRows[0]||[];`,
            `      var idxs=L.cols.map(function(c){return header.indexOf(c[0]);});`,
            `      if(L.kind==='singleton'){`,
            `        var row=sRows[1]||[];`,
            `        sd[L.group]={};`,
            `        for(var j=0;j<L.cols.length;j++){`,
            `          var cj=L.cols[j];`,
            `          if(cj[0]==='_扩展数据')continue;`,
            `          var vj=idxs[j]>=0?row[idxs[j]]:undefined;`,
            `          var cp=cj.length>3&&cj[3]&&cj[3].length?cj[3]:[L.group,cj[0]];`,
            `          setPath(sd,cp,convertCell(cj[1],vj,cj[2],cj[5]));`,
            `        }`,
            `        // 溢出列合并：模板未声明的动态字段（如 系统._hypnoos）`,
            `        var sovIdx=header.indexOf('_扩展数据');`,
            `        if(sovIdx>=0&&row[sovIdx]){`,
            `          var sov=parseObject(row[sovIdx]);`,
            `          for(var sok in sov){if(Object.prototype.hasOwnProperty.call(sov,sok))sd[L.group][sok]=sov[sok];}`,
            `        }`,
            `      }else if(L.kind==='array'){`,
            `        var arr=[];`,
            `        for(var r=1;r<sRows.length;r++){`,
            `          var rw=sRows[r];`,
            `          if(rw&&rw[idxs[0]]!==undefined)arr.push(text(rw[idxs[0]]));`,
            `        }`,
            `        sd[L.group]=arr;`,
            `        for(var mi2=0;mi2<(L.mirrors||[]).length;mi2++){`,
            `          var mm=L.mirrors[mi2];`,
            `          setPath(sd,mm.path,mm.mode==='first'?(arr.length?arr[0]:''):arr);`,
            `        }`,
            `      }else if(L.kind==='json'){`,
            `        // 整组 JSON：单行“内容”列原样还原任意形状（对象/字典/标量）`,
            `        var jrow=s.content[1]||[];`,
            `        var jidx=header.indexOf('内容');`,
            `        var jv=jidx>=0?jrow[jidx]:undefined;`,
            `        var jparsed=parseObject(jv);`,
            `        sd[L.group]=jparsed===null||jparsed===undefined?{}:jparsed;`,
            `        // 镜像（若有）`,
            `        for(var mi3=0;mi3<(L.mirrors||[]).length;mi3++){`,
            `          var mm3=L.mirrors[mi3];`,
            `          setPath(sd,mm3.path,mm3.mode==='first'?(jparsed&&typeof jparsed==='object'&&!Array.isArray(jparsed)?jparsed:''):jparsed);`,
            `        }`,
            `      }else{`,
            `        var dict={};`,
            `        var keyIdx=header.indexOf(L.keyCol);`,
            `        for(var r2=1;r2<sRows.length;r2++){`,
            `          var rw2=sRows[r2];`,
            `          if(!rw2)continue;`,
            `          var kv=keyIdx>=0?rw2[keyIdx]:undefined;`,
            `          if(kv===undefined||kv===null||kv==='')continue;`,
            `          var item={};`,
            `          for(var j2=0;j2<L.cols.length;j2++){`,
            `            var cj2=L.cols[j2];`,
            `            if(cj2[0]==='_扩展数据')continue;`,
            `            if(cj2[0]===L.keyCol){item[cj2[0]]=text(kv);continue;}`,
            `            var vj2=idxs[j2]>=0?rw2[idxs[j2]]:undefined;`,
            `            item[cj2[0]]=convertCell(cj2[1],vj2,cj2[2],cj2[5]);`,
            `          }`,
            `          // 溢出列合并：模板未声明的动态字段`,
            `          var ovIdx=header.indexOf('_扩展数据');`,
            `          if(ovIdx>=0&&rw2[ovIdx]){`,
            `            var ov=parseObject(rw2[ovIdx]);`,
            `            for(var ok in ov){if(Object.prototype.hasOwnProperty.call(ov,ok))item[ok]=ov[ok];}`,
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
            `console.log('['+BRIDGE_NAME+'] window.getAllVariables 已定义');`,
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
            `  var best=null;`,
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
            `    var pre=prefix.join('.');`,
            `    if(pathStr===pre||pathStr.indexOf(pre+'.')===0){`,
            `      // 最长前缀优先：避免单例组遮蔽其子表路径（如 主角.储物袋.* 应路由到子表）`,
            `      if(!best||prefix.length>best.prefix.length)best={layout:L,kind:L.kind,prefix:prefix};`,
            `    }`,
            `  }`,
            `  return best;`,
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
            `      if(entry&&entry.kind==='json'){`,
            `        // 整组 JSON：以整组值替换（读取侧本来就整体还原，删除/新增都自然覆盖）`,
            `        ops.push({np:np,entry:entry,value:nv,json:true});`,
            `        continue;`,
            `      }`,
            `      if(entry&&(entry.kind==='singleton'||entry.kind==='rows')){`,
            `        // 模板未声明的动态字段 → 溢出列 JSON 合并`,
            `        var pre=entry.prefix.join('.');`,
            `        var rel=np===pre?[]:np.slice(pre.length+1).split('.');`,
            `        var fIdx=entry.kind==='rows'?1:0;`,
            `        if(rel.length>fIdx){`,
            `          var fld=rel[fIdx];`,
            `          var declared=entry.layout.cols.some(function(c){return c[0]===fld;});`,
            `          if(!declared){`,
            `            ops.push({np:np,entry:entry,value:nv,overflow:true,mergeKey:entry.kind==='rows'?rel[1]:rel[0],rowKey:entry.kind==='rows'?rel[0]:undefined});`,
            `            continue;`,
            `          }`,
            `        }`,
            `      }`,
            `      if(nv&&typeof nv==='object'&&!Array.isArray(nv)){`,
            `        collect(pv&&typeof pv==='object'&&!Array.isArray(pv)?pv:{},nv,np);`,
            `      }else{`,
            `        ops.push({np:np,entry:entry,value:nv,prev:pv});`,
            `      }`,
            `    }`,
            `  }`,
            `  collect(prev,next,'');`,
            `  console.log('['+BRIDGE_NAME+'] writeDiffToDb: 差异操作 '+ops.length+' 条');`,
            `  // 一次导出全表快照（exportTableAsJson 仅返回引用，开销可忽略；写入后插件可能重建数据对象，循环内每操作前刷新）`,
            `  var tablesAll={};`,
            `  try{tablesAll=API.exportTableAsJson()||{};}catch(e){}`,
            `  function sheetOfLocal(name){for(var k in tablesAll){if(k.indexOf('sheet_')===0&&tablesAll[k]&&tablesAll[k].name===name)return tablesAll[k];}return null;}`,
            `  function findRowLocal(sheet,colName,value){if(!sheet||!Array.isArray(sheet.content))return -1;var ci=sheet.content[0]?sheet.content[0].indexOf(colName):-1;if(ci===-1)return -1;for(var i=1;i<sheet.content.length;i++){if(sheet.content[i]&&String(sheet.content[i][ci])===String(value))return i;}return -1;}`,
            `  // 单例/整组JSON表若缺初始行（插件可能只保留表头+seedRows，未物化到 content），先按模板补行，`,
            `  // 避免 updateCell: Row index 1 out of bounds 导致写入落空`,
            `  var needSeed={};`,
            `  for(var si=0;si<ops.length;si++){var se=ops[si];if(se&&se.entry&&se.entry.layout&&(se.entry.kind==='singleton'||se.entry.kind==='json'))needSeed[se.entry.layout.table]=se.entry;}`,
            `  var tplCached=null;`,
            `  function templateSheetRow(tableName){`,
            `    try{if(!tplCached)tplCached=JSON.parse(mvu2shujukuDecodeB64(TEMPLATE_B64));}catch(e){tplCached={};}`,
            `    for(var k in tplCached){if(k.indexOf('sheet_')===0&&tplCached[k]&&tplCached[k].name===tableName){`,
            `      var s=tplCached[k];var hdr=Array.isArray(s.content)&&Array.isArray(s.content[0])?s.content[0]:[];var row=Array.isArray(s.content)&&s.content[1]?s.content[1]:[];var o={};`,
            `      for(var i=1;i<hdr.length;i++){o[hdr[i]]=row[i]!==undefined&&row[i]!==null?row[i]:'';}`,
            `      return o;`,
            `    }}`,
            `    return null;`,
            `  }`,
            `  for(var st in needSeed){`,
            `    var SE=needSeed[st];`,
            `    var SE0=SE.layout||SE;`,
            `    var sSheet0=sheetOfLocal(SE0.table);`,
            `    if(!sSheet0||!Array.isArray(sSheet0.content)||sSheet0.content.length>1)continue;`,
            `    var sObj=templateSheetRow(SE0.table)||null;`,
            `    if(!sObj){sObj={};if(SE.kind==='json'){sObj[SE0.keyCol]=SE0.keyValue;sObj['内容']='{}';}}`,
            `    try{await Promise.resolve(API.insertRow(SE0.table,sObj));console.log('['+BRIDGE_NAME+'] 已为表「'+SE0.table+'」补初始行（原表仅表头）。');}catch(e){console.warn('['+BRIDGE_NAME+'] 补初始行失败:',e);}`,
            `  }`,
            `  for(var oi=0;oi<ops.length;oi++){`,
            `    var op=ops[oi];`,
            `    var E=op.entry;`,
            `    if(!E)continue;`,
            `    var L=E.layout;`,
            `    // 每操作前刷新快照：exportTableAsJson 仅返回引用，开销可忽略；写入后插件可能重建数据对象，需取最新`,
            `    try{tablesAll=API.exportTableAsJson()||{};}catch(e){}`,
            `    var sheet=sheetOfLocal(L.table);`,
            `    if(!sheet)continue;`,
            `    var header=sheet.content&&sheet.content[0]?sheet.content[0]:[];`,
            `    if(op.json&&E.kind==='json'){`,
            `      var jcIdx=header.indexOf('内容');`,
            `      if(jcIdx===-1){console.warn('['+BRIDGE_NAME+'] 整组JSON表「'+L.table+'」缺少「内容」列（旧模板/旧聊天），写入已跳过；请重新转换角色卡并新开聊天。');continue;}`,
            `      var jNew=op.value===undefined||op.value===null?'{}':JSON.stringify(op.value);`,
            `      var jCur=sheet.content[1]?sheet.content[1][jcIdx]:undefined;`,
            `      if(String(jCur)===String(jNew))continue;`,
            `      try{await Promise.resolve(API.updateCell(L.table,1,'内容',jNew));}catch(e){console.warn('['+BRIDGE_NAME+'] 整组JSON写入失败:',e);}`,
            `      continue;`,
            `    }`,
            `    if(op.overflow){`,
            `      var ovcIdx=header.indexOf('_扩展数据');`,
            `      if(ovcIdx===-1){console.warn('['+BRIDGE_NAME+'] 表「'+L.table+'」缺少「_扩展数据」列（旧模板/旧聊天），动态字段写入已跳过；请重新转换角色卡并新开聊天。');continue;}`,
            `      var ovRow=1;`,
            `      if(E.kind==='rows'){`,
            `        var ovKey=op.rowKey;`,
            `        if(ovKey===undefined)continue;`,
            `        ovRow=findRowLocal(sheet,L.keyCol,ovKey);`,
            `        if(ovRow===-1){`,
            `          var ovNewRow={};`,
            `          for(var onc=0;onc<L.cols.length;onc++){`,
            `            var occ=L.cols[onc];`,
            `            if(occ[0]===L.keyCol){ovNewRow[occ[0]]=String(ovKey);continue;}`,
            `            if(occ[0]==='_扩展数据'){var o1={};o1[op.mergeKey]=op.value;ovNewRow[occ[0]]=JSON.stringify(o1);}`,
            `          }`,
            `          try{await Promise.resolve(API.insertRow(L.table,ovNewRow));}catch(e){console.warn('['+BRIDGE_NAME+'] 溢出行插入失败:',e);}`,
            `          continue;`,
            `        }`,
            `      }`,
            `      var ovCur=parseObject(sheet.content[ovRow]?sheet.content[ovRow][ovcIdx]:undefined);`,
            `      var ovMerged=JSON.parse(JSON.stringify(ovCur||{}));`,
            `      ovMerged[op.mergeKey]=op.value;`,
            `      var ovStr=JSON.stringify(ovMerged);`,
            `      if(String(sheet.content[ovRow]?sheet.content[ovRow][ovcIdx]:undefined)===String(ovStr))continue;`,
            `      try{await Promise.resolve(API.updateCell(L.table,ovRow,'_扩展数据',ovStr));}catch(e){console.warn('['+BRIDGE_NAME+'] 溢出列写入失败:',e);}`,
            `      continue;`,
            `    }`,
            `    if(op.replace&&E.kind==='array'){`,
            `      // 数组整体替换：先清空旧行，再逐行插入`,
            `      var arr=Array.isArray(op.value)?op.value:[];`,
            `      var oldVals=[];`,
            `      for(var rv=1;rv<sheet.content.length;rv++)oldVals.push(sheet.content[rv]?sheet.content[rv][1]:undefined);`,
            `      var arrSame=oldVals.length===arr.length&&oldVals.every(function(v,i){return String(v)===String(arr[i]);});`,
            `      if(arrSame)continue;`,
            `      // deleteRow 的 rowIndex 是 content 数组索引（0=表头，1=第一数据行），rr 即数组索引`,
            `      for(var rr=sheet.content.length-1;rr>=1;rr--){try{await Promise.resolve(API.deleteRow(L.table,rr));}catch(e){}}`,
            `      for(var ai=0;ai<arr.length;ai++){`,
            `        var o={};o[header[1]||'名称']=String(arr[ai]);`,
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
            `      rowIndex=findRowLocal(sheet,L.keyCol,keyVal);`,
            `      if(rowIndex===-1){`,
            `        // 新条目：插入`,
            `        var newRow={};`,
            `        for(var nc=0;nc<L.cols.length;nc++){`,
            `          var cc=L.cols[nc];`,
            `          if(cc[0]===L.keyCol){newRow[cc[0]]=String(keyVal);continue;}`,
            `          var cp=parts.slice(E.prefix.length+1);`,
            `          if(cp.length===1&&cp[0]===cc[0])newRow[cc[0]]=String(op.value);`,
            `        }`,
            `        try{await Promise.resolve(API.insertRow(L.table,newRow));}catch(e){console.warn('['+BRIDGE_NAME+'] insertRow 失败:',e);}`,
            `        continue;`,
            `      }`,
            `    }`,
            `    if(rowIndex<0)continue;`,
            `    var colZh=parts[parts.length-1];`,
            `    var colIdx=header.indexOf(colZh);`,
            `    if(colIdx===-1)continue;`,
            `    var curCell=sheet.content[rowIndex]?sheet.content[rowIndex][colIdx]:undefined;`,
            `    if(String(curCell)===String(op.value))continue;`,
            `    try{await Promise.resolve(API.updateCell(L.table,rowIndex,colZh,op.value));}catch(e){console.warn('['+BRIDGE_NAME+'] updateCell 失败:',e);}`,
            `  }`,
            `}`,
            '',
            `// 完整的 Mvu 兼容层：按 MVU 官方全局 API（createMvu）实现数据库读写，`,
            `// 覆盖式接管运行环境里可能残留的真 MVU 对象（避免双轨冲突）。`,
            `var mvuShimTimer=null;`,
            `function emitMvuEvent(name,a,b){`,
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
            `    try{targets[t].dispatchEvent(new EventCtor(name,{detail:{after:a,before:b}}));}catch(e){}`,
            `    try{if(targets[t].eventSource&&typeof targets[t].eventSource.emit==='function')targets[t].eventSource.emit(name,a,b);}catch(e){}`,
            `  }`,
            `  // 与 MVU 原版一致：走 TH 的事件总线（前端 eventOn 监听的就是它）`,
            `  try{if(typeof eventEmit==='function')eventEmit(name,a,b);}catch(e){}`,
            `  // 缺少 ST 事件总线（如消息 iframe）时提供 eventOn/eventOff 兜底，绑定到同名 CustomEvent`,
            `  for(var t2=0;t2<targets.length;t2++){`,
            `    try{`,
            `      var w=targets[t2];`,
            `      if(w&&typeof w.eventOn!=='function'&&typeof w.addEventListener==='function'){`,
            `        w.eventOn=function(evName,handler){`,
            `          var wrapped=function(e){try{var d=e&&e.detail;if(d&&Object.prototype.hasOwnProperty.call(d,'after')){handler(d.after,d.before);}else{handler(d);}}catch(err){}};`,
            `          w.addEventListener(evName,wrapped);`,
            `          return {stop:function(){try{w.removeEventListener(evName,wrapped);}catch(e2){}}};`,
            `        };`,
            `        w.eventOff=function(evName,handler){try{w.removeEventListener(evName,handler);}catch(e2){}};`,
            `      }`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `var mvuFake=null;`,
            `function applyMvuShim(){`,
            `  if(!mvuFake){`,
            `    mvuFake={};`,
            `    mvuFake.events={`,
            `      VARIABLE_INITIALIZED:'mag_variable_initialized',`,
            `      VARIABLE_UPDATE_STARTED:'mag_variable_update_started',`,
            `      COMMAND_PARSED:'mag_command_parsed',`,
            `      VARIABLE_UPDATE_ENDED:'mag_variable_update_ended',`,
            `      BEFORE_MESSAGE_UPDATE:'mag_before_message_update',`,
            `      SINGLE_VARIABLE_UPDATED:'mag_variable_updated'`,
            `    };`,
            `    mvuFake.getMvuData=function(opts){`,
            `      // 有待写快照时直接返回，保证 写→读 一致（持久化由合并定时器落库）`,
            `      if(pendingStatOverlay)return {stat_data:pendingStatOverlay,display_data:{},delta_data:{},initialized_lorebooks:{}};`,
            `      var all=window.getAllVariables?window.getAllVariables():{stat_data:{}};`,
            `      return {stat_data:all.stat_data||{},display_data:all.display_data||{},delta_data:{},initialized_lorebooks:{}};`,
            `    };`,
            `    mvuFake.getMvuVariable=function(mvu_data,path,opts){`,
            `      try{`,
            `        opts=opts||{};`,
            `        var cat=opts.category||'stat';`,
            `        var data=(cat==='display'?(mvu_data&&mvu_data.display_data):(cat==='delta'?(mvu_data&&mvu_data.delta_data):(mvu_data&&mvu_data.stat_data)));`,
            `        var parts=String(path||'').split('.').filter(function(p){return p!=='';});`,
            `        var cur=data;`,
            `        for(var i=0;i<parts.length;i++){if(cur==null)break;cur=cur[parts[i]];}`,
            `        var v=cur===undefined?opts.default_value:cur;`,
            `        if(Array.isArray(v)&&v.length===2)return v[0];`,
            `        return v;`,
            `      }catch(e){return opts&&opts.default_value!==undefined?opts.default_value:undefined;}`,
            `    };`,
            `    mvuFake.getRecordFromMvuData=function(mvu_data,category){`,
            `      if(!mvu_data)return undefined;`,
            `      if(category==='display')return mvu_data.display_data;`,
            `      if(category==='delta')return mvu_data.delta_data;`,
            `      return mvu_data.stat_data;`,
            `    };`,
            `    mvuFake.setMvuVariable=async function(mvu_data,path,new_value,opts){`,
            `      try{`,
            `        opts=opts||{};`,
            `        if(!mvu_data||typeof mvu_data!=='object')return false;`,
            `        // 与 MVU 语义一致：保证 stat_data 存在（不因缺 $internal 崩溃），写入后由调用方 replaceMvuData 持久化`,
            `        if(!mvu_data.stat_data||typeof mvu_data.stat_data!=='object')mvu_data.stat_data={};`,
            `        var parts=String(path||'').split('.').filter(function(p){return p!=='';});`,
            `        if(!parts.length)return false;`,
            `        var oldVal;`,
            `        var has=false;`,
            `        var cur=mvu_data.stat_data;`,
            `        for(var i=0;i<parts.length-1;i++){if(cur[parts[i]]==null||typeof cur[parts[i]]!=='object'||Array.isArray(cur[parts[i]]))cur[parts[i]]={};cur=cur[parts[i]];}`,
            `        if(cur&&typeof cur==='object'&&Object.prototype.hasOwnProperty.call(cur,parts[parts.length-1])){oldVal=cur[parts[parts.length-1]];has=true;}`,
            `        var reason=opts.reason||'';`,
            `        var ds=has?(trimDisplay(oldVal)+'->'+trimDisplay(new_value)+(reason?(' ('+reason+')'):'')):('(新增)'+trimDisplay(new_value)+(reason?(' ('+reason+')'):''));`,
            `        setPath(mvu_data.stat_data,parts,new_value);`,
            `        if(!mvu_data.display_data||typeof mvu_data.display_data!=='object')mvu_data.display_data={};`,
            `        try{setPath(mvu_data.display_data,parts,ds);}catch(e){}`,
            `        if(mvu_data.delta_data&&typeof mvu_data.delta_data==='object'){try{setPath(mvu_data.delta_data,parts,ds);}catch(e){}}`,
            `        console.log('['+BRIDGE_NAME+'] Mvu.setMvuVariable:',path,'=',trimDisplay(new_value)+(reason?(' ('+reason+')'):''));`,
            `        return true;`,
            `      }catch(e){`,
            `        console.warn('['+BRIDGE_NAME+'] Mvu.setMvuVariable 异常:',e);`,
            `        return false;`,
            `      }`,
            `    };`,
            `    mvuFake.replaceMvuData=async function(data,opts){`,
            `      scheduleStatOverlay((data&&data.stat_data)||{});`,
            `      return true;`,
            `    };`,
            `    mvuFake.parseMessage=async function(message,old_data){`,
            `      try{`,
            `        var out=JSON.parse(JSON.stringify(old_data||{}));`,
            `        if(!out.stat_data||typeof out.stat_data!=='object')out.stat_data={};`,
            `        if(!out.display_data||typeof out.display_data!=='object')out.display_data={};`,
            `        var cmds=parseUpdateCommands(String(message||''));`,
            `        if(!cmds.length)return undefined;`,
            `        applyCommandsToStat(out.stat_data,cmds,out.display_data);`,
            `        return out;`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] Mvu.parseMessage 异常:',e);return undefined;}`,
            `    };`,
            `    mvuFake.reloadInitVar=async function(){return true;};`,
            `    mvuFake.getCurrentMvuData=function(){return mvuFake.getMvuData({type:'message',message_id:'latest'});};`,
            `    mvuFake.replaceCurrentMvuData=async function(mvu_data){return mvuFake.replaceMvuData(mvu_data,{type:'message',message_id:'latest'});};`,
            `    mvuFake.isDuringExtraAnalysis=function(){return false;};`,
            `  }`,
            `  var targets=[];`,
            `  function addTarget(t){try{if(t&&targets.indexOf(t)===-1)targets.push(t);}catch(e){}}`,
            `  addTarget(window);addTarget(rootWindow);`,
            `  for(var i=0;i<roots.length;i++){`,
            `    addTarget(roots[i]);`,
            `    try{`,
            `      var frames2=roots[i].document?roots[i].document.querySelectorAll('iframe'):[];`,
            `      for(var f2=0;f2<frames2.length;f2++){try{addTarget(frames2[f2].contentWindow);}catch(e){}}`,
            `    }catch(e){}`,
            `  }`,
            `  for(var i2=0;i2<targets.length;i2++){`,
            `    try{`,
            `      var w=targets[i2];`,
            `      var oldM=w.Mvu;`,
            `      if(oldM&&typeof oldM==='object'&&oldM!==mvuFake){`,
            `        // 保留旧对象上的自定义属性（非 MVU 官方 API），避免破坏其它代码引用`,
            `        for(var pk in oldM){`,
            `          if(!Object.prototype.hasOwnProperty.call(oldM,pk))continue;`,
            `          if(pk==='getMvuData'||pk==='replaceMvuData'||pk==='setMvuVariable'||pk==='getMvuVariable'||pk==='getRecordFromMvuData'||pk==='parseMessage'||pk==='reloadInitVar'||pk==='getCurrentMvuData'||pk==='replaceCurrentMvuData'||pk==='isDuringExtraAnalysis'||pk==='events')continue;`,
            `          if(mvuFake[pk]===undefined)mvuFake[pk]=oldM[pk];`,
            `        }`,
            `      }`,
            `      w.Mvu=mvuFake;`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `function installMvuShim(){`,
            `  if(mvuShimTimer)return;`,
            `  applyMvuShim();`,
            `  // 真 MVU 可能异步 import 后重新挂载 window.Mvu；周期复查接管（2s），并监听其初始化事件立即接管`,
            `  if(typeof setInterval==='function')mvuShimTimer=setInterval(function(){try{applyMvuShim();}catch(e){}},2000);`,
            `  try{if(typeof eventOn==='function'){eventOn('global_Mvu_initialized',function(){try{applyMvuShim();}catch(e){}});}}catch(e){}`,
            `}`,
            (installMvuShim ? `installMvuShim();` : ``),
            '',
            `function broadcastBridgeEvent(after,before){`,
            `  // 与 MVU 原版一致：写库完成后广播 VARIABLE_UPDATE_ENDED，携带更新前后的完整 MvuData（after, before）`,
            `  try{emitMvuEvent('mag_variable_update_ended',after,before);}catch(e){}`,
            `  // shujuku 生态兼容别名：shujuku 原生状态栏/前端监听同名 CustomEvent（如道渊 v5.2.111-sqlite 版），一并派发`,
            `  try{emitMvuEvent('shujuku-table-updated',null);}catch(e){}`,
            `}`,
            `rootWindow.__mvu2shujukuDataBridgeBroadcast=rootWindow.__mvu2shujukuDataBridgeBroadcast||broadcastBridgeEvent;`,
            '',
            `if(typeof API.registerTableUpdateCallback==='function'){`,
            `  var cbKey='__mvu2shujukuTableUpdateCallback_'+VERSION;`,
            `  if(!rootWindow[cbKey]){`,
            `    rootWindow[cbKey]=function(){`,
            `      try{broadcastBridgeEvent(mvuWrap(currentStat()),null);}catch(e){}`,
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
            `var anchorChat='';var anchorTries=0;`,
            `function hasFullCheckpoint(){`,
            `  try{`,
            `    var ctx=getContext();`,
            `    var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];`,
            `    for(var mi=0;mi<chat.length;mi++){`,
            `      var msg=chat[mi];if(!msg||typeof msg!=='object')continue;`,
            `      var keys=Object.keys(msg);`,
            `      for(var ki=0;ki<keys.length;ki++){`,
            `        var k=keys[ki];`,
            `        if(k.indexOf('TavernDB_ACU_')!==0&&k.indexOf('_acu_')!==0)continue;`,
            `        var v=msg[k];`,
            `        if(typeof v==='string'){try{v=JSON.parse(v);}catch(e){continue;}}`,
            `        if(!v||typeof v!=='object')continue;`,
            `        // 与插件 hasAnyV2Checkpoint_ACU 一致：V2 帧（version=2 + logEntries）且 checkpoint.kind === 'full'`,
            `        if(v.storageFrame&&v.storageFrame.version===2&&Array.isArray(v.storageFrame.logEntries)&&v.storageFrame.checkpoint&&v.storageFrame.checkpoint.kind==='full')return true;`,
            `        var ckeys=Object.keys(v);`,
            `        for(var cki=0;cki<ckeys.length;cki++){`,
            `          var child=v[ckeys[cki]];`,
            `          if(typeof child==='string'){try{child=JSON.parse(child);}catch(e){continue;}}`,
            `          if(child&&typeof child==='object'&&child.storageFrame&&child.storageFrame.version===2&&Array.isArray(child.storageFrame.logEntries)&&child.storageFrame.checkpoint&&child.storageFrame.checkpoint.kind==='full')return true;`,
            `        }`,
            `      }`,
            `    }`,
            `  }catch(e){}`,
            `  return false;`,
            `}`,
            `function bridgeIsOpeningPhase(){`,
            `  try{var ctx=getContext();var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];return chat.length<=2;}catch(e){return true;}`,
            `}`,
            `async function ensureTemplateInit(){`,
            `  if(!TEMPLATE_B64)return;`,
            `  var key=currentChatKey();`,
            `  console.log('['+BRIDGE_NAME+'] ensureTemplateInit: key='+key+' | done='+initState.done+' | running='+initState.running+' | retries='+initRetries);`,
            `  if(initState.key!==key)initRetries=0;`,
            `  // 对齐参考卡：只做“缺表才初始化”（initGameSession，每个聊天 done 去重一次）；`,
            `  // 不做锚点重建/表重置，避免切聊天误清数据。`,
            `  if(initState.done&&initState.key===key)return;`,
            `  if(initState.running)return;`,
            `  initState.running=true;`,
            `  initState.key=key;`,
            `  try{`,
            `    // 每次现取 API（插件可能晚于脚本加载就绪；捕获的 API 可能为 null）`,
            `    var apiNow=getApi();`,
            `    if(!apiNow){console.warn('['+BRIDGE_NAME+'] 插件 API 未就绪，稍后重试建表');initState.running=false;if(initRetries<15){initRetries++;setTimeout(ensureTemplateInit,3000);}return;}`,
            `    var out=await mvu2shujukuEnsureInit(apiNow,TEMPLATE_B64,currentCharName()+'模板');`,
            `    console.log('['+BRIDGE_NAME+'] ensureTemplateInit 结果:', out.status, out.message);`,
            `    if(out.status==='error'||out.status==='partial'){`,
            `      console.warn('['+BRIDGE_NAME+'] 开局建表未完全成功:',out.message);`,
            `      initState.done=false;`,
            `      // 开场白切换/重渲染可能打断插件的运行时初始化；轮询重试直到建表成功`,
            `      if(initRetries<15){initRetries++;setTimeout(ensureTemplateInit,4000);}`,
            `    }else{`,
            `      console.log('['+BRIDGE_NAME+'] '+out.message);`,
            `      initRetries=0;`,
            `      initState.done=true;`,
            `      // 建表/初始化成功 ≈ MVU 的 VARIABLE_INITIALIZED 时机，广播给前端`,
            `      try{var curStat2=currentStat();emitMvuEvent('mag_variable_initialized',mvuWrap(curStat2));}catch(e){}`,
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
            `    return mvu2shujukuMissingTableNames(API,mvu2shujukuExpectedTableNames(tpl)).length===0;`,
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
            `  console.log('['+BRIDGE_NAME+'] applyPendingUpdateBlocks: 扫描 '+chat.length+' 条消息');`,
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
            `    console.log('['+BRIDGE_NAME+'] 消息 #'+mi+' 含更新块，解析出 '+cmds.length+' 条命令');`,
            `    if(!cmds.length)continue;`,
            `    Promise.resolve().then(function(){`,
            `      try{`,
            `        var prev=currentStat();`,
            `        var next=JSON.parse(JSON.stringify(prev));`,
            `        var disp={};`,
            `        applyCommandsToStat(next,cmds,disp);`,
            `        return writeDiffToDb(prev,next).then(function(){`,
            `          for(var dk in disp){if(disp.hasOwnProperty(dk))runtimeDisplay[dk]=disp[dk];}`,
            `          broadcastBridgeEvent(mvuWrap(next),mvuWrap(prev));`,
            `        });`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] 应用 MVU 更新块失败:',e);}`,
            `    });`,
            `  }`,
            `}`,
            (appendPlaceholder ? [
                ``,
                `var placeholderRuntime=null;`,
                `// 复刻 MVU 的占位符维护：AI 回复后若卡内正则依赖 <StatusPlaceHolderImpl/>，就在消息末尾补上占位符，`,
                `// 前端注入正则才能命中每条消息（原卡由 MVU 引擎完成，转换后桥接管）`,
                `var statusPlaceholderNeeded=${statusPlaceholderNeeded ? 'true' : 'false'};`,
                `var placeholderMsgKey='';var placeholderAt=0;var placeholderRetryTimer=null;var placeholderRetryCount=0;`,
                `function detectStatusPlaceholder(){`,
                `  try{`,
                `    var ctx0=getContext();`,
                `    var ch0=ctx0&&ctx0.characters?ctx0.characters[ctx0.characterId]:null;`,
                `    var rx=(ch0&&ch0.extensions&&ch0.extensions.regex_scripts)||[];`,
                `    for(var i=0;i<rx.length;i++){`,
                `      var f=String((rx[i]&&rx[i].findRegex)||'');`,
                `      if(f.indexOf('StatusPlaceHolderImpl')!==-1){statusPlaceholderNeeded=true;break;}`,
                `    }`,
                `  }catch(e){}`,
                `}`,
                `function bridgeSetChatMessages(){`,
                `  // 优先使用 TH 脚本作用域注入的裸 setChatMessages（MVU 引擎同款调用方式）`,
                `  try{if(typeof setChatMessages==='function')return setChatMessages;}catch(e){}`,
                `  try{var c=getContext();if(c&&typeof c.setChatMessages==='function')return c.setChatMessages.bind(c);}catch(e){}`,
                `  try{if(typeof window.setChatMessages==='function')return window.setChatMessages;}catch(e){}`,
                `  for(var i=0;i<roots.length;i++){`,
                `    try{if(roots[i].TavernHelper&&typeof roots[i].TavernHelper.setChatMessages==='function')return roots[i].TavernHelper.setChatMessages.bind(roots[i].TavernHelper);}catch(e){}`,
                `    try{if(typeof roots[i].setChatMessages==='function')return roots[i].setChatMessages;}catch(e){}`,
                `  }`,
                `  return null;`,
                `}`,
                `function ensureStatusPlaceholder(){`,
                `  if(!statusPlaceholderNeeded)return;`,
                `  try{`,
                `    var ctx=getContext();`,
                `    if(!ctx||!Array.isArray(ctx.chat)||!ctx.chat.length){console.log('['+BRIDGE_NAME+'][占位符] 跳过：无聊天上下文');return;}`,
                `    if(ctx.generating===true||ctx.isStreaming===true){`,
                `      if(!placeholderRetryTimer&&placeholderRetryCount<10){`,
                `        placeholderRetryTimer=setTimeout(function(){placeholderRetryTimer=null;placeholderRetryCount+=1;ensureStatusPlaceholder();},1000);`,
                `      }`,
                `      return;`,
                `    }`,
                `    placeholderRetryCount=0;`,
                `    var msg=ctx.chat[ctx.chat.length-1];`,
                `    if(!msg){console.log('['+BRIDGE_NAME+'][占位符] 跳过：无最新消息');return;}`,
                `    if(msg.is_user){console.log('['+BRIDGE_NAME+'][占位符] 跳过：最新消息是用户消息');return;}`,
                `    if(String(msg.name||'')==='System'){console.log('['+BRIDGE_NAME+'][占位符] 跳过：最新消息是 System');return;}`,
                `    var text=String(msg.mes!=null?msg.mes:(msg.message||''));`,
                `    if(text.indexOf('<StatusPlaceHolderImpl/>')!==-1)return;`,
                `    var msgKey=(msg.message_id!=null?msg.message_id:(ctx.chat.length-1))+':'+text.length;`,
                `    var now=Date.now();`,
                `    if(msgKey===placeholderMsgKey&&now-placeholderAt<5000)return;`,
                `    var next=text+'\\n\\n<StatusPlaceHolderImpl/>';`,
                `    var setter=bridgeSetChatMessages();`,
                `    if(setter){`,
                `      setter([{message_id:msg.message_id!=null?msg.message_id:(ctx.chat.length-1),message:next,mes:next}],{refresh:'affected'});`,
                `      console.log('['+BRIDGE_NAME+'][占位符] 已追加到消息 id='+(msg.message_id!=null?msg.message_id:(ctx.chat.length-1)));`,
                `    }else{`,
                `      // 找不到 setChatMessages：只改内存，不调 saveChat（避免保存超时风暴）`,
                `      msg.mes=next;if(msg.message!==undefined)msg.message=next;`,
                `      if(!window.__mvu2shujukuPlaceholderFallbackWarned){window.__mvu2shujukuPlaceholderFallbackWarned=true;console.warn('['+BRIDGE_NAME+'][占位符] 未找到 setChatMessages，已直接写入内存消息');}`,
                `    }`,
                `    placeholderMsgKey=msgKey;placeholderAt=now;`,
                `  }catch(e){console.warn('['+BRIDGE_NAME+'][占位符] 追加失败:',e);}`,
                `}`,
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
                `    // 复刻 MVU：消息一到立即补占位符（不延迟），随后再处理建表/更新块`,
                `    try{ensureStatusPlaceholder();}catch(e){}`,
                `    setTimeout(function(){`,
                `      console.log('['+BRIDGE_NAME+'] 消息收尾触发: 建表/更新块/状态栏刷新');`,
                `      try{var _ctx=getContext();var _m=_ctx&&_ctx.chat&&_ctx.chat[_ctx.chat.length-1];console.log('['+BRIDGE_NAME+'][占位符] MESSAGE_RECEIVED 最新消息 role='+(_m&&_m.is_user?'user':(_m&&_m.name||'?'))+' | 含占位符='+(String(_m&&(_m.mes!=null?_m.mes:(_m.message||''))).indexOf('<StatusPlaceHolderImpl/>')!==-1));}catch(e){}`,
                `      Promise.resolve(ensureTemplateInit()).then(function(){try{applyPendingUpdateBlocks();}catch(e){}});`,
                `      try{broadcastBridgeEvent(mvuWrap(currentStat()),null);}catch(e){}`,
                `      try{ensureStatusPlaceholder();}catch(e){}`,
                `    },250);`,
                `  }`,
                `  es.on(evName,onMessage);`,
                `  // 开场白/首楼换 swipe 会丢插件 full checkpoint，需及时重建锚点避免 V2 写库 mismatch`,
                `  for(var ei=0;ei<['MESSAGE_SWIPED','MESSAGE_UPDATED','MESSAGE_EDITED'].length;ei++){`,
                `    try{var evName2=et[['MESSAGE_SWIPED','MESSAGE_UPDATED','MESSAGE_EDITED'][ei]];if(evName2&&typeof evName2==='string')es.on(evName2,onMessage);}catch(e){}`,
                `  }`,
                `  // 新聊天打开即触发建表（参考卡：进入聊天就初始化，不等第一条 AI 回复）；`,
                `  // ensureTemplateInit 按聊天 key 去重，已有表格的聊天不会重初始化`,
                `  try{`,
                `    var evName3=et.CHAT_CHANGED;`,
                `    if(evName3&&typeof evName3==='string'){`,
                `      es.on(evName3,function(){setTimeout(function(){try{ensureTemplateInit();}catch(e){}},300);});`,
                `    }`,
                `  }catch(e){}`,
                `  if(placeholderRuntime){placeholderRuntime.bound=true;placeholderRuntime.handler=onMessage;}`,
                `  else placeholderRuntime={bound:true,handler:onMessage};`,
                `}`,
                `detectStatusPlaceholder();`,
                `console.log('['+BRIDGE_NAME+'][占位符] 维护已启用，needed='+statusPlaceholderNeeded);`,
                `installMessageRuntime();`,
                `setTimeout(function(){try{ensureStatusPlaceholder();}catch(e){}},3000);`,
            ].join('\n') : ``),
            ``,
            `console.log('['+BRIDGE_NAME+'] 数据桥已就绪：getAllVariables/getSheetByName/getCellByHeader/findRowByColumn');`,
            `})();`,
        ].join('\n');
        return script;
    }

    /* ================================================================
     * EJS 数据源重写（rewriteEjsConditions）
     *
     * 世界书条目里的 EJS 结构整体保留，只把 MVU 的数据读取位置改为扩展注册的函数：
     *   getvar('stat_data.组.字段')        → mvu2shujukuGetAllVariables().stat_data.组.字段
     *   getvar("stat_data").组["字段"][0]  → mvu2shujukuGetAllVariables().stat_data.组["字段"][0]
     *   _.has(getvar("stat_data"), '路径') → _.has(mvu2shujukuGetAllVariables().stat_data, '路径')
     * 扩展启动时把 mvu2shujukuGetAllVariables 注册进 st-prompt-template 模板上下文
     * （EjsTemplate.defines），并用卡内布局 + 插件表格惰性重建 stat_data（window.getAllVariables），
     * 不依赖卡内桥是否运行。
     * ================================================================ */
    function rewriteEjsConditions(text, layout, report) {
        const items = [];
        let out = String(text || '');
        const before = out;
        // getvar('stat_data[.路径]') / getvar("stat_data").组.字段 → mvu2shujukuGetAllVariables().stat_data…
        out = out.replace(/getvar\s*\(\s*['"]stat_data(\.[^'"]*)?['"]\s*\)/gi, (m, path) => {
            const suffix = path ? String(path).replace(/^\./, '') : '';
            return 'mvu2shujukuGetAllVariables().stat_data' + (suffix ? '.' + suffix : '');
        });
        if (out !== before) {
            const count = (out.match(/mvu2shujukuGetAllVariables\(\)\.stat_data/g) || []).length;
            items.push({ original: 'getvar(\'stat_data…\')', rewritten: 'mvu2shujukuGetAllVariables().stat_data…', status: 'auto' });
            report.auto(`已把 ${count} 处 MVU 数据读取 getvar('stat_data…') 改为 mvu2shujukuGetAllVariables().stat_data…（EJS 结构保留，函数由扩展注册进模板上下文并惰性读取表格）。`);
        }
        // 非 MVU 的 getwi 等引用：保留并提示
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
        const s = String(content || '');
        if (/Mvu\s*\.|MagVarUpdate|magvar|registerMvuSchema/i.test(s)) return true;
        // MVU 引擎也可能是纯 import 一行（官方包 / 离线镜像，如 MVU-offline / mvu_bundle），
        // 只要 import 的 URL 指向 mvu/magvar 相关产物即视为 MVU 引擎脚本，避免真 MVU 与数据桥双轨运行
        if (/^\s*(?:import\b|import\s*\(|await\s+import)/m.test(s)) {
            return /(?:magvar|mvu[-_ ]?offline|mvu[-_ ]?bundle|MagVarUpdate|\/mvu(?:\/|\.|[-_]))/i.test(s);
        }
        return false;
    }

    // 整页注入模式：replaceString 用 $('body').load(...) 把整个前端页面塞进 body。
    // 加“每页只加载一次”守卫，避免消息重渲染时反复重启前端应用；
    // 应用常驻后靠 VARIABLE_UPDATE_ENDED 事件活体刷新（与 MVU 原版一致）。
    function guardBodyLoadFrontend(text) {
        const t = String(text || '');
        const re = /((?:window\.)?(?:jQuery|\$)\s*\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*)((?:"[^"]*"|'[^']*'))(\s*\))/g;
        return {
            text: t.replace(re, 'if(!window.__mvu2shujukuFrontendLoaded){window.__mvu2shujukuFrontendLoaded=true;$1$2$3;}'),
            count: (t.match(re) || []).length,
        };
    }

    // ================================================================
    // 开场白用户数据 → stat_data 直接落库（通用注入）
    // MVU 原版里，捏人开场白把用户填写的数据注入变量；转换后也应把用户
    // 填写的数据直接写进数据库表格，而不是只放进 /sys 消息等 AI 首轮填表。
    // 转换器在前端提交逻辑（Mvu.replaceMvuData 之前）注入一段通用同步代码：
    //   - 从脚本中已有的 stat_data.<组>.<字段> 引用推断“主数据组”（出现次数最多）；
    //   - 用通用英文键词表把 characterData 的字段映射到 stat_data 路径；
    //   - 只写入 schema 中真实存在的列，绝不凭空加列/污染其他结构。
    // 参考卡（sqlite 版）是作者重写前端实现同样效果；这里用通用规则覆盖所有卡。
    // ================================================================
    const OPENING_FIELD_MAP = {
        name: ['姓名', '名字', '道号', '角色名'],
        gender: ['性别'],
        race: ['种族'],
        appearance: ['容貌', '外貌', '长相', '外观'],
        identity: ['出身', '身份', '来历'],
        realm: ['境界', '修为境界'],
        spiritRoot: ['灵根'],
        technique: ['功法', '功法名'],
        fortune: ['气运'],
        age: ['年龄'],
        personality: ['性格', '性情'],
        clothing: ['衣着', '服装', '服饰'],
        backstory: ['背景', '渊源', '过往'],
        abilities: ['神通', '能力'],
        height: ['身高'],
    };
    function injectOpeningUserDataSync(scriptText, schema, report) {
        const t = String(scriptText || '');
        // 前端必须收集了用户数据（characterData 对象）且走 Mvu 提交，否则无从注入
        const charDefRe = /(?:const|let|var)\s+(characterData)\s*=\s*\{/;
        const m = charDefRe.exec(t);
        if (!m) return { script: t, injected: false, count: 0, group: '' };
        // 定位到 characterData 定义之后的提交调用：确认按钮 handler 里才有完整作用域
        // （脚本前面 initMvuDefaults 等也可能调用 replaceMvuData，但那里没有 characterData）。
        // 必须把注入代码插在整条语句之前（含 await 前缀），否则会生成 `await try {...}` 语法错误。
        const replaceRe = /(?:await\s+)?Mvu\.replaceMvuData\(/g;
        let rm = null;
        let cand;
        while ((cand = replaceRe.exec(t))) {
            if (cand.index > m.index) { rm = cand; break; }
        }
        if (!rm) return { script: t, injected: false, count: 0, group: '' };

        // 主数据组：脚本中 stat_data.<组>.<字段> 出现次数最多的组（如 主角）
        const groupCount = {};
        const groupRe = /stat_data\s*\.\s*([\u4e00-\u9fff]+)\s*\./g;
        let gm;
        while ((gm = groupRe.exec(t))) {
            const g = gm[1];
            groupCount[g] = (groupCount[g] || 0) + 1;
        }
        let group = '';
        let best = 0;
        for (const g in groupCount) {
            if (groupCount[g] > best) { best = groupCount[g]; group = g; }
        }
        if (!group) {
            // 没有 stat_data.组. 引用时，退回 schema 里第一个单例组（通常即主角/主数据组）
            const sg = (Array.isArray(schema) ? schema : []).find(x => x.kind === 'singleton');
            group = sg ? sg.name : '';
        }
        if (!group) return { script: t, injected: false, count: 0, group: '' };

        // 该组的真实列名（中文）
        const gSchema = (Array.isArray(schema) ? schema : []).find(x => x.name === group);
        const colNames = new Set((gSchema && Array.isArray(gSchema.columns) ? gSchema.columns : []).map(c => c.zh));
        // 组内是否有 _扩展数据 兜底列：模板未声明的用户字段写入该列（JSON 存储、读取时还原 stat_data）
        const hasOverflowCol = (gSchema && Array.isArray(gSchema.columns) ? gSchema.columns : [])
            .some(c => c.zh === '_扩展数据');
        // 该组下的子表路径（如 主角.功法 / 主角.气运）：stat_data 里是对象/子表，
        // 用户填的纯文本不能直接覆盖成字符串，否则破坏形状（参考卡是专门拆行进子表的卡特定逻辑）
        const childGroupNames = new Set(
            (Array.isArray(schema) ? schema : [])
                .filter(x => x.parentGroup === group)
                .map(x => x.name)
        );

        // characterData 键 → stat_data 列：词表首命中；优先写真实列，
        // 模板没有该列但有 _扩展数据 兜底列时也写入（读取时还原为 stat_data.<组>.<字段>）
        const pairs = [];
        for (const key in OPENING_FIELD_MAP) {
            const zh = OPENING_FIELD_MAP[key].find(z => colNames.has(z));
            if (zh) {
                pairs.push([key, zh, false]);
            } else if (!childGroupNames.has(OPENING_FIELD_MAP[key][0]) && hasOverflowCol && OPENING_FIELD_MAP[key].length) {
                // 无真实列：用词表首个中文名写入 _扩展数据（写入时自动进兜底列，读取时还原）
                pairs.push([key, OPENING_FIELD_MAP[key][0], true]);
            }
        }
        if (!pairs.length) return { script: t, injected: false, count: 0, group };

        const lines = pairs.map(([k, zh, viaOverflow]) =>
            `      if (characterData[${JSON.stringify(k)}] !== undefined && characterData[${JSON.stringify(k)}] !== null && String(characterData[${JSON.stringify(k)}]).trim() !== '') { try { var __sd = data.stat_data; var __p = ${JSON.stringify([group, zh])}; for (var __i = 0; __i < __p.length - 1; __i++) { if (!__sd[__p[__i]] || typeof __sd[__p[__i]] !== 'object') __sd[__p[__i]] = {}; __sd = __sd[__p[__i]]; } __sd[__p[__p.length - 1]] = characterData[${JSON.stringify(k)}]; } catch (e) {} }`
        ).join('\n');
        const overflowNote = pairs.some(p => p[2])
            ? '；其中无对应列的字段（' + pairs.filter(p => p[2]).map(p => p[0] + '→' + p[1]).join('、') + '）经「_扩展数据」兜底列写入，读取时还原'
            : '';

        const snippet =
            '\n' +
            '      // [mvu2shujuku] 开场白用户数据 → stat_data 直接落库（转换器注入，对应 MVU 原版的开场白注入语义）\n' +
            '      try {\n' +
            '        if (typeof characterData === "object" && characterData && data && data.stat_data) {\n' +
            lines +
            '\n' +
            '        }\n' +
            '      } catch (e) { console.warn("[mvu2shujuku] 开场白用户数据同步失败:", e); }\n' +
            '      ';

        // 插入到第一个 Mvu.replaceMvuData( 调用之前（同一作用域内 data/characterData 均可用）
        const injected = t.slice(0, rm.index) + snippet + t.slice(rm.index);
        if (report) {
            report.auto(`开场白前端已注入「用户填写数据直接落库」：组「${group}」，同步字段 ${pairs.map(p => p[0] + '→' + p[1]).join('、')}${overflowNote}（对应 MVU 原版开场白注入语义，不再等 AI 首轮填表）。`);
        }
        return { script: injected, injected: true, count: pairs.length, group };
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
            console.error('[mvu2shujuku] ' + msg);
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
        // 转换时即确定是否依赖 <StatusPlaceHolderImpl/>（前端注入正则），写死进桥，
        // 避免运行时读取懒加载角色对象导致检测失败
        const statusPlaceholderNeeded = ((data.extensions && data.extensions.regex_scripts) || [])
            .some(r => String(r.findRegex || '').indexOf('StatusPlaceHolderImpl') !== -1);

        const bridgeScript = generateBridgeScript(schema, template, {
            mode,
            template,
            installMvuShim,
            appendPlaceholder: opts.appendPlaceholder !== false,
            statusPlaceholderNeeded,
            bridgeScriptName: opts.bridgeScriptName || `${data.name || '角色'}·数据库数据桥`,
        });

        // 3. 世界书处理
        const newEntries = [];
        // MVU 剧情条目宏：{{get_message_variable::路径}} 改写为数据库表引用
        // （剧情条目保留；变量值由插件注入表格数据提供，宏本身在数据库环境无解析器）
        function rewritePlotMacros(text) {
            return String(text || '').replace(/\{\{?\s*get_message_variable\s*::\s*([^}\s]+)\s*\}\}?/gi, (m, path) => {
                const p = String(path).replace(/^stat_data\./, '').replace(/^stat\./, '').replace(/\[0\]/g, '');
                const parts = p.split('.').filter(Boolean);
                if (!parts.length) return m;
                const table = parts[0] + '表';
                const rest = parts.slice(1).join('/');
                return rest ? `（数据库表「${table}」的「${rest}」）` : `（数据库表「${table}」）`;
            });
        }
        for (const e of entries) {
            const comment = String(e.comment || '');
            const content = String(e.content || '');
            const isInit = /\[initvar\]/i.test(comment);
            // [mvu_plot] 是 MVU 的“剧情 AI 专用”标记：内容是剧情/人设/地点等提示，
            // 不属于变量更新规则，一律保留（内部 MVU 宏单独改写）。
            const isPlot = /\[mvu[ _-]?plot\]|\[mvuplot\]/i.test(comment);
            // MVU 变量管道内容特征（更新规则/变量列表/宏注入），用于区分“该删的管道”与“误标成 [mvu_update] 的剧情文本”
            const mvuPlumbing = /format_message_variable|status_current_variables?|get_message_variable|<UpdateVariable|<JSONPatch|\.set\s*\(\s*['"]|变量更新规则|变量更新格式|变量列表|输出格式|stat_data\s*[:\n{]/i;
            const isMvuUpdate =
                // 显式 [mvu_update] 标记：内容含管道语法或短标记 → 删；内容为剧情文本（如误标条目）→ 保留
                (/\[mvu[ _-]?update\]|\[mvuupdate\]/i.test(comment) && (mvuPlumbing.test(content) || String(content).trim().length < 60)) ||
                // 变量输出类条目（comment 含“变量列表/变量输出格式”）→ 删
                (/变量列表|变量输出格式/i.test(comment) && /stat_data|UpdateVariable|JSONPatch|status_current_variable|get_message_variable|format_message_variable/i.test(content)) ||
                // 蓝灯 D1 类：comment 无标记但内容含 MVU 专属注入宏 → 删（剧情条目除外）
                (!isPlot && /status_current_variables?|format_message_variable|<UpdateVariable|<JSONPatch|\.set\s*\(\s*['"]/i.test(content) && /stat_data|get_message_variable|UpdateVariable|JSONPatch/i.test(content));
            if (isInit || isMvuUpdate) {
                report.note(`已删除 MVU 世界书条目「${comment}」（${isInit ? '初始变量' : '更新规则'}已迁移为数据库模板/规则）。`);
                continue;
            }
            // EJS 重写
            const rw = rewriteEjsConditions(content, layout, report);
            if (rw.items.length) {
                for (const it of rw.items) {
                    if (it.status === 'auto') {
                        report.auto(`条目「${comment}」MVU 数据读取已改写为扩展注册的 mvu2shujukuGetAllVariables()：\`${it.rewritten}\``);
                    }
                }
            }
            const copy = deepClone(e);
            const afterMacros = rewritePlotMacros(rw.text);
            if (afterMacros !== rw.text) {
                report.auto(`条目「${comment}」的 MVU 宏 {{get_message_variable::…}} 已改写为数据库表引用（剧情条目保留）。`);
            }
            copy.content = afterMacros;
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
            // 默认禁用：仅作数据载体供扩展/桥读取（按 keys 识别，不看 enabled），
            // 避免在世界书 UI 里显示为启用状态（绿灯）。
            enabled: false,
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
            // 前端整页注入（$('body').load(...)）：加一次性守卫，避免消息重渲染反复重启前端
            const guarded = guardBodyLoadFrontend(r.replaceString || '');
            if (guarded.count) {
                report.auto(`正则「${name}」为整页注入式前端，已加一次性加载守卫（前端常驻，靠 VARIABLE_UPDATE_ENDED 事件刷新）。`);
                const copy = deepClone(r);
                copy.replaceString = guarded.text;
                if (!copy.replaceString && r.replaceString) copy.replaceString = r.replaceString;
                // 开场白用户数据直接落库：捏人前端提交时把用户填写的数据同步进 stat_data
                const inj = injectOpeningUserDataSync(copy.replaceString, schema, report);
                if (inj.injected) copy.replaceString = inj.script;
                keptRegexes.push(copy);
                continue;
            }
            // 非整页注入的前端同样尝试注入开场白用户数据同步
            if (/characterData\s*=\s*\{/.test(String(r.replaceString || ''))) {
                const inj = injectOpeningUserDataSync(r.replaceString || '', schema, report);
                if (inj.injected) {
                    const copy = deepClone(r);
                    copy.replaceString = inj.script;
                    keptRegexes.push(copy);
                    continue;
                }
            }
            // 状态栏刷新事件保持原样：数据桥每次写入都会广播 mag_variable_update_ended（与 MVU 原版一致），
            // 前端原有 eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...) 监听即可活体刷新，无需改写
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

        // 5.1 开场白/额外问候语里的 HTML 前端（捏人页面）同样注入用户数据同步。
        // 只对含 <script> 且存在 characterData + Mvu.replaceMvuData 的 HTML 生效，纯文本开场白不动。
        if (typeof data.first_mes === 'string' && /<script/i.test(data.first_mes)) {
            const inj = injectOpeningUserDataSync(data.first_mes, schema, report);
            if (inj.injected) data.first_mes = inj.script;
        }
        if (Array.isArray(data.alternate_greetings)) {
            data.alternate_greetings = data.alternate_greetings.map((g, gi) => {
                if (typeof g !== 'string' || !/<script/i.test(g)) return g;
                const inj = injectOpeningUserDataSync(g, schema, report);
                return inj.injected ? inj.script : g;
            });
        }

        // 6. 转换标记
        if (!data.extensions) data.extensions = {};
        const origName = data.name || '角色';
        if (nameSuffix && !String(data.name || '').endsWith(nameSuffix)) {
            data.name = String(data.name || '') + nameSuffix;
            report.note(`角色卡名已追加后缀：${origName} → ${data.name}。`);
        }
        // 世界书独立：内嵌世界书加后缀，避免同名覆盖原卡世界书。
        if (data.character_book && typeof data.character_book.name === 'string' && nameSuffix) {
            const bookName = data.character_book.name;
            if (bookName && !bookName.endsWith(nameSuffix)) {
                data.character_book.name = bookName + nameSuffix;
                report.note(`内嵌世界书名称已追加后缀：${bookName} → ${data.character_book.name}（避免同名覆盖）。`);
            }
        }
        if (data.extensions && typeof data.extensions.world === 'string' && nameSuffix) {
            const worldName = data.extensions.world;
            // 转换后的世界书以内嵌 character_book 为准（含 __ACU_TEMPLATE_DATA__ 模板条目）。
            // 酒馆导入内嵌世界书时会按 character_book.name 生成同名世界文件并绑定到角色，
            // 因此把 extensions.world 指向转换后的世界书名，确保导入后自动挂载。
            if (data.character_book && Array.isArray(data.character_book.entries) && data.character_book.entries.length) {
                data.extensions.world = data.character_book.name || (worldName + nameSuffix);
                report.note(`世界书绑定更新：${worldName} → ${data.extensions.world}（以内嵌世界书为准，导入时自动挂载，含模板条目）。`);
            } else if (worldName && !worldName.endsWith(nameSuffix)) {
                data.extensions.world = worldName + nameSuffix;
                report.note(`外部世界书引用已追加后缀：${worldName} → ${data.extensions.world}。`);
            }
        }
        data.extensions.mvu2shujuku = {
            converter: 'mvu2shujuku',
            version: VERSION,
            mode,
            convertedAt: new Date().toISOString(),
            originalName: origName,
            templateUid: Object.keys(template).filter(k => k.startsWith('sheet_')).map(k => template[k].uid),
            // 布局随卡保存：扩展用它从数据库表格实时重建 stat_data，供 EJS 读取（不依赖卡内桥）
            layout: buildLayoutJson(layout),
            note: '由 MVU 变量角色卡转换而来；表格数据由 SP·数据库 插件维护，状态栏通过数据桥读取。',
        };

        return { card, schema, layout, template, bridgeScript, report };
    }

    /**
     * 把数据库插件里已有模板的选中表并入转换生成的模板。
     * base: 转换器生成的模板对象（mate + sheet_*）
     * source: 数据库插件模板对象（getTableTemplate 返回值）
     * selectedUids: 要并入的 sheet_* 键数组
     * 返回 { template, added, skipped }；重名表跳过（插件校验表名唯一），uid 冲突自动加后缀。
     */
    function mergeTemplates(base, source, selectedUids) {
        const merged = JSON.parse(JSON.stringify(base && typeof base === 'object' ? base : {}));
        if (!merged.mate) merged.mate = { type: 'chatSheets', version: 1 };
        const src = source && typeof source === 'object' ? source : {};
        const names = new Set();
        for (const k of Object.keys(merged).filter(k => k.startsWith('sheet_'))) {
            const s = merged[k];
            if (s && typeof s === 'object' && typeof s.name === 'string') names.add(String(s.name).trim());
        }
        const added = [];
        const skipped = [];
        for (const uid of Array.isArray(selectedUids) ? selectedUids : []) {
            const sheet = src[uid];
            if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) continue;
            const name = String(sheet.name || '').trim();
            if (names.has(name)) { skipped.push(name); continue; }
            let newUid = String(uid);
            let n = 2;
            while (merged[newUid]) newUid = `${uid}_${n++}`;
            const copy = JSON.parse(JSON.stringify(sheet));
            copy.uid = newUid;
            merged[newUid] = copy;
            names.add(name);
            added.push(name);
        }
        // 重排 orderNo，保证插件按顺序显示
        let order = 0;
        for (const k of Object.keys(merged).filter(k => k.startsWith('sheet_'))) {
            if (merged[k] && typeof merged[k] === 'object') merged[k].orderNo = order;
            order++;
        }
        return { template: merged, added, skipped };
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
        // 显式“总是 PNG”时，JSON 输入也用最小 PNG 基底生成 PNG 卡（不再只对 PNG 输入生效）
        const asPng = opts.asPng === true || (opts.asPng !== false && isPngInput);
        if (asPng) {
            const base = isPngInput && input ? input : miniPngBuffer();
            const png = writeCardPng(base, card);
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
            // 以最终模板为准统计（合并模板后 schema 仍来自卡内 initvar，不能用于展示）
            meta: {
                mode,
                isPngInput,
                asPng,
                tableCount: Object.keys(template).filter(k => k.startsWith('sheet_')).length,
                tableNames: Object.keys(template)
                    .filter(k => k.startsWith('sheet_'))
                    .map(k => template[k] && template[k].name)
                    .filter(Boolean),
            },
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
            author: 'mvu2shujuku',
            version: VERSION,
            homePage: 'https://github.com/wmdl2/mvu2shujuku',
            auto_update: false,
            minimum_client_version: '1.12.0',
        };
    }

    function extensionStyle() {
        return [
            '#mvu2shujuku-settings .mvu2shujuku-card {',
            '  border: 1px solid var(--SmartThemeBorderColor, #555);',
            '  border-radius: 8px;',
            '  padding: 12px;',
            '  margin: 8px 0;',
            '  background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.2));',
            '}',
            '#mvu2shujuku-settings .mvu2shujuku-row {',
            '  margin: 8px 0;',
            '  display: flex;',
            '  flex-wrap: wrap;',
            '  gap: 8px;',
            '  align-items: center;',
            '}',
            '#mvu2shujuku-settings .mvu2shujuku-row > * { flex: 0 0 auto; }',
            '#mvu2shujuku-settings .menu_button {',
            '  width: auto;',
            '  white-space: nowrap;',
            '  background: rgba(128,128,128,0.22);',
            '  border: 1px solid rgba(160,160,160,0.65);',
            '  border-radius: 6px;',
            '  padding: 5px 12px;',
            '  cursor: pointer;',
            '  color: var(--SmartThemeBodyColor, inherit);',
            '}',
            '#mvu2shujuku-settings .menu_button:hover {',
            '  background: rgba(128,128,128,0.38);',
            '  border-color: rgba(220,220,220,0.85);',
            '}',
            '#mvu2shujuku-settings .menu_button[style*="display:none"] { display: none !important; }',
            '#mvu2shujuku-settings .mvu2shujuku-label { display: block; margin-bottom: 4px; font-weight: 600; }',
            '#mvu2shujuku-settings .mvu2shujuku-mode-group label { margin-right: 12px; }',
            '#mvu2shujuku-settings .mvu2shujuku-source-group label { margin-right: 12px; cursor: pointer; }',
            '#mvu2shujuku-settings .menu_button:disabled { opacity: 0.4; cursor: not-allowed; }',
            '#mvu2shujuku-settings .mvu2shujuku-help {',
            '  font-size: 12px; opacity: 0.8;',
            '  margin: 4px 0 10px; padding: 6px 8px;',
            '  border-left: 3px solid var(--SmartThemeBorderColor, #666);',
            '  background: rgba(0,0,0,0.15);',
            '}',
            '#mvu2shujuku-settings .mvu2shujuku-help code { font-family: monospace; background: rgba(255,255,255,0.1); padding: 0 3px; border-radius: 3px; }',
            '#mvu2shujuku-settings textarea.mvu2shujuku-report {',
            '  width: 100%; min-height: 220px;',
            '  font-family: monospace; font-size: 12px;',
            '  white-space: pre-wrap; word-break: break-all;',
            '  background: var(--SmartThemeBlurTintColor, #111);',
            '  color: var(--SmartThemeBodyColor, #ddd);',
            '}',
            '#mvu2shujuku-settings .mvu2shujuku-downloads button { margin: 4px 6px 4px 0; }',
            '#mvu2shujuku-settings #mvu2shujuku-actions { flex-wrap: wrap; }',
            '#mvu2shujuku-settings #mvu2shujuku-downloads { flex: 1 1 100%; flex-wrap: wrap; }',
            '#mvu2shujuku-settings .mvu2shujuku-hint { font-size: 12px; opacity: 0.75; }',
        ].join('\n');
    }

    function extensionIndexUi() {
        // 返回 index.js 的 UI 部分（不含核心源码）
        return String.raw`
// ============================================================
// MVU转数据库 · SillyTavern 原生扩展 UI
// 依赖上方内联的核心源码（MVU2SHUJUKU_CORE）
// ============================================================
(function () {
    'use strict';

    const PLUGIN_ID = 'mvu2shujuku';
    const PANEL_ID = PLUGIN_ID + '-settings';
    const SETTINGS_KEY = 'mvu2shujuku';
    const state = { timer: null };

    // 开局建表核心流程（与卡内数据桥同一份逻辑：缺表时调用 SP·数据库 的 initGameSession）
${DB_INIT_SNIPPET}

    const DB_TEMPLATE_KEY = '__ACU_TEMPLATE_DATA__';
    const autoInitState = { running: false, done: '', inited: false, retries: 0, anchorChat: '', anchorTries: 0, apiRetries: 0 };
    let autoInitNoEntryRetries = 0;

    // 独有标记：本转换器产出的卡一定有 extensions.mvu2shujuku.converter === 'mvu2shujuku'。
    // SP·数据库 的 __ACU_TEMPLATE_DATA__ 世界书条目是通用模板条目（其他数据库卡也可能带），
    // 不能作为“本转换器产物”的判据；所有运行时行为都以这个独有标记为门槛，确保不碰别的卡。
    function isConvertedMvuCard(character) {
        try {
            const mk = character && character.extensions && character.extensions.mvu2shujuku;
            return !!(mk && mk.converter === 'mvu2shujuku');
        } catch (e) { return false; }
    }

    // 聊天里是否存在 SP·数据库 的 full checkpoint（V2 锚点）：扫描消息上的 TavernDB_ACU_*/_acu_* 字段。
    // 开场白切换/首楼重写会弄丢锚点，此时继续写库会产生无锚点 artifacts，触发插件的
    // “V2 boundary_after_data_mismatch”拒绝建立 full checkpoint。
    function hasFullShujukuCheckpoint() {
        try {
            const context = getContextSafe();
            const chat = Array.isArray(context.chat) ? context.chat : [];
            for (const msg of chat) {
                if (!msg || typeof msg !== 'object') continue;
                for (const k of Object.keys(msg)) {
                    if (k.indexOf('TavernDB_ACU_') !== 0 && k.indexOf('_acu_') !== 0) continue;
                    let v = msg[k];
                    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { continue; } }
                    if (!v || typeof v !== 'object') continue;
                    // 与插件 hasAnyV2Checkpoint_ACU 一致：必须是 V2 帧（version=2 + logEntries）且 checkpoint.kind === 'full'。
                    // initGameSession 可能留下“模板派生”的非 full checkpoint，不能算已锚定。
                    const hasCheckpoint = (o) => {
                        if (!o || typeof o !== 'object') return false;
                        const frame = o.storageFrame;
                        if (!frame || typeof frame !== 'object') return false;
                        if (frame.version !== 2 || !Array.isArray(frame.logEntries)) return false;
                        return !!(frame.checkpoint && frame.checkpoint.kind === 'full');
                    };
                    if (hasCheckpoint(v)) return true;
                    for (const ck of Object.keys(v)) {
                        let child = v[ck];
                        if (typeof child === 'string') { try { child = JSON.parse(child); } catch (e) { continue; } }
                        if (hasCheckpoint(child)) return true;
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    // 取当前卡的模板：优先用已缓存，否则从当前角色世界书 __ACU_TEMPLATE_DATA__ 条目解析并缓存。
    function cachedTemplateForCurrentCard() {
        try {
            const holder = (typeof window !== 'undefined' ? window : globalThis);
            if (holder && holder.__mvu2shujukuTemplateCache) return holder.__mvu2shujukuTemplateCache;
        } catch (e) {}
        try {
            const ch = currentCharacter();
            if (!isConvertedMvuCard(ch)) return null;
            const cb = ch && (ch.character_book || (ch.data && ch.data.character_book));
            const entries = (cb && Array.isArray(cb.entries)) ? cb.entries : [];
            const entry = entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) !== -1);
            if (entry && entry.content) {
                const parsed = JSON.parse(mvu2shujukuDecodeB64(entry.content));
                try {
                    const holder = (typeof window !== 'undefined' ? window : globalThis);
                    if (holder) holder.__mvu2shujukuTemplateCache = parsed;
                } catch (e2) {}
                return parsed;
            }
        } catch (e) {}
        return null;
    }

    // 是否仍处于开局阶段：聊天只有 1~2 条消息（首楼 + 可能的首轮回复）。
    // 只有开局阶段才允许"重置重建锚点"；一旦进入正常对话，绝不重置已有数据。
    function isOpeningPhase() {
        try {
            const context = getContextSafe();
            const chat = Array.isArray(context.chat) ? context.chat : [];
            return chat.length <= 2;
        } catch (e) { return true; }
    }

    // 聊天缺 full checkpoint 时重建锚点，供开局自动建表与每次写库前调用。
    // 表仍是模板初始状态 → initGameSession 重建（不丢数据）；
    // 表已含用户数据 → 用插件 importTableAsJson 把当前状态提交成 full checkpoint（同样不丢数据）。
    // 返回是否已具备锚点（或已成功重建）。
    async function anchorCheckpointIfMissing(api, tplCached, reason) {
        if (!api || !tplCached) return false;
        if (mvu2shujukuInitSessionHung) {
            console.warn('[mvu2shujuku][debug][锚点] ' + reason + '：initGameSession 曾挂起，跳过重建。');
            return false;
        }
        if (hasFullShujukuCheckpoint()) return true;
        if (mvu2shujukuTablesSafeToAnchor(api, tplCached)) {
            const expected = mvu2shujukuExpectedTableNames(tplCached);
            const missing = mvu2shujukuMissingTableNames(api, expected);
            if (missing.length) {
                console.log('[mvu2shujuku][debug][锚点] ' + reason + '：缺表 ' + missing.join('、') + '，交给建表流程处理。');
                return false;
            }
            console.log('[mvu2shujuku][debug][锚点] ' + reason + '：聊天缺少 full checkpoint，重建数据库锚点…');
            const r = await mvu2shujukuWithTimeout(
                api.initGameSession({}, { injectTemplate: true, loadPreset: false, templateData: tplCached, templatePresetName: String((currentCharacter() && currentCharacter().name) || '') + '模板' }),
                20000,
                'initGameSession(锚点)'
            );
            const ok = !(r && r.success === false) && !(r && r.timeout);
            const anchored = ok && hasFullShujukuCheckpoint();
            console.log('[mvu2shujuku][debug][锚点] ' + reason + '：重建结果=' + (r && r.timeout ? '超时' : (r && r.success === false ? (r.message || '失败') : '完成')) + ' | 锚点=' + anchored);
            return anchored;
        }
        // 表数据与模板不一致（含“模板行被注入/捏人改动”）时，**绝不** initGameSession 重置——
        // 重置会用模板覆盖表格，把开场白注入的数据清掉；只允许表格仍与模板完全一致时重置（无损）。
        // 因此这里不再区分“有额外行/无额外行”，只要不一致就走下方 importTableAsJson 锚定当前状态。
        // 表已含用户数据但无锚点：用插件提交 API 把当前状态落成 full checkpoint（不丢数据）
        if (typeof api.importTableAsJson === 'function') {
            console.log('[mvu2shujuku][debug][锚点] ' + reason + '：表含数据且无锚点，用 importTableAsJson 把当前状态提交为 checkpoint…');
            try {
                const snap = JSON.stringify(api.exportTableAsJson() || {});
                const ok2 = await Promise.resolve(api.importTableAsJson(snap, {}));
                console.log('[mvu2shujuku][debug][锚点] ' + reason + '：importTableAsJson 锚定=' + (ok2 ? '成功' : '失败'));
                return !!ok2;
            } catch (e) {
                console.warn('[mvu2shujuku][debug][锚点] ' + reason + '：importTableAsJson 锚定异常:', e);
                return false;
            }
        }
        console.warn('[mvu2shujuku][debug][锚点] ' + reason + '：表含数据且无锚点，且插件无 importTableAsJson，无法锚定。');
        return false;
    }

    // 写库前保证 full checkpoint 存在。
    // - 表仍是模板初始状态（无真实用户数据）→ initGameSession 重建（重置不丢数据，随后重放本次写入）
    // - 表无额外行（仅模板行被改动，如开局捏人写入）→ 重置+重放本次写入无损，也可重建
    // - 表有额外行（真实积累数据）→ importTableAsJson 锚定当前状态；失败则放弃本次写入，绝不重置已有数据
    async function ensureCheckpointBeforeWrite(api, tplCached) {
        const hasCp = hasFullShujukuCheckpoint();
        console.log('[mvu2shujuku][debug][流程] 写库前锚点状态：hasCheckpoint=' + hasCp);
        if (hasCp) return true;
        await anchorCheckpointIfMissing(api, tplCached, '写库前');
        if (hasFullShujukuCheckpoint()) return true;
        // 插件 initGameSession 可能“完成”却不建 V2 checkpoint：改用 importTableAsJson 提交当前状态强制建锚。
        // 开局阶段（尚无 artifacts）插件会接受并建立 full checkpoint。
        if (typeof api.importTableAsJson === 'function' && !mvu2shujukuInitSessionHung) {
            console.log('[mvu2shujuku][debug][锚点] 写库前：initGameSession 未建立锚点，改用 importTableAsJson 强制锚定…');
            try {
                const snap = JSON.stringify(api.exportTableAsJson() || {});
                await Promise.resolve(api.importTableAsJson(snap, {}));
            } catch (e) {
                console.warn('[mvu2shujuku][debug][锚点] 写库前 importTableAsJson 强制锚定异常:', e);
            }
            if (hasFullShujukuCheckpoint()) return true;
        }
        console.warn('[mvu2shujuku][debug][锚点] 写库前：仍无 full checkpoint，放弃本次写入（避免无锚点 artifacts）。');
        return false;
    }

    // 首楼替换/删除（部分卡的开场流程会重写或删除 greeting 楼层，如道渊）会带走挂在
    // 首楼上的 full checkpoint：刷新后插件在聊天里找不到数据库帧，会从模板重建（数据回默认）。
    // 检测到“表格已有数据但无锚点”且仍处于开局阶段时，用当前运行时数据重建模板并重新
    // initGameSession，把 checkpoint 落到替换后的新首楼上（对齐参考卡“checkpoint 始终
    // 留在原消息对象”的语义，这里由扩展在消息替换后补偿完成）。
    let anchorRetryTimer = null;
    let lastAnchorChat = '';
    let lastAnchorAttempt = 0;
    let lastAnchorStateLog = 0;
    const reAnchorSkipLog = {};
    async function reAnchorCheckpointIfNeeded() {
        const now = Date.now();
        if (now - lastAnchorAttempt < 2500) return;
        lastAnchorAttempt = now;
        try {
            const key = autoInitChatId();
            if (key !== lastAnchorChat) {
                lastAnchorChat = key;
                // 切聊天后先重置节流窗口，给新聊天的事件序列留出时间
                lastAnchorAttempt = now;
            }
            const logSkip = (reason) => {
                const k = key + '|' + reason;
                if (reAnchorSkipLog[k]) return;
                reAnchorSkipLog[k] = true;
                console.log('[mvu2shujuku][debug][重锚] 跳过（' + reason + '，chat=' + key + '）');
            };
            // 廉价门控先跑：非转换卡 / 不在开局阶段时直接返回，避免周期自检的开销
            const ch = currentCharacter();
            // 角色列表懒加载对象可能缺 extensions，activeLayout 只在转换卡完整读取后设置，
            // 两者任一成立即可视为转换卡。
            const isConverted = isConvertedMvuCard(ch) || (Array.isArray(activeLayout) && activeLayout.length > 0);
            if (!isConverted) { logSkip('非转换卡'); return; }
            let chat = [];
            try {
                const ctx = getContextSafe();
                chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            } catch (e) { logSkip('读取聊天上下文失败'); return; }
            if (chat.length > 4) { logSkip('聊天楼层过多（' + chat.length + '）'); return; }
            const api = getAcuApi();
            if (!api) { logSkip('未找到数据库 API'); return; }
            // 状态摘要（开局阶段节流 ~10s 一条）：定位首楼替换/checkpoint 丢失的精确时机，
            // 以及当时运行时表格里有没有数据。
            if (now - lastAnchorStateLog >= 10000) {
                lastAnchorStateLog = now;
                try {
                    const cur = api.exportTableAsJson() || {};
                    let rowCount = 0;
                    for (const k in cur) {
                        if (k.indexOf('sheet_') !== 0) continue;
                        const s = cur[k];
                        if (s && Array.isArray(s.content)) rowCount += Math.max(0, s.content.length - 1);
                    }
                    let msg0info = 'msg0.isolated=无';
                    try {
                        const c0 = chat[0];
                        const iso0 = c0 && c0.TavernDB_ACU_IsolatedData;
                        if (iso0) msg0info = 'msg0.isolatedLen=' + String(JSON.stringify(iso0) || '').length;
                    } catch (e2) {}
                    console.log('[mvu2shujuku][debug][锚点自检] chatLen=' + chat.length + ' | hasCp=' + hasFullShujukuCheckpoint() +
                        ' | ' + msg0info + ' | exportRows=' + rowCount + '（chat=' + key + '）');
                } catch (e3) {}
            }
            if (hasFullShujukuCheckpoint()) { logSkip('聊天仍有 full checkpoint'); return; }
            const tplCached = cachedTemplateForCurrentCard();
            if (!tplCached) { logSkip('无模板缓存'); return; }
            // 表格里必须已有真实数据才值得重锚（空表说明是普通建表流程，交给 autoInit）
            const cur = api.exportTableAsJson() || {};
            let hasRows = false;
            for (const k in cur) {
                if (k.indexOf('sheet_') !== 0) continue;
                const s = cur[k];
                if (s && Array.isArray(s.content) && s.content.length > 1) { hasRows = true; break; }
                if (s && Array.isArray(s.seedRows) && s.seedRows.length) { hasRows = true; break; }
            }
            if (!hasRows) { logSkip('表格无数据行'); return; }
            console.log('[mvu2shujuku][debug][重锚] 开局首楼被替换/删除导致 full checkpoint 丢失（chat=' + key + '），用当前运行时数据重建锚点…');
            // 用当前运行时数据合并回模板：保留 sourceData/规则，行数据为现有值（不丢用户注入）
            const reTpl = mergeSnapshotIntoTemplate(tplCached, cur);
            if (!reTpl) return;
            const initResult = await Promise.resolve(api.initGameSession({}, {
                injectTemplate: true,
                loadPreset: false,
                templateData: reTpl,
                templatePresetName: String((currentCharacter() && currentCharacter().name) || '') + '模板',
            }));
            const ok = !(initResult && initResult.success === false);
            console.log('[mvu2shujuku][debug][重锚] initGameSession 重建结果=' + (ok ? '完成' : ((initResult && initResult.message) || '失败')) +
                ' | runtimeReady=' + (initResult ? initResult.runtimeReady : 'N/A') + ' | 锚点=' + hasFullShujukuCheckpoint());
            // 重锚成功必须落盘：首楼替换后 chat 已被插件/酒馆重新保存过（不带 checkpoint），
            // 仅改内存会在下一次保存或刷新时再次丢失。
            if (ok || hasFullShujukuCheckpoint()) {
                try {
                    const ctx2 = getContextSafe();
                    const saveFn2 = (typeof ctx2.saveChatConditional === 'function' && ctx2.saveChatConditional.bind(ctx2)) ||
                        (typeof ctx2.saveChat === 'function' && ctx2.saveChat.bind(ctx2)) ||
                        (typeof window.saveChatConditional === 'function' ? window.saveChatConditional.bind(window) : null) ||
                        (typeof window.saveChat === 'function' ? window.saveChat.bind(window) : null);
                    if (saveFn2) {
                        for (let attempt = 0; attempt < 2; attempt++) {
                            try {
                                await Promise.resolve(saveFn2());
                                console.log('[mvu2shujuku][debug][重锚] 重建后已等待酒馆保存完成（attempt=' + (attempt + 1) + '）。');
                                break;
                            } catch (saveErr) {
                                console.warn('[mvu2shujuku][debug][重锚] 重建后保存失败（attempt=' + (attempt + 1) + '）：' + (saveErr && saveErr.message ? saveErr.message : saveErr));
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[mvu2shujuku][debug][重锚] 重建后保存异常:', e && e.message ? e.message : e);
                }
            }
        } catch (e) {
            console.warn('[mvu2shujuku][debug][重锚] 异常:', e && e.message ? e.message : e);
        }
    }
    function scheduleReAnchorCheckpoint() {
        if (anchorRetryTimer) hostWindow.clearTimeout(anchorRetryTimer);
        anchorRetryTimer = hostWindow.setTimeout(() => {
            anchorRetryTimer = null;
            reAnchorCheckpointIfNeeded();
        }, 2500);
    }

    function autoInitChatId() {
        try {
            const context = getContextSafe();
            return String(context.chatId || context.chat_id || context.chatFile || context.chatFileName || 'unknown');
        } catch (e) { return 'unknown'; }
    }

    // 对应 MVU 的 init 时机：进入聊天/收到首条消息时，若卡内有模板且表格缺失则自动建表。
    // 只处理本转换器产出的卡（extensions.mvu2shujuku 标记 + 世界书 __ACU_TEMPLATE_DATA__ 模板），
    // 其余卡一律不动（别的数据库卡也可能带 __ACU_TEMPLATE_DATA__，但不会有我们的独有标记）。
    async function autoInitDatabase() {
        const key0 = autoInitChatId();
        if (autoInitState.running) {
            console.log('[mvu2shujuku][debug] 开局自动建表跳过：上一轮仍在运行（chat=' + key0 + '）');
            return;
        }
        const api = getAcuApi();
        if (!api) {
            console.log('[mvu2shujuku][debug] 开局自动建表跳过：未找到 SP·数据库 API（chat=' + key0 + '）');
            // 插件可能晚于聊天加载就绪：API 缺失时轮询重试，确保锚点在用户操作前建立
            if (autoInitState.apiRetries < 12) {
                autoInitState.apiRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 2000);
            }
            return;
        }
        let character = null;
        try { character = currentCharacter(); } catch (e) {}
        if (!character) {
            console.log('[mvu2shujuku][debug] 开局自动建表跳过：当前角色为空（chat=' + key0 + '）');
            return;
        }
        const charHasExt = !!(character && character.extensions && typeof character.extensions === 'object');
        if (!isConvertedMvuCard(character)) {
            // 角色列表懒加载时可能只有元数据、缺 extensions：先尝试取完整卡再判断一次；
            // 仍无独有标记说明不是本转换器产物，直接跳过，不碰任何其他卡。
            // 对象已带 extensions 且无标记 = 完整卡且非转换产物，直接跳过，不再发请求。
            try {
                if (!charHasExt) {
                    const full = await fetchFullCharacter(character, true);
                    if (full && isConvertedMvuCard(full)) {
                        character = full;
                    } else if (full === null) {
                        // 获取完整卡失败（接口返回异常对象/网络问题），不能判定为非转换卡：
                        // 保留运行时状态并重试，避免把本转换器产物误判成普通卡而跳过建表。
                        console.log('[mvu2shujuku][debug] 开局自动建表：获取完整卡失败，稍后重试（chat=' + key0 + '）');
                        if (autoInitNoEntryRetries < 8) {
                            autoInitNoEntryRetries += 1;
                            hostWindow.setTimeout(autoInitDatabase, 3000);
                        }
                        return;
                    }
                }
                if (!isConvertedMvuCard(character)) {
                    console.log('[mvu2shujuku][debug] 开局自动建表跳过：当前卡无本转换器标记 extensions.mvu2shujuku（chat=' + key0 + '），不影响其他卡');
                    // 清掉上一张转换卡残留的运行时状态，确保切到其他卡后不再接管/广播
                    activeLayout = null;
                    activePlaceholderNeeded = false;
                    restoreWindowMvuShim();
                    restoreWindowGetAllVariables();
                    return;
                }
            } catch (e) {
                console.log('[mvu2shujuku][debug] 开局自动建表跳过：读取当前卡标记失败（chat=' + key0 + '）');
                activeLayout = null;
                activePlaceholderNeeded = false;
                restoreWindowMvuShim();
                restoreWindowGetAllVariables();
                return;
            }
        }
        let hadWorldbook = true;
        const cb = character.character_book;
        if (!(cb && Array.isArray(cb.entries) && cb.entries.length)) {
            hadWorldbook = false;
            console.log('[mvu2shujuku][debug] 角色列表对象缺世界书，尝试 /api/characters/get 取完整卡（chat=' + key0 + '）');
            try {
                const full = await fetchFullCharacter(character);
                if (full && full.character_book && Array.isArray(full.character_book.entries) && full.character_book.entries.length) {
                    character = full;
                    hadWorldbook = true;
                } else {
                    console.warn('[mvu2shujuku][debug] /api/characters/get 未能取回世界书（chat=' + key0 + '）');
                }
            } catch (e) {
                console.warn('[mvu2shujuku][debug] /api/characters/get 异常：' + (e && e.message ? e.message : e) + '（chat=' + key0 + '）');
            }
            // 完整卡获取失败（含接口返回异常对象）且当前对象无世界书时，稍后重试，
            // 避免“新聊天没有初始化数据/表格为空”的误判。
            if (!(character && character.character_book && Array.isArray(character.character_book.entries) && character.character_book.entries.length) &&
                autoInitNoEntryRetries < 8) {
                console.log('[mvu2shujuku][debug] 开局自动建表：完整卡获取失败，稍后重试（chat=' + key0 + '）');
                autoInitNoEntryRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 3000);
                return;
            }
        }
        const fullCb = character && character.character_book;
        const entries = fullCb && Array.isArray(fullCb.entries) ? fullCb.entries : [];
        const entry = entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) !== -1);
        if (!entry || !entry.content) {
            console.warn('[mvu2shujuku][debug] 未找到 __ACU_TEMPLATE_DATA__ 世界书条目（entries=' + entries.length + '；chat=' + key0 + '）');
            if (!hadWorldbook && autoInitNoEntryRetries < 8) {
                // 懒加载角色列表可能晚于首次触发；轮询重试（4s），最多约 40s
                autoInitNoEntryRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 4000);
            }
            return;
        }
        autoInitNoEntryRetries = 0;
        // 调试：确认当前卡的 tavern_helper 里到底有没有数据桥
        try {
            const th = character && character.extensions && character.extensions.tavern_helper;
            const scripts = (th && Array.isArray(th.scripts) ? th.scripts : []).map(s => s.name + '(enabled=' + s.enabled + ')');
            console.log('[mvu2shujuku][debug] 当前卡 tavern_helper.scripts =', JSON.stringify(scripts), '| 桥内容长度=' + (th && Array.isArray(th.scripts) && th.scripts.find(s => /数据桥/.test(String(s.name || ''))) ? String((th.scripts.find(s => /数据桥/.test(String(s.name || ''))).content || '')).length : 0));
        } catch (e) {
            console.warn('[mvu2shujuku][debug] 读取 tavern_helper 失败:', e);
        }
        // 缓存当前卡布局，供 EJS 数据读取（window.getAllVariables）
        try {
            const mk = character && character.extensions && character.extensions.mvu2shujuku;
            if (mk && typeof mk.layout === 'string') {
                activeLayout = JSON.parse(mk.layout);
                console.log('[mvu2shujuku][debug] 已缓存当前卡布局，条目数=' + (Array.isArray(activeLayout) ? activeLayout.length : 0));
            }
        } catch (e) {
            console.warn('[mvu2shujuku][debug] 解析卡布局失败:', e);
        }
        activePlaceholderNeeded = detectPlaceholderFor(character);
        console.log('[mvu2shujuku][debug][占位符] 当前卡依赖状态栏占位符=' + activePlaceholderNeeded);
        installWindowGetAllVariables();
        const key = autoInitChatId();
        if (key !== key0) console.log('[mvu2shujuku][debug] 开局自动建表 chat 已切换：' + key0 + ' → ' + key);
        if (autoInitState.apiRetries > 0 && autoInitState.anchorChat !== key) autoInitState.apiRetries = 0;
        // 缓存卡内模板（供写路径补行与锚点重建使用）
        try {
            const holder = (typeof window !== 'undefined' ? window : globalThis);
            if (holder) holder.__mvu2shujukuTemplateCache = JSON.parse(mvu2shujukuDecodeB64(entry.content));
        } catch (e) {}
        // 对齐参考卡：每个聊天只在“缺表”时初始化一次（下方 ensureInit），
        // 已有表格的聊天绝不重初始化，避免切聊天时误重置别的聊天。
        // 聊天内锚点丢失/写库前缺锚点由写库前检查兜底（ensureCheckpointBeforeWrite）。
        if (autoInitState.done === key) return;
        autoInitState.running = true;
        // 看门狗：即使插件 API 的 Promise 意外不返回，也强制复位 running，避免后续自动建表被永久跳过
        const initWatchdog = hostWindow.setTimeout(() => {
            if (autoInitState.running) {
                autoInitState.running = false;
                console.warn('[mvu2shujuku] 开局自动建表看门狗触发：超过 30s 未完成，已复位（下次触发会重试）。');
            }
        }, 30000);
        try {
            const presetName = String((character && character.name) || '') + '模板';
            const out = await mvu2shujukuEnsureInit(api, entry.content, presetName);
            if (out.status === 'error' || out.status === 'partial') {
                console.warn('[mvu2shujuku] 开局自动建表未完全成功：' + out.message);
                autoInitState.done = '';
                // 开场白切换/重渲染可能打断插件初始化；轮询重试直到建表成功（最多约 1 分钟）。
                // 但“表结构不匹配（旧模板）”重导失败时不风暴重试，避免反复执行重型 initGameSession 卡住界面；
                // 下次进入聊天/收到消息时会再尝试一次。
                autoInitState.retries += 1;
                const structureMismatch = String(out.message).indexOf('结构不匹配') !== -1;
                if (!structureMismatch && autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
            } else {
                console.log('[mvu2shujuku] 开局自动建表：' + out.message);
                autoInitState.retries = 0;
                autoInitState.done = key;
                installWindowGetAllVariables();
                installWindowMvuShim();
                installTableUpdateHook();
                // 建表/初始化成功 ≈ MVU 的 VARIABLE_INITIALIZED 时机，广播给前端
                try {
                    const curStat = window.getAllVariables ? (window.getAllVariables().stat_data || {}) : {};
                    emitMvuEvent('mag_variable_initialized', { stat_data: curStat, display_data: curStat, delta_data: {}, initialized_lorebooks: {} });
                } catch (e) {}
            }
        } catch (e) {
            console.warn('[mvu2shujuku] 开局自动建表异常：' + (e && e.message ? e.message : e));
            autoInitState.done = '';
            autoInitState.retries += 1;
            if (autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
        } finally {
            hostWindow.clearTimeout(initWatchdog);
            autoInitState.running = false;
        }
    }

    // 判断角色卡正则是否依赖 <StatusPlaceHolderImpl/>（前端注入占位符）
    function detectPlaceholderFor(character) {
        try {
            // 只有本转换器产物的卡才维护状态栏占位符，其他卡即使正则里碰巧含同名串也不处理
            if (!isConvertedMvuCard(character)) return false;
            const rx = character && character.extensions && character.extensions.regex_scripts;
            if (!Array.isArray(rx)) return false;
            return rx.some(r => String(r.findRegex || '').indexOf('StatusPlaceHolderImpl') !== -1);
        } catch (e) { return false; }
    }

    // 扩展本体复刻 MVU 的占位符维护：AI 回复后若缺少占位符则追加，前端注入正则才能命中每条消息
    let lastPlaceholderMsgKey = '';
    let lastPlaceholderAt = 0;
    let placeholderRetryTimer = null;
    let placeholderRetryCount = 0;
    function findSetChatMessages() {
        try { const context = getContextSafe(); if (context && typeof context.setChatMessages === 'function') return context.setChatMessages.bind(context); } catch (e) {}
        try { if (typeof window.setChatMessages === 'function') return window.setChatMessages; } catch (e) {}
        for (const r of [window, hostWindow]) {
            try { if (r.TavernHelper && typeof r.TavernHelper.setChatMessages === 'function') return r.TavernHelper.setChatMessages.bind(r.TavernHelper); } catch (e) {}
            try { if (typeof r.setChatMessages === 'function') return r.setChatMessages; } catch (e) {}
        }
        return null;
    }
    function ensureWindowStatusPlaceholder() {
        if (!activePlaceholderNeeded) return;
        try {
            const context = getContextSafe();
            if (!context || !Array.isArray(context.chat) || !context.chat.length) {
                return;
            }
            // 生成/流式过程中不追加，避免每次流更新都把占位符覆盖后再补（反复注入）；
            // 若事件触发时 generating 仍为 true 导致错过，1 秒后补一次（最多 10 次），保证收尾必补（MVU 同款语义）
            if (context.generating === true || context.isStreaming === true) {
                if (!placeholderRetryTimer && placeholderRetryCount < 10) {
                    placeholderRetryTimer = hostWindow.setTimeout(() => {
                        placeholderRetryTimer = null;
                        placeholderRetryCount += 1;
                        ensureWindowStatusPlaceholder();
                    }, 1000);
                }
                return;
            }
            placeholderRetryCount = 0;
            const msg = context.chat[context.chat.length - 1];
            if (!msg) return;
            if (msg.is_user || String(msg.name || '') === 'System') return;
            const text = String(msg.mes != null ? msg.mes : (msg.message || ''));
            if (text.indexOf('<StatusPlaceHolderImpl/>') !== -1) return;
            const msgKey = (msg.message_id != null ? msg.message_id : (context.chat.length - 1)) + ':' + text.length;
            const now = Date.now();
            if (msgKey === lastPlaceholderMsgKey && now - lastPlaceholderAt < 5000) return;
            const next = text + '\n\n<StatusPlaceHolderImpl/>';
            const setter = findSetChatMessages();
            if (setter) {
                setter([{ message_id: msg.message_id != null ? msg.message_id : (context.chat.length - 1), message: next, mes: next }], { refresh: 'affected' });
                console.log('[mvu2shujuku][debug][占位符] 已追加到消息 id=' + (msg.message_id != null ? msg.message_id : (context.chat.length - 1)));
            } else {
                // 找不到 setChatMessages：只改内存，不调 saveChat（避免每次保存超时形成风暴）；
                // 落盘依赖酒馆自身保存，显示刷新依赖酒馆重渲染
                msg.mes = next; if (msg.message !== undefined) msg.message = next;
                if (!window.__mvu2shujukuPlaceholderFallbackWarned) {
                    window.__mvu2shujukuPlaceholderFallbackWarned = true;
                    console.warn('[mvu2shujuku][debug][占位符] 未找到 setChatMessages，已直接写入内存消息（依赖酒馆下次保存落盘；若前端未刷新请升级酒馆）');
                }
            }
            lastPlaceholderMsgKey = msgKey;
            lastPlaceholderAt = now;
        } catch (e) {
            console.warn('[mvu2shujuku][debug][占位符] 追加失败:', e);
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
                    // 首楼替换/删除可能带走挂在首楼上的 checkpoint：稍后检测并重锚
                    scheduleReAnchorCheckpoint();
                    // 切卡后按新卡同步运行时：转换卡接管，其他卡撤销，确保不影响别的卡
                    syncRuntimeForCurrentCard();
                    activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
                    hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                });
                es.on(et.MESSAGE_RECEIVED, () => {
                    hostWindow.setTimeout(autoInitDatabase, 600);
                    // 复刻 MVU：AI 回复后追加状态栏占位符，前端注入正则才能命中每条消息
                    ensureWindowStatusPlaceholder();
                    scheduleReAnchorCheckpoint();
                });
                // 开场白切换/首楼换 swipe 会丢掉插件的 full checkpoint：必须立即重建锚点，
                // 否则捏人 UI 的写库会产生无锚点 artifacts，触发插件 V2 boundary_after_data_mismatch。
                // CHAT_CHANGED 只在换聊天时触发，swipe 切换不会触发，所以要单独监听。
                for (const evName of [et.MESSAGE_SWIPED, et.MESSAGE_UPDATED, et.MESSAGE_EDITED]) {
                    if (evName && typeof evName === 'string') {
                        es.on(evName, () => {
                            hostWindow.setTimeout(autoInitDatabase, 300);
                            scheduleReAnchorCheckpoint();
                        });
                    }
                }
                // 首楼删除/新增（道渊等卡的开场流程会替换 greeting 楼层）也会带走 checkpoint；
                // 这些事件不一定会触发 MESSAGE_UPDATED，单独挂钩作为补充。
                for (const evName of [et.MESSAGE_SENT, et.MESSAGE_DELETED]) {
                    if (evName && typeof evName === 'string') {
                        es.on(evName, () => scheduleReAnchorCheckpoint());
                    }
                }
                if (et.GENERATION_ENDED) {
                    es.on(et.GENERATION_ENDED, () => {
                        ensureWindowStatusPlaceholder();
                        hostWindow.setTimeout(autoInitDatabase, 100);
                        scheduleReAnchorCheckpoint();
                    });
                }
                // 周期自检兜底：部分卡的开场流程在事件序列之外替换首楼（如道渊替换为 System），
                // 单靠事件可能错过窗口。开局阶段每 3 秒评估一次，重锚函数内部有廉价门控，
                // 非转换卡/非开局阶段/有锚点时几乎零开销直接返回。
                if (!window.__mvu2shujukuAnchorIntervalStarted) {
                    window.__mvu2shujukuAnchorIntervalStarted = true;
                    hostWindow.setInterval(() => {
                        try { reAnchorCheckpointIfNeeded(); } catch (e) {}
                    }, 3000);
                }
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
        console.log('[mvu2shujuku][' + (type || 'info') + ']', message);
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
        const sel = panel.querySelector('#mvu2shujuku-char-select');
        if (!sel) return;
        const chars = Array.isArray(context.characters) ? context.characters : [];
        const currentIdx = context.characterId != null ? context.characterId : -1;
        const prevValue = sel.value;
        panel.__mvu2shujukuChars = chars;
        panel.__mvu2shujukuCurrentIdx = currentIdx;
        const searchBox = panel.querySelector('#mvu2shujuku-char-search');
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
        const sel = panel && panel.querySelector('#mvu2shujuku-char-select');
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
        // 非强制时：角色对象已有世界书即视为完整，避免无谓请求
        if (!arguments[1] && cb && Array.isArray(cb.entries) && cb.entries.length) return character;
        console.log('[mvu2shujuku] ' + (arguments[1] ? '按完整卡校验转换标记' : '角色列表对象缺世界书') + '，尝试 /api/characters/get 取完整卡。avatar=', character.avatar, 'name=', character && character.name);
        try {
            const context = getContextSafe();
            const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar_url: character.avatar }),
            });
            console.log('[mvu2shujuku] /api/characters/get 状态:', res.status);
            if (res.ok) {
                const full = await res.json();
                const target = (full && full.data && full.data.character_book) ? full.data : full;
                console.log('[mvu2shujuku] 完整卡对象 keys:', Object.keys(full || {}).join(','), '| character_book.entries=', target && target.character_book ? target.character_book.entries.length : 'N/A');
                if (target && target.character_book && Array.isArray(target.character_book.entries) && target.character_book.entries.length) return target;
                // 接口返回了异常对象（如 {mode,baseHash,nextHash,ops} 哈希差异、空对象等），
                // 不能当作“完整卡”，否则会把本转换器产物误判为非转换卡而跳过建表。
                // 返回 null 让调用方区分“获取失败（可重试）”与“确实非转换卡”。
                console.warn('[mvu2shujuku] /api/characters/get 响应缺少角色卡结构（keys=' + Object.keys(full || {}).join(',') + '），本次视为获取失败，稍后可重试。');
                return null;
            }
        } catch (e) {}
        // 请求失败也返回 null：调用方需要明确“没拿到完整卡”，不能把它当非转换卡处理
        return null;
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
    let lastInput = null;
    const mergeState = { sourceTemplate: null };
    let activeLayout = null;
    // 当前卡是否依赖 <StatusPlaceHolderImpl/>（前端注入正则）；由扩展本体维护占位符，
    // 不依赖 tavern_helper 桥是否运行
    let activePlaceholderNeeded = false;
    // Mvu.replaceMvuData 合并写入：MVU 卡开局初始化常连续多次调用（每次只改一个字段），
    // 每次都触发插件整表持久化；合并为一次后只持久化一次。
    let pendingStatWrite = null;
    let statWriteTimer = null;
    let statWriteFlushResolve = null;
    let statWriteFlushPromise = null;
    let statWriteOverlayGen = 0;
    const materializedChats = new Set();
    // 每聊天首次写库已通过 initGameSession 完成“合并注入数据建表”的标记：
    // 之后该聊天的写库走快照/增量提交，不再重复 initGameSession（避免反复重置表格）。
    const initializedViaGameSession = new Set();

    // 每个聊天首次写库前，一次性为所有单例/JSON 表物化模板初始行。
    // 背景：插件 export 可能把 seedRows 合并显示成“有行”，但运行期未物化，导致 updateCell row 1 out of bounds。
    // 这里只在每个聊天执行一次（行已存在时 UNIQUE 冲突静默），避免每次写入都重复尝试的激进行为。
    async function ensureSingletonRowsMaterialized(api, tplCached, layoutEntries) {
        try {
            let chatKey = '';
            try { chatKey = String(getContextSafe().chatId || ''); } catch (e) {}
            if (materializedChats.has(chatKey)) return;
            materializedChats.add(chatKey);
            for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                if (L.kind !== 'singleton' && L.kind !== 'json') continue;
                try {
                    // 注意：不能用 exportTableAsJson 的 content 判断“已有 row_id=1”来跳过物化——
                    // 插件的 export 是含 seedRows 的合并视图（显示有行≠SQLite 运行时已物化），
                    // 误判会跳过 insertRow，导致后续 updateCell row 1 out of bounds（单例表全空）。
                    // 这里无条件尝试物化：content 空时插件 insertRow 分配 row_id=1（正好是身份行）；
                    // content 已有 row_id=1 时会分配 row_id=2（垫脚行），由 cleanupSingletonDuplicates
                    // 用 content 数组索引（deleteRow 的 rowIndex 语义）删掉，row_id=1 保留。
                    const obj = {};
                    if (tplCached) {
                        for (const k in tplCached) {
                            if (k.indexOf('sheet_') === 0 && tplCached[k] && tplCached[k].name === L.table &&
                                Array.isArray(tplCached[k].content) && tplCached[k].content[1]) {
                                const hdr = tplCached[k].content[0] || [];
                                const row = tplCached[k].content[1];
                                for (let i = 1; i < hdr.length; i++) {
                                    obj[hdr[i]] = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
                                }
                                break;
                            }
                        }
                    }
                    if (L.kind === 'json') {
                        if (!obj[L.keyCol || '名称']) obj[L.keyCol || '名称'] = L.keyValue || 'row1';
                        if (obj['内容'] === undefined) obj['内容'] = '{}';
                    }
                    const inserted = await Promise.resolve(api.insertRow(L.table, obj));
                    // 插件 insertRow 失败时返回 -1 / false / null，不抛异常；必须检查返回值，
                    // 否则会误报「已物化」而表里其实没有初始行（单例表初始化丢失的根因之一）。
                    if (inserted === -1 || inserted === false || inserted === null || inserted === undefined) {
                        console.warn('[mvu2shujuku][debug] 物化单例/JSON表初始行失败（insertRow 返回 ' + String(inserted) + '）：' + L.table);
                    } else {
                        console.log('[mvu2shujuku][debug] 已物化单例/JSON表初始行：' + L.table + '（新行索引=' + inserted + '）');
                    }
                } catch (e) {
                    // 行已存在（UNIQUE 冲突等）→ 已物化，无需处理
                    console.log('[mvu2shujuku][debug] 单例/JSON表初始行已存在，跳过物化：' + L.table + '（' + (e && e.message ? e.message : e) + '）');
                }
            }
            // 诊断：物化后输出单例/JSON 表的行数，便于确认初始行是否真的落表
            try {
                const allT = api.exportTableAsJson() || {};
                for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                    if (L.kind !== 'singleton' && L.kind !== 'json') continue;
                    for (const k in allT) {
                        if (k.indexOf('sheet_') === 0 && allT[k] && allT[k].name === L.table) {
                            const c = Array.isArray(allT[k].content) ? allT[k].content.length - 1 : 0;
                            const s = Array.isArray(allT[k].seedRows) ? allT[k].seedRows.length : 0;
                            console.log('[mvu2shujuku][debug] 物化后单例表「' + L.table + '」content 行数=' + c + '，seedRows=' + s);
                            break;
                        }
                    }
                }
            } catch (e) {}
        } catch (e) {}
    }

    // 单例/JSON 表只允许一行（row_id=1）。我们补行用的是新 row_id（插件 insertRow 自动分配），
    // 若插件随后把自己的 seedRow（row_id=1）也物化，就会出现两行——这里删掉多余行，保留 row_id=1。
    async function cleanupSingletonDuplicates(api, layoutEntries) {
        try {
            const tables = api.exportTableAsJson() || {};
            const sheetOf = (name) => {
                for (const k in tables) {
                    if (k.indexOf('sheet_') === 0 && tables[k] && tables[k].name === name) return tables[k];
                }
                return null;
            };
            for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                if (L.kind !== 'singleton' && L.kind !== 'json') continue;
                const sheet = sheetOf(L.table);
                if (!sheet || !Array.isArray(sheet.content)) continue;
                const idRows = [];
                for (let ri = 1; ri < sheet.content.length; ri++) {
                    const r = sheet.content[ri];
                    if (r && r[0] !== undefined && r[0] !== null && r[0] !== '') idRows.push({ ri, id: String(r[0]) });
                }
                if (idRows.length <= 1) continue;
                if (!idRows.some(x => x.id === '1')) continue; // 没有 row_id=1 就不删（我们补的行可能是唯一真行）
                for (const x of idRows) {
                    if (x.id === '1') continue;
                    try {
                        // 插件 deleteRow 的 rowIndex 是 content 数组索引（0=表头，1=第一数据行）。
                        // x.ri 正是 content 数组索引，直接传 x.ri；传 x.ri-1 会把表头当目标，
                        // 实际误删 row_id=1 的注入数据行（日志却按 x.id 打印成“已清理 row_id=2”）。
                        await Promise.resolve(api.deleteRow(L.table, x.ri));
                        console.log('[mvu2shujuku][debug] 已清理单例表多余行：' + L.table + '（row_id=' + x.id + '）');
                    } catch (e) {
                        console.warn('[mvu2shujuku][debug] 清理单例表多余行失败:', e);
                    }
                }
            }
        } catch (e) {}
    }

    // 把目标 stat_data 还原成完整表格 JSON：以当前导出为基座，覆盖目标值。
    // 供 importTableAsJson 走插件自己的提交管线——插件自己管理 V2 checkpoint，
    // 避免裸 updateCell 破坏锚点（实测裸写会触发 boundary_after_data_mismatch）。
    function buildTableSnapshotFromStat(api, layoutEntries, tplCached, targetStat) {
        const tables = {};
        try {
            const cur = api.exportTableAsJson() || {};
            for (const k of Object.keys(cur)) tables[k] = JSON.parse(JSON.stringify(cur[k]));
        } catch (e) {}
        const sd = targetStat || {};
        const sheetOf = (name) => {
            for (const k in tables) {
                if (k.indexOf('sheet_') === 0 && tables[k] && tables[k].name === name) return { key: k, sheet: tables[k] };
            }
            return null;
        };
        const tplRowOf = (name) => {
            try {
                if (!tplCached) return null;
                for (const k in tplCached) {
                    if (k.indexOf('sheet_') === 0 && tplCached[k] && tplCached[k].name === name &&
                        Array.isArray(tplCached[k].content) && tplCached[k].content[1]) {
                        return tplCached[k].content[1].slice();
                    }
                }
            } catch (e) {}
            return null;
        };
        const text = (v) => (v === undefined || v === null ? '' : String(v));
        const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            const found = sheetOf(L.table);
            if (!found) continue;
            const sheet = found.sheet;
            if (!Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])) continue;
            const header = sheet.content[0];
            // 嵌套组（如 主角.气运 / 主角.储物袋）的值在 stat_data 里位于 writePaths 路径下，
            // 与读侧 statDataFromTables 的 setPath(writePaths) 一一对应；顶层组退回 sd[L.group]。
            const valueOf = (LE) => {
                const wp = (LE.writePaths || [])[0];
                if (Array.isArray(wp) && wp.length) {
                    let cur = sd;
                    for (const p of wp) {
                        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
                        cur = cur[p];
                    }
                    if (cur !== undefined) return cur;
                }
                return sd[LE.group];
            };
            const value = valueOf(L);
            const declared = (L.cols || []).map(c => (Array.isArray(c) ? c[0] : (c && c.zh)));
            // 子表路径（如 世界.动向 / 主角.气运）不是本表的溢出字段，绝不能写进本表 _扩展数据
            const childGroupKeys = new Set();
            for (const L2 of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                if (L2 === L) continue;
                const wp = (L2.writePaths || [])[0];
                if (Array.isArray(wp) && wp.length >= 2 && wp[0] === L.group) childGroupKeys.add(wp[1]);
            }
            // 已展平为列的嵌套容器（如 主角.炼丹.阶级 → 列「炼丹阶级」）：整容器不重复写进溢出列
            const flattenedContainers = new Set();
            for (const c of (L.cols || [])) {
                const cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                if (Array.isArray(cp) && cp.length > 1 && cp[0] === L.group) flattenedContainers.add(cp[1]);
            }
            const mergeOverflow = (row, obj) => {
                const ovIdx = header.indexOf('_扩展数据');
                if (ovIdx === -1) return;
                const overflow = {};
                for (const k of Object.keys(obj)) {
                    if (!declared.includes(k) && k !== L.keyCol && !childGroupKeys.has(k) && !flattenedContainers.has(k)) overflow[k] = obj[k];
                }
                if (!Object.keys(overflow).length) return;
                let cur = {};
                try { cur = JSON.parse(row[ovIdx] || '{}'); } catch (e2) {}
                Object.assign(cur, overflow);
                row[ovIdx] = JSON.stringify(cur);
            };
            if (L.kind === 'array') {
                const arr = Array.isArray(value) ? value : [];
                const vCol = header[1] || '内容';
                sheet.content = [header];
                for (const item of arr) {
                    const row = header.map(() => '');
                    row[0] = sheet.content.length;
                    row[1] = text(item);
                    sheet.content.push(row);
                }
                continue;
            }
            if (L.kind === 'json') {
                const jIdx = header.indexOf('内容');
                if (jIdx === -1) continue;
                if (sheet.content.length < 2) {
                    const tRow = tplRowOf(L.table) || header.map(() => '');
                    tRow[0] = 1;
                    sheet.content.push(tRow);
                }
                sheet.content[1][jIdx] = JSON.stringify(value === undefined ? {} : value);
                continue;
            }
            if (L.kind === 'singleton') {
                const obj = isObj(value) ? value : {};
                if (sheet.content.length < 2) {
                    const tRow = tplRowOf(L.table) || header.map(() => '');
                    if (tRow[0] === undefined || tRow[0] === null || tRow[0] === '') tRow[0] = 1;
                    sheet.content.push(tRow);
                }
                const row = sheet.content[1];
                // 列值优先按布局列的路径解析（如 主角.炼丹.阶级 → 列「炼丹阶级」）；
                // 顶层字段直接取 obj[col]。
                const colPathOf = (zh) => {
                    for (const c of (L.cols || [])) {
                        const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                        if (czh === zh) return Array.isArray(c) ? (c[3] || []) : (c.path || []);
                    }
                    return null;
                };
                const colValueOf = (zh) => {
                    const cp = colPathOf(zh);
                    if (Array.isArray(cp) && cp.length > 1 && cp[0] === L.group) {
                        let cur = obj;
                        for (let pi = 1; pi < cp.length; pi++) {
                            if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
                            cur = cur[cp[pi]];
                        }
                        if (cur !== undefined) return cur;
                    }
                    return Object.prototype.hasOwnProperty.call(obj, zh) ? obj[zh] : undefined;
                };
                const colTypeOf = (zh) => {
                    for (const c of (L.cols || [])) {
                        const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                        if (czh === zh) return Array.isArray(c) ? String(c[1] || '') : String(c.type || '');
                    }
                    return '';
                };
                for (let ci = 1; ci < header.length; ci++) {
                    const col = header[ci];
                    if (col === '_扩展数据') continue;
                    const cv = colValueOf(col);
                    if (cv === undefined) continue;
                    row[ci] = /object|json/i.test(colTypeOf(col)) ? (typeof cv === 'string' ? cv : JSON.stringify(cv === undefined || cv === null ? '' : cv)) : text(cv);
                }
                mergeOverflow(row, obj);
                continue;
            }
            // rows：按 keyCol upsert
            const dict = isObj(value) ? value : {};
            const keyIdx = header.indexOf(L.keyCol);
            if (keyIdx === -1) continue;
            const existing = new Map();
            for (let ri = 1; ri < sheet.content.length; ri++) {
                const r = sheet.content[ri];
                if (r && r[keyIdx] !== undefined && r[keyIdx] !== null && r[keyIdx] !== '') existing.set(String(r[keyIdx]), ri);
            }
            for (const k of Object.keys(dict)) {
                const item = dict[k];
                if (!isObj(item)) continue;
                let ri = existing.get(String(k));
                if (ri === undefined) {
                    const tRow = tplRowOf(L.table) || header.map(() => '');
                    sheet.content.push(tRow);
                    ri = sheet.content.length - 1;
                    const r = sheet.content[ri];
                    r[0] = ri;
                    if (keyIdx >= 0) r[keyIdx] = text(k);
                    existing.set(String(k), ri);
                }
                const row = sheet.content[ri];
                for (let ci = 1; ci < header.length; ci++) {
                    const col = header[ci];
                    if (col === '_扩展数据') continue;
                    if (Object.prototype.hasOwnProperty.call(item, col)) {
                        const iv = item[col];
                        let colT = '';
                        for (const c of (L.cols || [])) {
                            const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                            if (czh === col) { colT = Array.isArray(c) ? String(c[1] || '') : String(c.type || ''); break; }
                        }
                        row[ci] = /object|json/i.test(colT) ? (typeof iv === 'string' ? iv : JSON.stringify(iv === undefined || iv === null ? '' : iv)) : text(iv);
                    }
                }
                mergeOverflow(row, item);
            }
        }
        return tables;
    }

    // 把「注入后的表格快照」合并回原始模板：保留模板的 sourceData(DDL/规则)/updateConfig/exportConfig，
    // 用快照里的 content（含注入数据）替换模板行，生成可供 initGameSession 一次性建表带数据的 templateData。
    function mergeSnapshotIntoTemplate(tplCached, snapshot) {
        try {
            if (!tplCached || typeof tplCached !== 'object' || !snapshot || typeof snapshot !== 'object') return null;
            const out = JSON.parse(JSON.stringify(tplCached));
            for (const k of Object.keys(out)) {
                if (k.indexOf('sheet_') !== 0) continue;
                const tplSheet = out[k];
                const snapSheet = snapshot[k];
                if (!tplSheet || !snapSheet || typeof tplSheet !== 'object' || typeof snapSheet !== 'object') continue;
                if (Array.isArray(snapSheet.content) && snapSheet.content.length > 0) {
                    tplSheet.content = JSON.parse(JSON.stringify(snapSheet.content));
                }
                if (Array.isArray(snapSheet.seedRows)) tplSheet.seedRows = JSON.parse(JSON.stringify(snapSheet.seedRows));
            }
            return out;
        } catch (e) {
            console.warn('[mvu2shujuku][debug] 合并注入模板失败:', e && e.message ? e.message : e);
            return null;
        }
    }

    // 直接用注入后的 stat_data 覆盖模板行（不依赖 export 当前状态）：
    // 模板的 content 一定带 row_id=1 初始行（转换时写入），我们只需把 target 的值盖上去。
    // 这样即使 SQLite 运行时 content 是空的（数据在 seedRows），模板行也在，注入数据不会丢。
    // 这等价于参考卡 buildOpeningTemplateData：在模板 content 里直接替换用户数据。
    function applyTargetToTemplate(tplCached, layoutEntries, targetStat) {
        try {
            if (!tplCached || typeof tplCached !== 'object' || !targetStat) return tplCached;
            const out = JSON.parse(JSON.stringify(tplCached));
            const sd = targetStat || {};
            const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
            const text = (v) => (v === undefined || v === null ? '' : String(v));
            for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                const sheet = Object.keys(out)
                    .filter(k => k.indexOf('sheet_') === 0)
                    .map(k => out[k])
                    .find(s => s && s.name === L.table);
                if (!sheet || !Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])) continue;
                const header = sheet.content[0];
                // 嵌套组（如 主角.气运 / 主角.储物袋）的值在 stat_data 里位于 writePaths 路径下，
                // 与读侧 statDataFromTables 的 setPath(writePaths) 一一对应；顶层组退回 sd[L.group]。
                const valueOf = (LE) => {
                    const wp = (LE.writePaths || [])[0];
                    if (Array.isArray(wp) && wp.length) {
                        let cur = sd;
                        for (const p of wp) {
                            if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
                            cur = cur[p];
                        }
                        if (cur !== undefined) return cur;
                    }
                    return sd[LE.group];
                };
                const value = valueOf(L);
                if (L.kind === 'singleton' || L.kind === 'json') {
                    const obj = isObj(value) ? value : {};
                    // 模板至少带 row_id=1 的初始行；若没有则补一行
                    if (sheet.content.length < 2) {
                        const tRow = header.map(() => '');
                        tRow[0] = 1;
                        sheet.content.push(tRow);
                    }
                    const row = sheet.content[1];
                    row[0] = 1;
                    if (L.kind === 'json') {
                        const jIdx = header.indexOf('内容');
                        if (jIdx >= 0) row[jIdx] = JSON.stringify(value === undefined ? {} : value);
                    }
                    // 列值优先按布局列的路径解析（如 主角.炼丹.阶级 → 列「炼丹阶级」）；
                    // 顶层字段直接取 obj[col]。
                    const colPathOf = (zh) => {
                        for (const c of (L.cols || [])) {
                            const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                            if (czh === zh) return Array.isArray(c) ? (c[3] || []) : (c.path || []);
                        }
                        return null;
                    };
                    const colValueOf = (zh) => {
                        const cp = colPathOf(zh);
                        if (Array.isArray(cp) && cp.length > 1 && cp[0] === L.group) {
                            let cur = obj;
                            for (let pi = 1; pi < cp.length; pi++) {
                                if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
                                cur = cur[cp[pi]];
                            }
                            if (cur !== undefined) return cur;
                        }
                        return Object.prototype.hasOwnProperty.call(obj, zh) ? obj[zh] : undefined;
                    };
                    const colTypeOf = (zh) => {
                        for (const c of (L.cols || [])) {
                            const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                            if (czh === zh) return Array.isArray(c) ? String(c[1] || '') : String(c.type || '');
                        }
                        return '';
                    };
                    // 子表路径（如 世界.动向 / 主角.气运）与已展平容器（如 主角.炼丹）都不能进本表溢出列
                    const childGroupKeys = new Set();
                    for (const L2 of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
                        if (L2 === L) continue;
                        const wp2 = (L2.writePaths || [])[0];
                        if (Array.isArray(wp2) && wp2.length >= 2 && wp2[0] === L.group) childGroupKeys.add(wp2[1]);
                    }
                    const flattenedContainers = new Set();
                    for (const c of (L.cols || [])) {
                        const cp2 = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                        if (Array.isArray(cp2) && cp2.length > 1 && cp2[0] === L.group) flattenedContainers.add(cp2[1]);
                    }
                    for (let ci = 1; ci < header.length; ci++) {
                        const col = header[ci];
                        if (col === '_扩展数据' || col === '内容') continue;
                        const cv = colValueOf(col);
                        if (cv === undefined) continue;
                        row[ci] = /object|json/i.test(colTypeOf(col)) ? (typeof cv === 'string' ? cv : JSON.stringify(cv === undefined || cv === null ? '' : cv)) : text(cv);
                    }
                    // 溢出字段合并进 _扩展数据（AI 不应直接修改的内部字段）
                    const ovIdx = header.indexOf('_扩展数据');
                    if (ovIdx >= 0) {
                        const overflow = {};
                        for (const k of Object.keys(obj)) {
                            if (!header.includes(k) && k !== L.keyCol && !childGroupKeys.has(k) && !flattenedContainers.has(k)) overflow[k] = obj[k];
                        }
                        if (Object.keys(overflow).length) {
                            let cur = {};
                            try { cur = JSON.parse(row[ovIdx] || '{}'); } catch (e) {}
                            Object.assign(cur, overflow);
                            row[ovIdx] = JSON.stringify(cur);
                        }
                    }
                    continue;
                }
                if (L.kind === 'array') {
                    const arr = Array.isArray(value) ? value : [];
                    const vCol = header[1] || '内容';
                    sheet.content = [header];
                    arr.forEach((item, i) => {
                        const row = header.map(() => '');
                        row[0] = i + 1;
                        row[1] = text(item);
                        sheet.content.push(row);
                    });
                    continue;
                }
                // rows：按 keyCol upsert
                if (!isObj(value)) continue;
                const keyIdx = header.indexOf(L.keyCol);
                if (keyIdx === -1) continue;
                for (const k of Object.keys(value)) {
                    const item = value[k];
                    if (!isObj(item)) continue;
                    let ri = -1;
                    for (let r = 1; r < sheet.content.length; r++) {
                        const row = sheet.content[r];
                        if (row && row[keyIdx] !== undefined && row[keyIdx] !== null && String(row[keyIdx]) === String(k)) { ri = r; break; }
                    }
                    if (ri === -1) {
                        const row = header.map(() => '');
                        row[0] = sheet.content.length;
                        row[keyIdx] = text(k);
                        sheet.content.push(row);
                        ri = sheet.content.length - 1;
                    }
                    const row = sheet.content[ri];
                    for (let ci = 1; ci < header.length; ci++) {
                        const col = header[ci];
                        if (col === '_扩展数据' || col === L.keyCol) continue;
                        if (Object.prototype.hasOwnProperty.call(item, col)) {
                            const iv = item[col];
                            let colT = '';
                            for (const c of (L.cols || [])) {
                                const czh = Array.isArray(c) ? c[0] : (c && c.zh);
                                if (czh === col) { colT = Array.isArray(c) ? String(c[1] || '') : String(c.type || ''); break; }
                            }
                            row[ci] = /object|json/i.test(colT) ? (typeof iv === 'string' ? iv : JSON.stringify(iv === undefined || iv === null ? '' : iv)) : text(iv);
                        }
                    }
                    const ovIdx = header.indexOf('_扩展数据');
                    if (ovIdx >= 0) {
                        const overflow = {};
                        for (const f of Object.keys(item)) {
                            if (!header.includes(f) && f !== L.keyCol) overflow[f] = item[f];
                        }
                        if (Object.keys(overflow).length) {
                            let cur = {};
                            try { cur = JSON.parse(row[ovIdx] || '{}'); } catch (e) {}
                            Object.assign(cur, overflow);
                            row[ovIdx] = JSON.stringify(cur);
                        }
                    }
                }
            }
            return out;
        } catch (e) {
            console.warn('[mvu2shujuku][debug] applyTargetToTemplate 失败:', e && e.message ? e.message : e);
            return tplCached;
        }
    }

    // 对齐参考卡 waitForOpeningDatabase：initGameSession 后运行时可能异步物化表格，
    // 短轮询确认注入数据真的进了 exportTableAsJson；确认不了再由调用方回退快照提交。
    // 只校验“目标 stat_data 里有非默认值”的表，没有任何注入值视为成功（纯文本开场白等场景）。
    async function verifyTemplateInjected(api, layoutEntries, targetStat, timeoutMs) {
        const sd = targetStat || {};
        const checks = [];
        const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            const wp = (L.writePaths || [])[0];
            let v = undefined;
            if (Array.isArray(wp) && wp.length) {
                let cur = sd;
                for (const p of wp) {
                    if (cur === null || cur === undefined || typeof cur !== 'object') { v = undefined; break; }
                    cur = cur[p];
                    v = cur;
                }
            } else {
                v = sd[L.group];
            }
            if (!isObj(v)) continue;
            if (L.kind === 'rows') {
                const keys = Object.keys(v).filter(k => isObj(v[k]));
                if (keys.length) checks.push({ table: L.table, needles: keys.map(k => String(k)) });
            } else if (L.kind === 'singleton') {
                const cols = (L.cols || []).map(c => (Array.isArray(c) ? c[0] : (c && c.zh)));
                const needles = [];
                for (const c of cols) {
                    const cv = v[c];
                    if (cv !== undefined && cv !== null && cv !== '') needles.push(String(cv));
                }
                if (needles.length) checks.push({ table: L.table, needles });
            }
        }
        if (!checks.length) return true;
        const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
        while (Date.now() < deadline) {
            try {
                const all = api.exportTableAsJson() || {};
                let allOk = true;
                for (const chk of checks) {
                    let sheet = null;
                    for (const k in all) {
                        if (k.indexOf('sheet_') === 0 && all[k] && all[k].name === chk.table) { sheet = all[k]; break; }
                    }
                    if (!sheet || !Array.isArray(sheet.content)) { allOk = false; break; }
                    let found = false;
                    for (let r = 1; r < sheet.content.length; r++) {
                        const row = sheet.content[r];
                        if (!Array.isArray(row)) continue;
                        if (chk.needles.some(n => n && row.some(cell => String(cell == null ? '' : cell) === n))) { found = true; break; }
                    }
                    if (!found) { allOk = false; break; }
                }
                if (allOk) return true;
            } catch (e) {}
            await new Promise(res => hostWindow.setTimeout(res, 150));
        }
        return false;
    }

    // 合并写入：前端一次操作常连续触发多次 replaceMvuData（如同步资源+追加操作日志），
    // 短窗口内合并为一次持久化；读路径直接返回待写快照保证写后立即读一致。
    function scheduleWindowStatOverlay(next) {
        statWriteOverlayGen += 1;
        pendingStatWrite = next;
        if (statWriteTimer) hostWindow.clearTimeout(statWriteTimer);
        statWriteTimer = hostWindow.setTimeout(async () => {
            statWriteTimer = null;
            const target = pendingStatWrite;
            if (target === null || target === undefined) return;
            const gen = statWriteOverlayGen;
            try {
                const api = getAcuApi();
                if (api && activeLayout) {
                    // 写库前保证 full checkpoint 存在：无锚点写入会产生无锚点 artifacts，
                    // 触发插件 V2 boundary_after_data_mismatch。锚点无法建立则放弃本次写入。
                    const tplCached = cachedTemplateForCurrentCard();
                    if (!tplCached) {
                        console.warn('[mvu2shujuku][debug][流程] 写库前无模板缓存，放弃本次写入（等待自动建表）。');
                        pendingStatWrite = null;
                        return;
                    }
                    const anchored = await ensureCheckpointBeforeWrite(api, tplCached);
                    if (!anchored) {
                        console.warn('[mvu2shujuku][debug][流程] 写库前无法建立 full checkpoint，放弃本次写入，避免产生无锚点 artifacts。');
                        pendingStatWrite = null;
                        return;
                    }
                    const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                    const prev = all.stat_data || {};
                    // 写入主路径：开局（表格仍是模板初始状态、无真实数据）时，把注入后的
                    // stat_data 合并进模板，走插件 initGameSession 一次性建表。
                    // 关键：initGameSession 会同时写入 TavernDB_ACU_IsolatedData +
                    // InternalSheetGuide + ScopedConfig 三个字段——插件 UI 靠后两个判定
                    // “已初始化”，刷新后从完整 checkpoint 恢复，数据不丢。
                    // 之前用 importTableAsJson 只写数据帧，不建 guide/scope，UI 显示
                    // “未初始/待初始”，刷新后数据消失。
                    let n = 0;
                    let usedSnapshot = false;
                    try {
                        // 每聊天首次写库：用注入数据合并模板再 initGameSession 一次性建表。
                        // 这样插件会写入 IsolatedData + InternalSheetGuide + ScopedConfig 完整初始化状态，
                        // UI 显示“已初始化”，刷新后从 full checkpoint 恢复。
                        // 注意不能依赖 mvu2shujukuTablesSafeToAnchor 判断：物化垫脚行会让它误判非初始。
                        const chatKeyNow = autoInitChatId();
                        const isFirstWrite = !initializedViaGameSession.has(chatKeyNow);
                        const snap = buildTableSnapshotFromStat(api, activeLayout, tplCached, target);
                        // 首次写库直接用注入后的 stat_data 覆盖模板行（等价于参考卡 buildOpeningTemplateData）：
                        // 开局时运行时表格常为空，exportTableAsJson 拿不到任何表，快照合并会把用户数据丢掉；
                        // 直接改模板 content 则无论运行时状态如何，注入数据都在传入 initGameSession 的模板里。
                        const mergedTemplate = (isFirstWrite && Array.isArray(activeLayout))
                            ? applyTargetToTemplate(tplCached, activeLayout, target)
                            : mergeSnapshotIntoTemplate(tplCached, snap);
                        // 诊断：确认注入数据是否真的进了合并模板（主角表 content 第一行）
                        try {
                            const heroName = target.主角 && target.主角.姓名;
                            const mtProt = mergedTemplate && mergedTemplate.sheet_zhujiaobiao;
                            const mtRow = mtProt && Array.isArray(mtProt.content) ? mtProt.content[1] : null;
                            console.log('[mvu2shujuku][debug][注入合并] 首次写库=' + isFirstWrite + ' | target.主角.姓名=' + heroName +
                                ' | 合并模板主角表 content 行数=' + (mtProt && Array.isArray(mtProt.content) ? mtProt.content.length : 'N/A') +
                                ' | content[1]=' + (mtRow ? JSON.stringify(mtRow).slice(0, 160) : '无'));
                        } catch (e) {}
                        if (isFirstWrite && mergedTemplate && typeof api.initGameSession === 'function') {
                            const initResult = await Promise.resolve(api.initGameSession({}, {
                                injectTemplate: true,
                                loadPreset: false,
                                templateData: mergedTemplate,
                                templatePresetName: String((currentCharacter() && currentCharacter().name) || '') + '模板',
                            }));
                            if (initResult && initResult.success === false) {
                                console.warn('[mvu2shujuku][debug] initGameSession(注入合并) 失败：' + (initResult.message || '未知错误') + '，回退快照提交');
                            } else {
                                const initInfo = initResult ? JSON.stringify({
                                    success: initResult.success,
                                    runtimeReady: initResult.runtimeReady,
                                    warning: initResult.warning || '',
                                    message: initResult.message || '',
                                }) : 'undefined';
                                console.log('[mvu2shujuku][debug] Mvu 写入完成（initGameSession 合并注入数据建表，插件建立完整初始化状态）| initResult=' + initInfo.slice(0, 300));
                                // 对齐参考卡：initGameSession 后运行时可能异步物化，短轮询确认注入数据落表；
                                // 确认不了则回退 importTableAsJson 快照提交（用合并模板，保证数据不丢）。
                                const injected = await verifyTemplateInjected(api, activeLayout, target, 1800);
                                if (injected) {
                                    usedSnapshot = true;
                                } else {
                                    console.warn('[mvu2shujuku][debug][注入合并] initGameSession 后未在运行时表格中确认注入数据，回退 importTableAsJson 快照提交。');
                                }
                            }
                        }
                        if (!usedSnapshot && typeof api.importTableAsJson === 'function') {
                            // 非开局/initGameSession 失败/运行时未确认：回退完整快照提交。
                            // 用合并后的模板（含注入数据）而不是 exportTableAsJson 快照——
                            // 开局时 export 可能为空，空快照会把注入数据覆盖成空表。
                            const ok = await Promise.resolve(api.importTableAsJson(JSON.stringify(mergedTemplate || snap), {}));
                            if (ok) {
                                usedSnapshot = true;
                                console.log('[mvu2shujuku][debug] Mvu 写入完成（importTableAsJson 快照提交，插件自身持久化）');
                            } else {
                                console.warn('[mvu2shujuku][debug] importTableAsJson 快照提交失败，回退差异写入');
                            }
                        }
                        if (usedSnapshot) {
                            initializedViaGameSession.add(chatKeyNow);
                            // 插件内部走的是酒馆 saveChat 防抖，可能晚于本流程落盘；
                            // 首楼随后可能被开场流程替换/删除，checkpoint 必须在替换前落盘。
                            // 这里等待酒馆保存真正完成（saveChatConditional 自带超时，失败只告警不阻塞）。
                            try {
                                const ctx2 = getContextSafe();
                                const saveFn2 = (typeof ctx2.saveChatConditional === 'function' && ctx2.saveChatConditional.bind(ctx2)) ||
                                    (typeof ctx2.saveChat === 'function' && ctx2.saveChat.bind(ctx2)) ||
                                    (typeof window.saveChatConditional === 'function' ? window.saveChatConditional.bind(window) : null) ||
                                    (typeof window.saveChat === 'function' ? window.saveChat.bind(window) : null);
                                if (saveFn2) {
                                    for (let attempt = 0; attempt < 2; attempt++) {
                                        try {
                                            await Promise.resolve(saveFn2());
                                            console.log('[mvu2shujuku][debug][保存] 首写快照提交后已等待酒馆保存完成（attempt=' + (attempt + 1) + '）。');
                                            break;
                                        } catch (saveErr) {
                                            console.warn('[mvu2shujuku][debug][保存] 首写后等待酒馆保存失败（attempt=' + (attempt + 1) + '）：' + (saveErr && saveErr.message ? saveErr.message : saveErr));
                                        }
                                    }
                                }
                            } catch (e) {
                                console.warn('[mvu2shujuku][debug][保存] 首写后等待酒馆保存异常（不影响内存数据）:', e && e.message ? e.message : e);
                            }
                        }
                    } catch (e) {
                        console.warn('[mvu2shujuku][debug] 快照提交异常，回退差异写入:', e && e.message ? e.message : e);
                    }
                    if (!usedSnapshot) {
                        // 差异写入（裸 updateCell/insertRow）——作为 initGameSession/importTableAsJson
                        // 都失败时的降级路径。此时才需要物化垫底行（确保 content 有 row_id=1 可写）、
                        // 主动 saveChat 落盘、以及清理多余的垫底行。
                        await ensureSingletonRowsMaterialized(api, tplCached, activeLayout);
                        n = await window.MVU2SHUJUKU_CORE.writeStatDiffToDb(api, activeLayout, prev, target);
                        if (n > 0) console.log('[mvu2shujuku][debug] Mvu 合并写入完成：差异 ' + n + ' 条');
                        // 降级路径依赖酒馆 saveChat 落盘（importTableAsJson 成功时插件已自己持久化，无需额外保存）
                        try {
                            const ctx3 = getContextSafe();
                            const saveFn3 = (typeof ctx3.saveChatConditional === 'function' && ctx3.saveChatConditional.bind(ctx3)) ||
                                (typeof ctx3.saveChat === 'function' && ctx3.saveChat.bind(ctx3)) ||
                                (typeof window.saveChatConditional === 'function' ? window.saveChatConditional.bind(window) : null) ||
                                (typeof window.saveChat === 'function' ? window.saveChat.bind(window) : null);
                            if (saveFn3) {
                                for (let attempt = 0; attempt < 2; attempt++) {
                                    try {
                                        await Promise.resolve(saveFn3());
                                        console.log('[mvu2shujuku][debug][保存] 差异写入后已主动保存聊天（attempt=' + (attempt + 1) + '）');
                                        break;
                                    } catch (saveErr) {
                                        console.warn('[mvu2shujuku][debug][保存] 主动保存聊天失败（attempt=' + (attempt + 1) + '）：' + (saveErr && saveErr.message ? saveErr.message : saveErr));
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    // 诊断：写入后立即检查聊天 checkpoint 里是否包含刚写入的数据。
                    // 若 checkpoint 仍是初始快照（不含用户注入值），重进聊天时插件会从 checkpoint
                    // 恢复成初始数据——这就是“重新进入后数据没了”的根因。
                    try {
                        const ctx = getContextSafe();
                        const chatArr = Array.isArray(ctx.chat) ? ctx.chat : [];
                        for (let mi = 0; mi < chatArr.length && mi < 3; mi++) {
                            const msg = chatArr[mi];
                            if (!msg || typeof msg !== 'object') continue;
                            const iso = msg.TavernDB_ACU_IsolatedData;
                            if (!iso) continue;
                            let containsUserData = false;
                            try {
                                const s = JSON.stringify(iso);
                                // 检查主角表首行是否有注入值（姓名等与模板不同的内容）
                                const sd = window.getAllVariables ? (window.getAllVariables().stat_data || {}) : {};
                                const heroName = sd.主角 && sd.主角.姓名;
                                containsUserData = heroName && heroName !== '未知' && s.indexOf(String(heroName)) !== -1;
                            } catch (e) {}
                            console.log('[mvu2shujuku][debug][checkpoint] 消息' + mi + ' 有 IsolatedData | json长度=' + (JSON.stringify(iso) || '').length + ' | 含主角姓名=' + containsUserData);
                            break;
                        }
                    } catch (e) {}
                    if (!hasFullShujukuCheckpoint()) {
                        console.warn('[mvu2shujuku][debug][流程] 写库完成后聊天仍无 full checkpoint！若插件随后自动填表提交，可能出现 V2 boundary_after_data_mismatch。');
                    }
                    // 单例/JSON 表去重：仅在降级裸写路径物化过垫底行时需要清理；
                    // initGameSession/importTableAsJson 成功后表格本身是干净的，无需清理。
                    if (!usedSnapshot) {
                        await cleanupSingletonDuplicates(api, activeLayout);
                    }
                    dispatchVariableUpdateEnded({ stat_data: target, display_data: target, delta_data: {}, initialized_lorebooks: {} }, { stat_data: prev, display_data: prev, delta_data: {}, initialized_lorebooks: {} });
                } else {
                    console.warn('[mvu2shujuku][debug] Mvu 合并写库被跳过：api=' + !!api + ' activeLayout=' + (activeLayout ? '有' : '空'));
                }
            } catch (e) {
                console.warn('[mvu2shujuku][debug] Mvu 合并写入异常:', e);
            } finally {
                if (statWriteOverlayGen === gen) pendingStatWrite = null;
            }
        }, 150);
    }

    // 扩展侧提供 window.getAllVariables：用卡内布局 + 插件表格实时重建 stat_data（惰性，零冗余）。
    // 只在当前卡是本转换器产物时安装；切到其他卡时恢复原函数（或删除），不污染其他卡。
    let installedGetAllVariables = false;
    let originalGetAllVariables = undefined;
    function installWindowGetAllVariables() {
        const core = window.MVU2SHUJUKU_CORE;
        if (typeof window.getAllVariables === 'function') return;
        if (!core || typeof core.statDataFromTables !== 'function') return;
        if (!installedGetAllVariables) {
            originalGetAllVariables = window.getAllVariables;
            installedGetAllVariables = true;
        }
        window.getAllVariables = function () {
            try {
                const api = getAcuApi();
                if (!api || typeof api.exportTableAsJson !== 'function' || !activeLayout) {
                    return { stat_data: {}, display_data: {} };
                }
                return core.statDataFromTables(activeLayout, api.exportTableAsJson());
            } catch (e) {
                return { stat_data: {}, display_data: {} };
            }
        };
        window.getAllVariables.__mvu2shujuku = true;
        console.log('[mvu2shujuku][debug] 扩展侧已定义 window.getAllVariables（读插件表格重建 stat_data）');
    }
    function restoreWindowGetAllVariables() {
        if (!installedGetAllVariables) return;
        try {
            if (window.getAllVariables && window.getAllVariables.__mvu2shujuku === true) {
                if (originalGetAllVariables === undefined) delete window.getAllVariables;
                else window.getAllVariables = originalGetAllVariables;
            }
        } catch (e) {}
        installedGetAllVariables = false;
        originalGetAllVariables = undefined;
    }

    // 表格更新广播：与 MVU 原版一致，数据库一有变动就广播 VARIABLE_UPDATE_ENDED，
    // 携带更新后的完整变量（before 在无基线时传空，前端结算逻辑会安全跳过）。
    // 只在本转换器产物的卡上广播（activeLayout 仅对转换卡缓存），其他数据库卡即使触发表格更新也不发 MVU 事件。
    function dispatchVariableUpdateEnded(after, before) {
        try {
            if (!activeLayout) return;
            if (after === undefined || after === null) {
                try { if (typeof window.getAllVariables === 'function') after = window.getAllVariables(); } catch (e) {}
            }
            emitMvuEvent('mag_variable_update_ended', after || { stat_data: {}, display_data: {} }, before);
        } catch (e) {}
    }

    // 事件广播：与 MVU 原版一致，优先走 TH 事件总线（eventEmit，前端 eventOn 监听的就是它）；
    // 另发同名 CustomEvent + ST eventSource，覆盖 window/parent/top/同源 iframe；
    // 缺少 ST 事件总线的窗口（如消息 iframe）补一个绑定到同名 CustomEvent 的 eventOn/eventOff 兜底。
    function installEarlyEventOnFallback() {
        try {
            for (const w of [window, hostWindow]) {
                if (!w || typeof w.addEventListener !== 'function' || typeof w.eventOn === 'function') continue;
                w.eventOn = (evName, handler) => {
                    const wrapped = (e) => {
                        try {
                            const d = e && e.detail;
                            if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                            else handler(d);
                        } catch (err) {}
                    };
                    w.addEventListener(evName, wrapped);
                    return { stop: () => { try { w.removeEventListener(evName, wrapped); } catch (e2) {} } };
                };
                w.eventOff = (evName, handler) => { try { w.removeEventListener(evName, handler); } catch (e2) {} };
            }
        } catch (e) {}
    }
    function emitMvuEvent(name, a, b) {
        const targets = [];
        const add = (t) => { try { if (t && typeof t.dispatchEvent === 'function' && targets.indexOf(t) === -1) targets.push(t); } catch (e) {} };
        add(window);
        add(hostWindow);
        try { add(window.parent); } catch (e) {}
        try { add(window.top); } catch (e) {}
        for (const r of [window, hostWindow]) {
            try {
                const frames = r.document ? r.document.querySelectorAll('iframe') : [];
                for (const f of frames) { try { add(f.contentWindow); } catch (e) {} }
            } catch (e) {}
        }
        for (const t of targets) {
            try { const EC = t.CustomEvent || CustomEvent; t.dispatchEvent(new EC(name, { detail: { after: a, before: b } })); } catch (e) {}
            try { if (t.eventSource && typeof t.eventSource.emit === 'function') t.eventSource.emit(name, a, b); } catch (e) {}
            // 前端 iframe 的 eventOn 可能是 TH 注入的、绑定在 TH 事件总线（eventEmit）上；
            // 只对主窗口调 eventEmit 收不到，必须对每个 target（含消息 iframe）也广播 eventEmit。
            try { if (typeof t.eventEmit === 'function') t.eventEmit(name, a, b); } catch (e) {}
        }
        // 与 MVU 原版一致：尽量走 TH 的事件总线（前端 eventOn 监听的就是它）
        try { if (typeof hostWindow.eventEmit === 'function') hostWindow.eventEmit(name, a, b); } catch (e) {}
        try { if (typeof window.eventEmit === 'function') window.eventEmit(name, a, b); } catch (e) {}
        for (const t of targets) {
            try {
                if (t && typeof t.eventOn !== 'function' && typeof t.addEventListener === 'function') {
                    t.eventOn = (evName, handler) => {
                        const wrapped = (e) => {
                            try {
                                const d = e && e.detail;
                                if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                                else handler(d);
                            } catch (err) {}
                        };
                        t.addEventListener(evName, wrapped);
                        return { stop: () => { try { t.removeEventListener(evName, wrapped); } catch (e) {} } };
                    };
                    t.eventOff = (evName, handler) => { try { t.removeEventListener(evName, handler); } catch (e) {} };
                }
            } catch (e) {}
        }
    }

    function installTableUpdateHook() {
        const api = getAcuApi();
        if (!api || typeof api.registerTableUpdateCallback !== 'function') return false;
        try {
            api.registerTableUpdateCallback(() => dispatchVariableUpdateEnded());
            return true;
        } catch (e) { return false; }
    }

    // =================================================================
    // 扩展侧 Mvu 兼容层：按 MVU 官方全局 API（createMvu）完整实现，
    // 覆盖式接管运行环境里残留的真 MVU（避免双轨冲突），桥不在主窗口时也能读写数据库。
    // =================================================================
    function parseMvuCmdValue(raw) {
        const t = String(raw == null ? '' : raw).trim();
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (t === 'null') return null;
        if (t === 'undefined') return undefined;
        try { return JSON.parse(t); } catch (e) {}
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        return t.replace(/^['"]|['"]$/g, '');
    }
    function splitMvuCmdArgs(argsStr) {
        const out = [];
        let cur = '', depth = 0, inStr = null;
        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (inStr) { cur += ch; if (ch === '\\') { cur += argsStr[i + 1] || ''; i++; continue; } if (ch === inStr) inStr = null; continue; }
            if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    // 与卡内桥同一套通用命令规则：解析 <UpdateVariable>/<json_patch> 中的 _.set/_.add/_.remove 等指令
    function parseMvuCommands(text) {
        const cmds = [];
        const blockRe = /<(updatevariable|json_?patch)>[\s\S]*?(?:\/\1>)/gi;
        let m;
        while ((m = blockRe.exec(String(text || '')))) {
            const inner = m[0].replace(/<[^>]+>/g, '').replace(/\x60\x60\x60[^\x60]*\x60\x60\x60/g, '').trim();
            if (m[1].toLowerCase().indexOf('json') === 0) {
                try {
                    const patch = JSON.parse(inner);
                    if (Array.isArray(patch)) {
                        for (const op of patch) {
                            if (!op || (!op.path && !op.to)) continue;
                            cmds.push({ type: op.op === 'delta' ? 'add' : op.op || 'set', path: String(op.path || op.to || '').replace(/^\//, '').replace(/\//g, '.'), value: op.value, from: op.from });
                        }
                    }
                } catch (e) {}
                continue;
            }
            const cmdRe = /\.(set|assign|insert|remove|unset|delete|add)\(/g;
            let cm;
            while ((cm = cmdRe.exec(inner))) {
                const open = inner.indexOf('(', cm.index + cm[0].length - 1);
                if (open === -1) continue;
                let depth = 1, end = -1, inS = null;
                for (let k = open + 1; k < inner.length; k++) {
                    const c = inner[k];
                    if (inS) { if (c === '\\') { k++; continue; } if (c === inS) inS = null; continue; }
                    if (c === "'" || c === '"') { inS = c; continue; }
                    if (c === '(') depth++;
                    else if (c === ')') { depth--; if (depth === 0) { end = k; break; } }
                }
                if (end === -1) break;
                const args = splitMvuCmdArgs(inner.slice(open + 1, end));
                const after = inner.slice(end + 1).replace(/^\s*;\s*/, '');
                let reason = '';
                const rm = after.match(/^\/\/\s*([^\n]*)/);
                if (rm) reason = rm[1].trim();
                const type = cm[1];
                const path = String(args[0] || '').replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\//g, '.');
                if (type === 'remove' || type === 'unset' || type === 'delete') cmds.push({ type: 'delete', path, reason });
                else if (type === 'insert') cmds.push({ type: 'insert', path, keyOrIndex: args[1] !== undefined ? parseMvuCmdValue(args[1]) : null, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : undefined, reason });
                else if (type === 'assign') cmds.push({ type: 'assign', path, keyOrIndex: args[2] !== undefined ? parseMvuCmdValue(args[1]) : undefined, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : parseMvuCmdValue(args[1]), reason });
                else if (type === 'add') cmds.push({ type: 'add', path, value: args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined, reason });
                else cmds.push({ type: 'set', path, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : (args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined), reason });
                cmdRe.lastIndex = end + 1;
            }
        }
        return cmds;
    }
    function applyMvuCommands(stat, cmds, display) {
        const setPathArr = (obj, parts, value) => {
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = value;
        };
        const note = (path, oldV, newV, reason) => {
            if (!display) return;
            const r = reason ? ' (' + reason + ')' : '';
            display[path] = String(oldV) + '->' + String(newV) + r;
        };
        for (const cmd of cmds) {
            if (!cmd.path) continue;
            const parts = String(cmd.path).split('.').filter((p) => p !== '');
            if (cmd.type === 'delete') {
                let oldDel = null;
                let cur = stat, ok = true;
                for (let d = 0; d < parts.length - 1; d++) { cur = cur ? cur[parts[d]] : null; if (!cur) { ok = false; break; } }
                if (ok && cur) { oldDel = cur[parts[parts.length - 1]]; try { delete cur[parts[parts.length - 1]]; } catch (e) {} }
                if (Array.isArray(oldDel) && oldDel.length === 2) oldDel = oldDel[0];
                note(cmd.path, oldDel, '(移除)', cmd.reason);
                continue;
            }
            if (cmd.type === 'insert') {
                let container = stat, ok2 = true;
                for (let d2 = 0; d2 < parts.length - 1; d2++) { container = container ? container[parts[d2]] : null; if (!container) { ok2 = false; break; } }
                if (!ok2) continue;
                const key = cmd.keyOrIndex;
                if (key === '-' || key === null) {
                    if (Array.isArray(container)) container.push(cmd.value);
                    else if (container && typeof container === 'object') container[String(Date.now())] = cmd.value;
                } else if (Array.isArray(container) && /^\d+$/.test(String(key))) container.splice(Number(key), 0, cmd.value);
                else if (container && typeof container === 'object') container[key] = cmd.value;
                note(cmd.path, '(新增)', cmd.value, cmd.reason);
                continue;
            }
            if (cmd.type === 'assign' && cmd.keyOrIndex !== undefined) {
                let acont = stat, aok = true;
                for (let d5 = 0; d5 < parts.length - 1; d5++) { acont = acont ? acont[parts[d5]] : null; if (!acont) { aok = false; break; } }
                if (aok && acont && typeof acont === 'object') {
                    const akey = cmd.keyOrIndex;
                    if (akey === '-' && Array.isArray(acont)) acont.push(cmd.value);
                    else if (Array.isArray(acont) && /^\d+$/.test(String(akey))) acont.splice(Number(akey), 0, cmd.value);
                    else if (acont && typeof acont === 'object') acont[akey] = cmd.value;
                    note(cmd.path, '(变更)', cmd.value, cmd.reason);
                }
                continue;
            }
            if (cmd.type === 'assign' && cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value)) {
                let tgt = stat, ok3 = true;
                for (let d3 = 0; d3 < parts.length - 1; d3++) { tgt = tgt ? tgt[parts[d3]] : null; if (!tgt) { ok3 = false; break; } }
                if (ok3 && tgt && typeof tgt === 'object') { Object.keys(cmd.value).forEach((kk) => { tgt[kk] = cmd.value[kk]; }); note(cmd.path, '(变更)', cmd.value, cmd.reason); }
                continue;
            }
            if (cmd.type === 'add' && Array.isArray(cmd.value)) {
                let tgt2 = stat, ok4 = true;
                for (let d4 = 0; d4 < parts.length - 1; d4++) { tgt2 = tgt2 ? tgt2[parts[d4]] : null; if (!tgt2) { ok4 = false; break; } }
                if (ok4 && tgt2 && typeof tgt2 === 'object') {
                    const curV = tgt2[parts[parts.length - 1]];
                    const arr = Array.isArray(curV) ? curV.slice() : [];
                    cmd.value.forEach((vv) => arr.push(vv));
                    setPathArr(tgt2, parts, arr);
                    note(cmd.path, curV, arr, cmd.reason);
                }
                continue;
            }
            const oldV = (() => { let c = stat; for (const p of parts) { c = c ? c[p] : undefined; } return c; })();
            setPathArr(stat, parts, cmd.value);
            note(cmd.path, oldV, cmd.value, cmd.reason);
        }
    }

    let windowMvuShimTimer = null;
    let windowMvuFake = null;
    const originalMvuMap = new Map();
    // iframe/子窗口上我们同步的 getAllVariables 原值（恢复时还原，避免污染其他卡）
    const originalGetAllVariablesMap = new Map();
    function applyWindowMvuShim() {
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.writeStatDiffToDb !== 'function') return;
        // 只接管本转换器产物的卡（activeLayout 仅在转换卡上缓存）；
        // 其他卡（含真 MVU 卡）绝不覆盖 window.Mvu。避免依赖 currentCharacter()，
        // 否则角色懒加载缺 extensions 时会把转换卡误判为非转换卡而撤销接管。
        if (!activeLayout) {
            restoreWindowMvuShim();
            return;
        }
        if (!windowMvuFake) {
            windowMvuFake = {};
            windowMvuFake.events = {
                VARIABLE_INITIALIZED: 'mag_variable_initialized',
                VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
                COMMAND_PARSED: 'mag_command_parsed',
                VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
                BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
                SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
            };
            windowMvuFake.getMvuData = function () {
                // 有待写快照时直接返回，保证 写→读 一致（持久化由合并定时器落库）
                if (pendingStatWrite) {
                    return { stat_data: pendingStatWrite, display_data: {}, delta_data: {}, initialized_lorebooks: {} };
                }
                const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                return { stat_data: all.stat_data || {}, display_data: all.display_data || {}, delta_data: {}, initialized_lorebooks: {} };
            };
            windowMvuFake.getMvuVariable = function (mvu_data, path, opts) {
                try {
                    opts = opts || {};
                    const cat = opts.category || 'stat';
                    const data = cat === 'display' ? (mvu_data && mvu_data.display_data) : cat === 'delta' ? (mvu_data && mvu_data.delta_data) : (mvu_data && mvu_data.stat_data);
                    const parts = String(path || '').split('.').filter((p) => p !== '');
                    let cur = data;
                    for (const p of parts) { if (cur == null) break; cur = cur[p]; }
                    const v = cur === undefined ? opts.default_value : cur;
                    return (Array.isArray(v) && v.length === 2) ? v[0] : v;
                } catch (e) { return opts && opts.default_value !== undefined ? opts.default_value : undefined; }
            };
            windowMvuFake.getRecordFromMvuData = function (mvu_data, category) {
                if (!mvu_data) return undefined;
                if (category === 'display') return mvu_data.display_data;
                if (category === 'delta') return mvu_data.delta_data;
                return mvu_data.stat_data;
            };
            windowMvuFake.setMvuVariable = async function (mvu_data, path, new_value, opts) {
                try {
                    opts = opts || {};
                    if (!mvu_data || typeof mvu_data !== 'object') return false;
                    if (!mvu_data.stat_data || typeof mvu_data.stat_data !== 'object') mvu_data.stat_data = {};
                    const parts = String(path || '').split('.').filter((p) => p !== '');
                    if (!parts.length) return false;
                    let oldVal, has = false, cur = mvu_data.stat_data;
                    for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
                    if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) { oldVal = cur[parts[parts.length - 1]]; has = true; }
                    const reason = opts.reason || '';
                    const ds = has ? (String(oldVal) + '->' + String(new_value) + (reason ? ' (' + reason + ')' : '')) : ('(新增)' + String(new_value) + (reason ? ' (' + reason + ')' : ''));
                    cur[parts[parts.length - 1]] = new_value;
                    if (!mvu_data.display_data || typeof mvu_data.display_data !== 'object') mvu_data.display_data = {};
                    try { (() => { let dc = mvu_data.display_data; for (let i = 0; i < parts.length - 1; i++) { if (!dc[parts[i]] || typeof dc[parts[i]] !== 'object') dc[parts[i]] = {}; dc = dc[parts[i]]; } dc[parts[parts.length - 1]] = ds; })(); } catch (e) {}
                    if (mvu_data.delta_data && typeof mvu_data.delta_data === 'object') { try { (() => { let dc2 = mvu_data.delta_data; for (let i = 0; i < parts.length - 1; i++) { if (!dc2[parts[i]] || typeof dc2[parts[i]] !== 'object') dc2[parts[i]] = {}; dc2 = dc2[parts[i]]; } dc2[parts[parts.length - 1]] = ds; })(); } catch (e) {} }
                    console.log('[mvu2shujuku][debug] Mvu.setMvuVariable:', path, '=', String(new_value) + (reason ? ' (' + reason + ')' : ''));
                    return true;
                } catch (e) {
                    console.warn('[mvu2shujuku][debug] Mvu.setMvuVariable 异常:', e);
                    return false;
                }
            };
            windowMvuFake.replaceMvuData = async function (data) {
                try {
                    const api = getAcuApi();
                    if (!api || !activeLayout) {
                        console.warn('[mvu2shujuku][debug] Mvu.replaceMvuData 被跳过：api=' + !!api + ' activeLayout=' + (activeLayout ? '有' : '空') + '（自动建表尚未缓存布局，或当前卡不是转换产物）');
                        return false;
                    }
                    scheduleWindowStatOverlay((data && data.stat_data) || {});
                    return true;
                } catch (e) {
                    console.warn('[mvu2shujuku][debug] Mvu.replaceMvuData 异常:', e);
                    return false;
                }
            };
            windowMvuFake.parseMessage = async function (message, old_data) {
                try {
                    const out = JSON.parse(JSON.stringify(old_data || {}));
                    if (!out.stat_data || typeof out.stat_data !== 'object') out.stat_data = {};
                    if (!out.display_data || typeof out.display_data !== 'object') out.display_data = {};
                    const cmds = parseMvuCommands(String(message || ''));
                    if (!cmds.length) return undefined;
                    applyMvuCommands(out.stat_data, cmds, out.display_data);
                    return out;
                } catch (e) {
                    console.warn('[mvu2shujuku][debug] Mvu.parseMessage 异常:', e);
                    return undefined;
                }
            };
            windowMvuFake.reloadInitVar = async function () { return true; };
            windowMvuFake.getCurrentMvuData = function () { return windowMvuFake.getMvuData({ type: 'message', message_id: 'latest' }); };
            windowMvuFake.replaceCurrentMvuData = async function (mvu_data) { return windowMvuFake.replaceMvuData(mvu_data, { type: 'message', message_id: 'latest' }); };
            windowMvuFake.isDuringExtraAnalysis = function () { return false; };
        }
        const targets = [];
        const addTarget = (t) => { try { if (t && targets.indexOf(t) === -1) targets.push(t); } catch (e) {} };
        addTarget(window);
        addTarget(hostWindow);
        try { addTarget(window.parent); } catch (e) {}
        try { addTarget(window.top); } catch (e) {}
        for (const r of [window, hostWindow]) {
            try {
                const frames = r.document ? r.document.querySelectorAll('iframe') : [];
                for (const f of frames) { try { addTarget(f.contentWindow); } catch (e) {} }
            } catch (e) {}
        }
        for (const w of targets) {
            try {
                const oldM = w.Mvu;
                if (!originalMvuMap.has(w)) originalMvuMap.set(w, oldM);
                if (oldM && typeof oldM === 'object' && oldM !== windowMvuFake) {
                    const SKIP = { getMvuData: 1, replaceMvuData: 1, setMvuVariable: 1, getMvuVariable: 1, getRecordFromMvuData: 1, parseMessage: 1, reloadInitVar: 1, getCurrentMvuData: 1, replaceCurrentMvuData: 1, isDuringExtraAnalysis: 1, events: 1 };
                    for (const pk in oldM) {
                        if (!Object.prototype.hasOwnProperty.call(oldM, pk)) continue;
                        if (SKIP[pk]) continue;
                        if (windowMvuFake[pk] === undefined) windowMvuFake[pk] = oldM[pk];
                    }
                }
                w.Mvu = windowMvuFake;
                // 前端状态栏直接调 window.getAllVariables()：把扩展侧读取函数同步到
                // 消息 iframe/子窗口，否则 iframe 里没有该函数，前端永远读不到数据。
                if (typeof window.getAllVariables === 'function' && w.getAllVariables !== window.getAllVariables) {
                    if (!originalGetAllVariablesMap.has(w)) originalGetAllVariablesMap.set(w, w.getAllVariables);
                    w.getAllVariables = window.getAllVariables;
                }
                // 前端状态栏在消息 iframe 里用 eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...) 监听刷新。
                // 若 iframe 没有 TH 注入的 eventOn，就补一个绑定到 CustomEvent 的兜底，
                // 这样 emitMvuEvent 的 dispatchEvent 一定能触发前端刷新（不会因事件源不一致而收不到）。
                if (typeof w.addEventListener === 'function' && typeof w.eventOn !== 'function') {
                    w.eventOn = (evName, handler) => {
                        const wrapped = (e) => {
                            try {
                                const d = e && e.detail;
                                if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                                else handler(d);
                            } catch (err) {}
                        };
                        w.addEventListener(evName, wrapped);
                        return { stop: () => { try { w.removeEventListener(evName, wrapped); } catch (e2) {} } };
                    };
                    w.eventOff = (evName, handler) => { try { w.removeEventListener(evName, handler); } catch (e2) {} };
                }
            } catch (e) {}
        }
    }
    // 撤销 Mvu 接管：恢复各窗口原 window.Mvu，停止周期复查，切回转换卡时再接管。
    function restoreWindowMvuShim() {
        if (windowMvuShimTimer) {
            hostWindow.clearInterval(windowMvuShimTimer);
            windowMvuShimTimer = null;
        }
        for (const [w, orig] of originalMvuMap) {
            try { if (w.Mvu === windowMvuFake) w.Mvu = orig; } catch (e) {}
        }
        originalMvuMap.clear();
        for (const [w, orig] of originalGetAllVariablesMap) {
            try { if (w.getAllVariables === window.getAllVariables) w.getAllVariables = orig; } catch (e) {}
        }
        originalGetAllVariablesMap.clear();
    }
    function installWindowMvuShim() {
        applyWindowMvuShim();
        if (!windowMvuShimTimer) {
            // 真 MVU 可能异步 import 后重新挂载 window.Mvu；周期复查接管（2s），并监听其初始化事件立即接管
            windowMvuShimTimer = hostWindow.setInterval(() => { try { applyWindowMvuShim(); } catch (e) {} }, 2000);
            try { if (typeof hostWindow.eventOn === 'function') hostWindow.eventOn('global_Mvu_initialized', () => { try { applyWindowMvuShim(); } catch (e) {} }); } catch (e) {}
        }
        console.log('[mvu2shujuku][debug] 扩展侧已安装完整 Mvu shim（接管式）');
    }
    // 按当前卡同步运行时：转换卡 → 接管 Mvu/定义 getAllVariables/注册表格广播；
    // 其他卡 → 全部撤销，确保扩展不影响任何非转换卡。
    async function syncRuntimeForCurrentCard() {
        let ch = null;
        try { ch = currentCharacter(); } catch (e) {}
        if (!ch) return;
        // 角色对象带 extensions 且无标记 = 完整卡且非转换产物，直接撤销，不用发请求；
        // 缺 extensions（角色列表懒加载元数据）才强制取完整卡确认。
        const hasExt = !!(ch && ch.extensions && typeof ch.extensions === 'object');
        if (!isConvertedMvuCard(ch) && !hasExt) {
            try {
                // 强制取完整卡：角色列表对象可能只有元数据（缺 extensions），
                // 不能只凭当前对象判断是否本转换器产物。
                const full = await fetchFullCharacter(ch, true);
                if (full && isConvertedMvuCard(full)) ch = full;
                else if (full === null) {
                    // 获取完整卡失败（宿主扩展可能劫持了 fetch 返回 diff 对象）：
                    // 不能据此撤销运行时，保留现状等 autoInitDatabase 重试。
                    console.log('[mvu2shujuku][debug] 同步运行时：获取完整卡失败，暂不撤销（等自动建表重试）');
                    return;
                }
            } catch (e) {}
        }
        if (isConvertedMvuCard(ch)) {
            // 转换卡：什么都不做，布局缓存/接管由 autoInitDatabase 统一负责
            // （它每次都会用新卡 extensions.mvu2shujuku.layout 覆盖 activeLayout），
            // 避免这里清空与它竞争，把刚装好的接管撤销掉。
        } else {
            activeLayout = null;
            activePlaceholderNeeded = false;
            restoreWindowMvuShim();
            restoreWindowGetAllVariables();
        }
    }

    async function doConvert(inputBytes, sourceIsPng) {
        const settings = getSettings();
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.convert !== 'function') {
            throw new Error('转换核心未加载（MVU2SHUJUKU_CORE 不可用）');
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
        lastInput = inputBytes;
        if (inputBytes instanceof Uint8Array || inputBytes instanceof ArrayBuffer) {
            result.meta.avatarBytes = inputBytes;
            result.meta.avatarMime = sourceIsPng ? 'image/png' : 'application/json';
        }
        lastResult = result;
        renderResult(result);
        return result;
    }

    // 合并数据库插件现有模板：选择来源 → 列出表 → 勾选 → 并入转换结果
    let mergeSourceTimer = null;
    async function populateMergeSource(panel) {
        const sel = panel.querySelector('#mvu2shujuku-merge-source');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '';
        const opt = (v, label) => {
            const o = hostDocument.createElement('option');
            o.value = v;
            o.textContent = label;
            sel.appendChild(o);
        };
        opt('', '（选择模板来源）');
        opt('chat', '当前聊天模板');
        opt('global', '全局模板（当前选中）');
        opt('default', '默认模板（插件内置）');
        const api = getAcuApi();
        let presetCount = 0;
        let presetOk = false;
        if (api && typeof api.getTemplatePresetNames === 'function') {
            try {
                const names = api.getTemplatePresetNames() || [];
                for (const n of names) opt('preset:' + n, '预设：' + n);
                presetCount = names.length;
                presetOk = true;
            } catch (e) {
                console.warn('[mvu2shujuku][debug] getTemplatePresetNames 异常:', e);
            }
        }
        console.log(
            '[mvu2shujuku][debug] populateMergeSource: api=' + !!api +
            ' | 有 getTemplatePresetNames=' + !!(api && typeof api.getTemplatePresetNames === 'function') +
            ' | 预设数=' + presetCount + ' | 可读=' + presetOk
        );
        // 插件未就绪或预设尚未读到：持续重试（每 2.5 秒），直到成功读到一次预设列表
        if (!presetOk) {
            if (!mergeSourceTimer) {
                mergeSourceTimer = hostWindow.setTimeout(() => {
                    mergeSourceTimer = null;
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                }, 2500);
            }
        } else if (mergeSourceTimer) {
            hostWindow.clearTimeout(mergeSourceTimer);
            mergeSourceTimer = null;
        }
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    async function loadMergeTables(panel) {
        const sel = panel.querySelector('#mvu2shujuku-merge-source');
        const box = panel.querySelector('#mvu2shujuku-merge-tables');
        const status = panel.querySelector('#mvu2shujuku-merge-status');
        if (!sel || !box) return;
        // 每次点击都重新拉取来源列表（预设可能刚导入）
        await populateMergeSource(panel);
        const v = sel.value;
        if (!v) { toast('请先选择模板来源', 'error'); return; }
        const api = getAcuApi();
        console.log('[mvu2shujuku][debug] loadMergeTables: 来源=' + v + ' | api=' + !!api + ' | 有 getTableTemplate=' + !!(api && typeof api.getTableTemplate === 'function'));
        if (!api || typeof api.getTableTemplate !== 'function') {
            toast('未找到 SP·数据库 插件 API', 'error');
            return;
        }
        let scope = 'global';
        let presetName = '';
        if (v === 'chat') scope = 'chat';
        else if (v === 'global') scope = 'global';
        else if (v === 'default') scope = 'default';
        else if (v.indexOf('preset:') === 0) { scope = 'global'; presetName = v.slice(7); }
        let tpl = null;
        if (scope === 'default') {
            // 内置默认模板由插件服务器提供（插件自身也从该路径加载默认模板）
            try {
                const res = await fetch('/TavernDB_template_默认模板.json');
                if (res.ok) tpl = await res.json();
            } catch (e) { tpl = null; }
            if (!tpl || typeof tpl !== 'object') {
                try { tpl = api.getTableTemplate({ scope: 'global' }) || null; } catch (e2) { tpl = null; }
            }
        } else {
            try { tpl = api.getTableTemplate({ scope, presetName }) || null; } catch (e) { tpl = null; }
        }
        console.log('[mvu2shujuku][debug] loadMergeTables: scope=' + scope + ' | presetName=' + presetName + ' | 读到的模板=' + !!tpl + ' | sheet 数=' + (tpl ? Object.keys(tpl).filter(k => k.indexOf('sheet_') === 0).length : 0));
        if (!tpl || typeof tpl !== 'object') {
            toast('未读取到模板（该来源为空或插件未就绪）', 'error');
            return;
        }
        mergeState.sourceTemplate = tpl;
        const sheets = Object.keys(tpl).filter(k => k.startsWith('sheet_') && tpl[k] && typeof tpl[k] === 'object' && !Array.isArray(tpl[k]));
        console.log('[mvu2shujuku][debug] loadMergeTables: 有效表=' + sheets.length + ' | 表名=' + sheets.map(k => tpl[k].name).join('、'));
        if (!sheets.length) {
            box.innerHTML = '';
            toast('该模板没有表格', 'error');
            return;
        }
        const existing = new Set();
        if (lastResult && lastResult.template) {
            for (const k of Object.keys(lastResult.template).filter(k => k.startsWith('sheet_'))) {
                const s = lastResult.template[k];
                if (s && typeof s.name === 'string') existing.add(String(s.name).trim());
            }
        }
        box.innerHTML = '';
        for (const uid of sheets) {
            const s = tpl[uid];
            const dup = existing.has(String(s.name || '').trim());
            const label = hostDocument.createElement('label');
            label.style.display = 'block';
            const cb = hostDocument.createElement('input');
            cb.type = 'checkbox';
            cb.value = uid;
            cb.checked = false;
            label.appendChild(cb);
            label.appendChild(hostDocument.createTextNode(
                ' ' + (s.name || uid) +
                (dup ? '（已存在于转换结果，合并将跳过）' : '')
            ));
            if (dup) cb.disabled = true;
            box.appendChild(label);
        }
        const applyBtn = panel.querySelector('#mvu2shujuku-merge-apply');
        if (applyBtn) applyBtn.style.display = lastResult ? '' : 'none';
        if (status) status.textContent = '';
        toast('已列出 ' + sheets.length + ' 张表，勾选后点击「合并到转换结果」', 'info');
    }

    async function applyMergeTables(panel) {
        if (!lastResult || !lastInput) { toast('请先转换角色卡', 'error'); return; }
        if (!mergeState.sourceTemplate) { toast('请先加载模板来源', 'error'); return; }
        const box = panel.querySelector('#mvu2shujuku-merge-tables');
        const status = panel.querySelector('#mvu2shujuku-merge-status');
        const checked = box ? [...box.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value) : [];
        if (!checked.length) { toast('请至少勾选一张要并入的表', 'error'); return; }
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.mergeTemplates !== 'function' || typeof core.convert !== 'function') {
            toast('转换核心不可用', 'error');
            return;
        }
        const merged = core.mergeTemplates(lastResult.template, mergeState.sourceTemplate, checked);
        console.log('[mvu2shujuku][debug] applyMergeTables: 勾选=' + checked.join('、') + ' | 新增=' + merged.added.join('、') + ' | 跳过=' + merged.skipped.join('、') + ' | 合并后表数=' + Object.keys(merged.template).filter(k => k.startsWith('sheet_')).length);
        if (!merged.added.length) { toast('没有可并入的表（全部重名或无效）', 'error'); return; }
        const settings = getSettings();
        const mode = settings.mode === 'native' ? 'native' : settings.mode === 'sqlite' ? 'sqlite' : 'both';
        const opts = {
            mode,
            template: merged.template,
            asPng: settings.asPng === 'auto' ? (lastInput instanceof Uint8Array || lastInput instanceof ArrayBuffer) : settings.asPng === 'png',
            appendPlaceholder: settings.appendPlaceholder !== false,
        };
        if (settings.installMvuShim !== 'auto') opts.installMvuShim = settings.installMvuShim === 'yes';
        toast('正在合并并重新转换…');
        try {
            const result = core.convert(lastInput, opts);
            if (lastInput instanceof Uint8Array || lastInput instanceof ArrayBuffer) {
                result.meta.avatarBytes = lastInput;
                result.meta.avatarMime = lastInput instanceof Uint8Array && lastInput.length > 8 && lastInput[0] === 0x89 ? 'image/png' : 'application/json';
            }
            lastResult = result;
            renderResult(result);
            console.log('[mvu2shujuku][debug] applyMergeTables 重新转换完成: meta.tableCount=' + result.meta.tableCount + ' | tableNames=' + result.meta.tableNames.join('、'));
            const msg = '合并完成：新增 ' + merged.added.length + ' 张表' + (merged.skipped.length ? '，跳过重名：' + merged.skipped.join('、') : '');
            if (status) status.textContent = msg;
            toast(msg, 'info');
            // 刷新勾选列表：已并入的表标记为“已存在”
            try { await loadMergeTables(panel); } catch (e) {}
        } catch (e) {
            toast('合并失败：' + (e && e.message ? e.message : e), 'error');
        }
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
        const box = panel.querySelector('.mvu2shujuku-result');
        if (!box) return;
        box.innerHTML = '';
        const head = hostDocument.createElement('div');
        head.className = 'mvu2shujuku-row';
        head.innerHTML = '<b>转换完成</b>：' + result.meta.tableCount + ' 张表（' + result.meta.tableNames.join('、') + '）';
        box.appendChild(head);
        // 第一步：先看报告
        const report = hostDocument.createElement('textarea');
        report.className = 'mvu2shujuku-report';
        report.value = result.reportText;
        report.readOnly = true;
        box.appendChild(report);
        // 最后一步：下载与保存到酒馆（放在合并模板区块之后）
        const downloadsBox = panel.querySelector('#mvu2shujuku-downloads');
        if (downloadsBox) {
            downloadsBox.innerHTML = '';
            for (const f of result.files) {
                const btn = hostDocument.createElement('button');
                btn.className = 'menu_button';
                btn.textContent = '下载 ' + f.name;
                btn.addEventListener('click', () => download(f.name, f.mime, f.data));
                downloadsBox.appendChild(btn);
            }
        }
        const saveBtn = panel.querySelector('#mvu2shujuku-save-card');
        if (saveBtn) saveBtn.style.display = '';
        const mergeBtn = panel.querySelector('#mvu2shujuku-merge-apply');
        if (mergeBtn) mergeBtn.style.display = '';
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
            '    <div class="mvu2shujuku-card">',
            '      <div class="mvu2shujuku-row">',
            '        <span class="mvu2shujuku-label">输入来源（二选一）</span>',
            '        <label><input type="radio" name="mvu2shujuku-source" value="character" checked /> 酒馆角色卡</label>',
            '        <label><input type="radio" name="mvu2shujuku-source" value="file" /> 本地文件</label>',
            '      </div>',
            '      <div id="mvu2shujuku-char-area" class="mvu2shujuku-source-area">',
            '        <div class="mvu2shujuku-row">',
            '          <label class="mvu2shujuku-label" for="mvu2shujuku-char-select">选择角色卡</label>',
            '          <input id="mvu2shujuku-char-search" type="text" placeholder="搜索角色…" title="输入角色名过滤下拉列表" />',
            '          <select id="mvu2shujuku-char-select" title="从酒馆角色列表选择要转换的角色卡"></select>',
            '        </div>',
            '      </div>',
            '      <div id="mvu2shujuku-file-area" class="mvu2shujuku-source-area" style="display:none">',
            '        <div class="mvu2shujuku-row">',
            '          <label class="mvu2shujuku-label">选择本地文件</label>',
            '          <button id="mvu2shujuku-pick-file" class="menu_button" title="从磁盘选择 .json / .png 角色卡文件">选择文件…</button>',
            '          <input id="mvu2shujuku-file" type="file" accept=".json,.png,application/json,image/png" hidden />',
            '          <span id="mvu2shujuku-file-name" class="mvu2shujuku-hint"></span>',
            '        </div>',
            '      </div>',
            '      <div class="mvu2shujuku-row mvu2shujuku-mode-group">',
            '        <span class="mvu2shujuku-label" title="native：AI 输出 insertRow/updateRow/deleteRow DSL；sqlite：AI 输出 SQL；双模式跟随插件当前设置">填表模式</span>',
            '        <label><input type="radio" name="mvu2shujuku-mode" value="both" ' + (settings.mode === 'both' ? 'checked' : '') + ' /> 双模式（推荐）</label>',
            '        <label><input type="radio" name="mvu2shujuku-mode" value="native" ' + (settings.mode === 'native' ? 'checked' : '') + ' /> native（insertRow DSL）</label>',
            '        <label><input type="radio" name="mvu2shujuku-mode" value="sqlite" ' + (settings.mode === 'sqlite' ? 'checked' : '') + ' /> sqlite（SQL）</label>',
            '      </div>',
            '      <div class="mvu2shujuku-row">',
            '        <label class="mvu2shujuku-label" for="mvu2shujuku-shim">MVU 兼容层</label>',
            '        <select id="mvu2shujuku-shim">',
            '          <option value="auto" ' + (settings.installMvuShim === 'auto' ? 'selected' : '') + '>自动（检测到 MVU API 才装）</option>',
            '          <option value="yes" ' + (settings.installMvuShim === 'yes' ? 'selected' : '') + '>总是安装</option>',
            '          <option value="no" ' + (settings.installMvuShim === 'no' ? 'selected' : '') + '>不安装</option>',
            '        </select>',
            '      </div>',
            '      <div class="mvu2shujuku-help">',
            '        MVU（MagVarUpdate）是旧角色卡用的变量框架：游戏状态存在 <code>stat_data</code>，脚本/状态栏通过 MVU API 读写变量',
            '        （入口是全局对象 <code>Mvu</code>，方法 <code>getMvuData</code> / <code>replaceMvuData</code>）。',
            '        转换后数据桥会提供同名兼容对象，把旧脚本的 MVU API 调用自动翻译成数据库操作，旧脚本才能继续工作。',
            '        若卡片脚本没用到 MVU API，选“不安装”即可。',
            '      </div>',
            '      <div class="mvu2shujuku-row">',
            '        <label title="状态栏刷新由数据库表格更新回调驱动；此选项额外在 AI 回复结束时补一次刷新并处理消息里的 <UpdateVariable>/<json_patch> 更新块"><input type="checkbox" id="mvu2shujuku-placeholder" ' + (settings.appendPlaceholder !== false ? 'checked' : '') + ' /> 表格更新后自动刷新状态栏（含消息收尾兜底）</label>',
            '      </div>',
            '      <div class="mvu2shujuku-help">',
            '        状态栏刷新与 MVU 原版一致：数据库一有变动就广播 <code>mag_variable_update_ended</code>（VARIABLE_UPDATE_ENDED），前端原 eventOn 监听直接生效。',
            '        勾选上方选项后，还会在每次 AI 回复结束时补一次刷新，并顺带处理开场白/消息里的 <code>&lt;UpdateVariable&gt;</code> / <code>&lt;json_patch&gt;</code> 旧式更新块。',
            '      </div>',
            '      <div class="mvu2shujuku-row">',
            '        <label class="mvu2shujuku-label" for="mvu2shujuku-png">输出格式</label>',
            '        <select id="mvu2shujuku-png">',
            '          <option value="auto" ' + (settings.asPng === 'auto' ? 'selected' : '') + '>跟随输入（PNG 输入 → PNG 输出）</option>',
            '          <option value="json" ' + (settings.asPng === 'json' ? 'selected' : '') + '>总是 JSON</option>',
            '          <option value="png" ' + (settings.asPng === 'png' ? 'selected' : '') + '>总是 PNG</option>',
            '        </select>',
            '      </div>',
            '      <div class="mvu2shujuku-row">',
            '        <button id="mvu2shujuku-convert-current" class="menu_button">转换所选角色卡</button>',
            '        <button id="mvu2shujuku-convert-file" class="menu_button" disabled title="从磁盘选择 .json / .png 角色卡文件">转换所选文件</button>',
            '        <button id="mvu2shujuku-clear" class="menu_button">清空结果</button>',
            '      </div>',
            '      <div class="mvu2shujuku-result"></div>',
            '      <div class="mvu2shujuku-row">',
            '        <label class="mvu2shujuku-label" for="mvu2shujuku-merge-source">合并数据库现有表格模板（转换完成后可用）</label>',
            '        <select id="mvu2shujuku-merge-source" title="选择模板来源：当前聊天模板 / 全局模板 / 全局预设"></select>',
            '        <button id="mvu2shujuku-merge-load" class="menu_button">加载表列表</button>',
            '      </div>',
            '      <div id="mvu2shujuku-merge-tables" class="mvu2shujuku-hint">选择来源后点「加载表列表」，勾选要并入转换结果（角色卡模板）的表；重名表会自动跳过。</div>',
            '      <div class="mvu2shujuku-row">',
            '        <button id="mvu2shujuku-merge-apply" class="menu_button" style="display:none">合并到转换结果</button>',
            '        <span id="mvu2shujuku-merge-status" class="mvu2shujuku-hint"></span>',
            '      </div>',
            '      <div id="mvu2shujuku-actions" class="mvu2shujuku-row">',
            '        <div id="mvu2shujuku-downloads" class="mvu2shujuku-downloads mvu2shujuku-row"></div>',
            '        <button id="mvu2shujuku-save-card" class="menu_button" style="display:none" title="转换完成后出现：把角色卡保存进 sillytavern 角色列表，并顺带把表格模板存为插件预设">保存角色卡和模板到sillytavern</button>',
            '      </div>',
            '      <div class="mvu2shujuku-hint">',
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
        populateMergeSource(panel);
        const searchBox = panel.querySelector('#mvu2shujuku-char-search');
        if (searchBox && searchBox.dataset.bound !== 'true') {
            searchBox.dataset.bound = 'true';
            searchBox.addEventListener('input', () => populateCharacterSelect(panel, context));
        }
        // 输入来源二选一：切换时只显示对应来源区域，并启用对应的转换按钮
        const applySource = (value) => {
            const isChar = value === 'character';
            const charArea = panel.querySelector('#mvu2shujuku-char-area');
            const fileArea = panel.querySelector('#mvu2shujuku-file-area');
            const btnCurrent = panel.querySelector('#mvu2shujuku-convert-current');
            const btnFile = panel.querySelector('#mvu2shujuku-convert-file');
            if (charArea) charArea.style.display = isChar ? '' : 'none';
            if (fileArea) fileArea.style.display = isChar ? 'none' : '';
            // 二选一：只显示当前来源对应的转换按钮
            if (btnCurrent) { btnCurrent.style.display = isChar ? '' : 'none'; btnCurrent.disabled = !isChar; }
            if (btnFile) { btnFile.style.display = isChar ? 'none' : ''; btnFile.disabled = isChar; }
        };
        const sourceRadios = panel.querySelectorAll('input[name="mvu2shujuku-source"]');
        sourceRadios.forEach((radio) => {
            if (radio.dataset.bound !== 'true') {
                radio.dataset.bound = 'true';
                radio.addEventListener('change', () => { if (radio.checked) applySource(radio.value); });
            }
        });
        const checkedSource = panel.querySelector('input[name="mvu2shujuku-source"]:checked');
        applySource(checkedSource ? checkedSource.value : 'character');
        bind('#mvu2shujuku-convert-current', async () => {
            const ch = selectedCharacter(panel);
            if (!ch) { toast('请先在角色卡下拉栏中选择角色', 'error'); return; }
            toast('正在转换…');
            try {
                const full = await fetchFullCharacter(ch);
                if (!full) {
                    toast('获取角色卡完整数据失败（接口可能被其他扩展改写），请重试', 'error');
                    return;
                }
                console.log('[mvu2shujuku] 待转换对象：name=', full && full.name, '| keys=', Object.keys(full || {}).join(','), '| character_book.entries=', full && full.character_book ? full.character_book.entries.length : 'N/A');
                await doConvert(full, false);
            } catch (e) {
                toast('转换失败：' + (e && e.message ? e.message : e), 'error');
            }
        });
        bind('#mvu2shujuku-pick-file', () => {
            const input = panel.querySelector('#mvu2shujuku-file');
            if (input) input.click();
        });
        const fileInput = panel.querySelector('#mvu2shujuku-file');
        if (fileInput && fileInput.dataset.bound !== 'true') {
            fileInput.dataset.bound = 'true';
            fileInput.addEventListener('change', () => {
                const nameEl = panel.querySelector('#mvu2shujuku-file-name');
                if (nameEl) nameEl.textContent = fileInput.files && fileInput.files.length ? '已选择：' + fileInput.files[0].name : '';
            });
        }
        bind('#mvu2shujuku-convert-file', async () => {
            const input = panel.querySelector('#mvu2shujuku-file');
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
        bind('#mvu2shujuku-clear', () => {
            lastResult = null;
            const box = panel.querySelector('.mvu2shujuku-result');
            if (box) box.innerHTML = '';
            const saveBtn = panel.querySelector('#mvu2shujuku-save-card');
            if (saveBtn) saveBtn.style.display = 'none';
            const downloadsBox = panel.querySelector('#mvu2shujuku-downloads');
            if (downloadsBox) downloadsBox.innerHTML = '';
            mergeState.sourceTemplate = null;
            const tablesBox = panel.querySelector('#mvu2shujuku-merge-tables');
            if (tablesBox) tablesBox.innerHTML = '选择来源后点「加载表列表」，勾选要并入转换结果（角色卡模板）的表；重名表会自动跳过。';
            const applyBtn = panel.querySelector('#mvu2shujuku-merge-apply');
            if (applyBtn) applyBtn.style.display = 'none';
            const statusEl = panel.querySelector('#mvu2shujuku-merge-status');
            if (statusEl) statusEl.textContent = '';
        });
        bind('#mvu2shujuku-merge-load', () => loadMergeTables(panel));
        bind('#mvu2shujuku-merge-apply', () => applyMergeTables(panel));
        bind('#mvu2shujuku-save-card', async () => {
            await saveCardToSillyTavern();
        });
        const modeInputs = panel.querySelectorAll('input[name="mvu2shujuku-mode"]');
        modeInputs.forEach((el) => {
            if (el.dataset.bound !== 'true') {
                el.dataset.bound = 'true';
                el.addEventListener('change', () => {
                    getSettings().mode = panel.querySelector('input[name="mvu2shujuku-mode"]:checked').value;
                    saveSettings();
                });
            }
        });
        const shimSel = panel.querySelector('#mvu2shujuku-shim');
        if (shimSel && shimSel.dataset.bound !== 'true') {
            shimSel.dataset.bound = 'true';
            shimSel.addEventListener('change', () => {
                getSettings().installMvuShim = shimSel.value;
                saveSettings();
            });
        }
        const ph = panel.querySelector('#mvu2shujuku-placeholder');
        if (ph && ph.dataset.bound !== 'true') {
            ph.dataset.bound = 'true';
            ph.addEventListener('change', () => {
                getSettings().appendPlaceholder = ph.checked;
                saveSettings();
            });
        }
        const pngSel = panel.querySelector('#mvu2shujuku-png');
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

    // 调试钩子：确认 st-prompt-template 每次构建的 EJS 上下文是否包含我们的函数
    let defineTimer = null;
    function ensureTemplateDefine() {
        try {
            const ejs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
            if (ejs && ejs.defines && typeof ejs.defines === 'object') {
                if (typeof ejs.defines.mvu2shujukuGetAllVariables !== 'function') {
                    ejs.defines.mvu2shujukuGetAllVariables = function () {
                        try { return window.getAllVariables ? window.getAllVariables() : { stat_data: {} }; } catch (e) { return { stat_data: {} }; }
                    };
                    console.log('[mvu2shujuku][debug] 扩展侧注册 mvu2shujukuGetAllVariables 完成');
                }
                defineTimer = null;
            } else if (!defineTimer) {
                defineTimer = hostWindow.setTimeout(() => { defineTimer = null; ensureTemplateDefine(); }, 2000);
            }
        } catch (e) {
            console.warn('[mvu2shujuku][debug] 扩展侧注册异常:', e);
        }
    }
    function bindDebugHooks(context) {
        const es = context && (context.eventSource || context.event_source);
        if (!es || typeof es.on !== 'function') return;
        try {
            // 只在首次 prepare 时打一行确认，避免每次生成都刷屏
            let firstPreparedLogged = false;
            es.on('prompt_template_prepare', (prepared) => {
                if (firstPreparedLogged) return;
                firstPreparedLogged = true;
                const pageEjs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
                console.log(
                    '[mvu2shujuku][debug] prompt_template_prepare 首次上下文: 键数=' + (prepared ? Object.keys(prepared).length : 0) +
                    ' | getvar=' + typeof (prepared && prepared.getvar) +
                    ' | mvu2shujukuGetAllVariables=' + typeof (prepared && prepared.mvu2shujukuGetAllVariables) +
                    ' | getAllVariables=' + typeof (prepared && prepared.getAllVariables) +
                    ' | 页面EjsTemplate=' + !!pageEjs +
                    ' | 页面defines注册函数=' + typeof (pageEjs && pageEjs.defines && pageEjs.defines.mvu2shujukuGetAllVariables)
                );
            });
            console.log('[mvu2shujuku][debug] 已监听 prompt_template_prepare 事件（仅首次打印上下文）');
        } catch (e) {
            console.warn('[mvu2shujuku][debug] 监听 prompt_template_prepare 失败:', e);
        }
    }

    function main() {
        const context = getContextSafe();
        installEarlyEventOnFallback();
        ensureSettingsPanel(context);
        bindDebugHooks(context);
        ensureTemplateDefine();
        // 卡内桥在 TH 沙箱中可能被隔离，运行时由扩展兜底（仅对本转换器产物生效）：
        // - 建表：只在当前聊天缺表时 initGameSession（每聊天 done 去重一次，绝不重建/重置已有表格）；
        // - Mvu 兼容：把前端 MVU API 调用翻译成数据库操作；
        // - 占位符：消息收尾补 <StatusPlaceHolderImpl/> 供前端正则注入。
        // 不做锚点重建、不做切聊天时的表管理；Mvu 接管/getAllVariables/表格广播都只对带
        // extensions.mvu2shujuku 独有标记的卡生效，切到其他卡时全部撤销。
        syncRuntimeForCurrentCard();
        bindAutoInit(context);
        hostWindow.setTimeout(autoInitDatabase, 1500);
        const ejs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
        console.log(
            '[mvu2shujuku][debug] 加载时 EjsTemplate=' + !!ejs +
            ' | defines=' + !!(ejs && ejs.defines) +
            ' | 已注册 mvu2shujukuGetAllVariables=' + typeof (ejs && ejs.defines && ejs.defines.mvu2shujukuGetAllVariables)
        );
        console.log('[mvu2shujuku] 扩展已加载（' + (window.MVU2SHUJUKU_CORE ? window.MVU2SHUJUKU_CORE.VERSION : '核心缺失') +
            ' | 预写锚点=' + (typeof ensureCheckpointBeforeWrite === 'function' ? '已启用' : '缺失') +
            ' | 校验锚点=' + (typeof hasFullShujukuCheckpoint === 'function' ? '已启用' : '缺失') + '）');
    }

    try {
        main();
    } catch (error) {
        console.error('[mvu2shujuku] 初始化失败:', error);
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
     * opts: { coreSource: mvu2shujuku.js 源码字符串（用于内联） }
     */
    function assembleExtension(opts = {}) {
        const coreSource = opts.coreSource || '';
        const pinyinInline = opts.pinyinInline || '';
        const indexJs = [
            '// MVU转数据库 · SillyTavern 原生扩展',
            '// 生成自 转换器/src/mvu2shujuku.js（' + VERSION + '），核心源码内联如下',
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
                '- 状态栏/世界书 EJS 通过 getAllVariables() 读取 stat_data；扩展与卡内数据桥都会把数据库表格重建为 stat_data 形状。',
                '- 卡内 MVU 相关正则/脚本/更新规则会被移除；依赖 MVU API 的脚本通过 MVU 兼容层尽力适配。',
            ].join('\n'),
        };
    }


    root.MVU2SHUJUKU_CORE = {
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
        mergeTemplates,
        generateBridgeScript,
        statDataFromTables,
        writeStatDiffToDb,
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
        module.exports = root.MVU2SHUJUKU_CORE;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// MVU转数据库 · SillyTavern 原生扩展
// 生成自 转换器/src/mvu2shujuku.js（0.1.0），核心源码内联如下
// @ts-nocheck
(function (root) {
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
        'async function mvu2shujukuEnsureInit(api,b64,presetName,to){var out={status:"skip",message:"",missing:[]};var t1=(to&&to.importMs)||15000;var t2=(to&&to.initMs)||20000;var tpl=null;try{tpl=JSON.parse(mvu2shujukuDecodeB64(b64));}catch(e){out.status="error";out.message="模板解码失败: "+(e&&e.message?e.message:e);return out;}var names=mvu2shujukuExpectedTableNames(tpl);if(!names.length){out.status="error";out.message="模板中没有 sheet_* 表";return out;}out.missing=mvu2shujukuMissingTableNames(api,names);var colMiss=[];var needsImport=out.missing.length>0;if(!needsImport){colMiss=mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));needsImport=colMiss.length>0;}if(!needsImport){var emptyS=[];try{var all2=api.exportTableAsJson()||{};for(var k2 in all2){if(k2.indexOf("sheet_")!==0)continue;var sh2=all2[k2];if(!sh2||typeof sh2!=="object"||typeof sh2.name!=="string")continue;if(Array.isArray(sh2.content)&&sh2.content.length>1)continue;if(Array.isArray(sh2.seedRows)&&sh2.seedRows.length)continue;var ts=mvu2shujukuSheetByName(tpl,sh2.name);if(!ts||!Array.isArray(ts.content)||ts.content.length!==2)continue;emptyS.push(sh2.name);}}catch(e){}if(emptyS.length){for(var ei=0;ei<emptyS.length;ei++){try{var ts2=mvu2shujukuSheetByName(tpl,emptyS[ei]);var hdr2=ts2.content[0];var row2=ts2.content[1];var obj2={};for(var ci=1;ci<hdr2.length;ci++){obj2[hdr2[ci]]=(row2[ci]!==undefined&&row2[ci]!==null)?row2[ci]:"";}await Promise.resolve(api.insertRow(emptyS[ei],obj2));}catch(e){}}out.status="skip";out.message="已为仅表头的单例/JSON表补初始行："+emptyS.join("、");return out;}out.status="skip";out.message="已有全部表格且结构匹配，跳过开局建表";return out;}var steps=[];if(typeof api.importTemplateFromData==="function"){try{var r1=await mvu2shujukuWithTimeout(api.importTemplateFromData(tpl,{scope:"chat",presetName:presetName||""}),t1,"importTemplateFromData");steps.push(r1&&r1.timeout?r1.message:(r1&&r1.success===false?("importTemplateFromData: "+(r1.message||"失败")):"importTemplateFromData: 完成"));}catch(e){steps.push("importTemplateFromData异常: "+(e&&e.message?e.message:e));}}if(typeof api.initGameSession==="function"&&!mvu2shujukuInitSessionHung){try{var r2=await mvu2shujukuWithTimeout(api.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:presetName||""}),t2,"initGameSession");if(r2&&r2.timeout){mvu2shujukuInitSessionHung=true;steps.push("initGameSession: 超时，已跳过后续重试（表已由 importTemplateFromData 创建则无碍）");}else if(r2&&r2.success===false)steps.push("initGameSession: "+(r2.message||"失败"));else steps.push("initGameSession: 完成"+(r2&&r2.runtimeReady===false?"（运行时未就绪）":""));}catch(e){steps.push("initGameSession异常: "+(e&&e.message?e.message:e));}}else if(typeof api.initGameSession!=="function"){steps.push("initGameSession: 不可用（仅 importTemplateFromData）");}out.missing=mvu2shujukuMissingTableNames(api,names);colMiss=out.missing.length?[]:mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));out.status=(out.missing.length||colMiss.length)?"partial":"ok";out.message=steps.join("；")+"；剩余缺表："+(out.missing.length?out.missing.join("、"):"无")+(colMiss.length?"；结构不匹配："+colMiss.join("、"):"");return out;}',
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
                seedNeeded[op.entry.layout.table] = op.entry;
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
                rowIndex = 1;
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
                        try { await Promise.resolve(api.deleteRow(L.table, rr - 1)); } catch (e) {}
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
            `      // 写库前确保 full checkpoint 存在：无锚点且表仍为模板初始状态时先重建，`,
            `      // 避免写入产生无锚点 artifacts 触发插件 V2 boundary_after_data_mismatch`,
            `      try{`,
            `        var tplCached2=null;`,
            `        try{tplCached2=JSON.parse(mvu2shujukuDecodeB64(TEMPLATE_B64));}catch(e){tplCached2=null;}`,
            `        if(tplCached2&&!hasFullCheckpoint()&&!mvu2shujukuInitSessionHung){`,
            `          var anchoredOK=false;`,
            `          if(mvu2shujukuTablesSafeToAnchor(API,tplCached2)&&typeof API.initGameSession==='function'){`,
            `            console.log('['+BRIDGE_NAME+'] 写库前：聊天缺少 full checkpoint，重建锚点…');`,
            `            var ra=await mvu2shujukuWithTimeout(API.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tplCached2,templatePresetName:currentCharName()+'模板'}),20000,'initGameSession(写前锚点)');`,
            `            console.log('['+BRIDGE_NAME+'] 写库前锚点重建：'+(ra&&ra.success===false?(ra.message||'失败'):(ra&&ra.timeout?'超时':'完成'))+' | 锚点='+hasFullCheckpoint());`,
            `            anchoredOK=!(ra&&ra.success===false)&&!(ra&&ra.timeout)&&hasFullCheckpoint();`,
            `          }else if(bridgeIsOpeningPhase()&&!mvu2shujukuHasExtraRows(API,tplCached2)&&typeof API.initGameSession==='function'){`,
            `            // 表无额外行（仅模板行被改动，如开局捏人写入）：重置+重放本次写入无损`,
            `            console.log('['+BRIDGE_NAME+'] 写库前：表无额外行，重置重建锚点并重放本次写入…');`,
            `            try{`,
            `              var r2b=await mvu2shujukuWithTimeout(API.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tplCached2,templatePresetName:currentCharName()+'模板'}),20000,'initGameSession(无额外行锚点)');`,
            `              console.log('['+BRIDGE_NAME+'] 无额外行重建：'+(r2b&&r2b.success===false?(r2b.message||'失败'):(r2b&&r2b.timeout?'超时':'完成'))+' | 锚点='+hasFullCheckpoint());`,
            `              anchoredOK=!(r2b&&r2b.success===false)&&!(r2b&&r2b.timeout)&&hasFullCheckpoint();`,
            `            }catch(e){console.warn('['+BRIDGE_NAME+'] 无额外行重建异常:',e);}`,
            `          }else if(typeof API.importTableAsJson==='function'){`,
            `            // 表含用户数据但无锚点：把当前状态提交为 checkpoint，不丢数据`,
            `            console.log('['+BRIDGE_NAME+'] 写库前：表含数据且无锚点，用 importTableAsJson 锚定当前状态…');`,
            `            try{`,
            `              var snap1=JSON.stringify(API.exportTableAsJson()||{});`,
            `              var ok1=await Promise.resolve(API.importTableAsJson(snap1,{}));`,
            `              console.log('['+BRIDGE_NAME+'] importTableAsJson 锚定='+(ok1?'成功':'失败'));`,
            `              anchoredOK=!!ok1;`,
            `            }catch(e){console.warn('['+BRIDGE_NAME+'] importTableAsJson 锚定异常:',e);}`,
            `          }`,
            `          if(!anchoredOK&&!hasFullCheckpoint()&&typeof API.importTableAsJson==='function'&&!mvu2shujukuInitSessionHung){`,
            `            // initGameSession 可能“完成”却不建 checkpoint：再强制 importTableAsJson 建锚`,
            `            console.log('['+BRIDGE_NAME+'] 写库前：仍未建立锚点，用 importTableAsJson 强制锚定…');`,
            `            try{`,
            `              var snap2=JSON.stringify(API.exportTableAsJson()||{});`,
            `              var ok2b=await Promise.resolve(API.importTableAsJson(snap2,{}));`,
            `              console.log('['+BRIDGE_NAME+'] importTableAsJson 强制锚定='+(ok2b?'成功':'失败')+' | 锚点='+hasFullCheckpoint());`,
            `              anchoredOK=!!ok2b&&hasFullCheckpoint();`,
            `            }catch(e){console.warn('['+BRIDGE_NAME+'] importTableAsJson 强制锚定异常:',e);}`,
            `          }`,
            `          if(!anchoredOK&&!hasFullCheckpoint()){`,
            `            // 表含真实数据且插件拒绝锚定：放弃本次写入，绝不重置已有数据`,
            `            console.warn('['+BRIDGE_NAME+'] 写库前：表含数据且无法建立锚点，放弃本次写入（避免无锚点 artifacts 与数据重置）。');`,
            `            if(statOverlayGen===gen)pendingStatOverlay=null;`,
            `            return;`,
            `          }`,
            `        }`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] 写库前锚点重建异常:',e);}`,
            `      var prev=currentStat();`,
            `      await writeDiffToDb(prev,target);`,
            `      try{if(!hasFullCheckpoint())console.warn('['+BRIDGE_NAME+'] 写库完成后聊天仍无 full checkpoint！后续插件自动填表提交可能出现 V2 mismatch。');}catch(e){}`,
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
            `      for(var rr=sheet.content.length-1;rr>=1;rr--){try{await Promise.resolve(API.deleteRow(L.table,rr-1));}catch(e){}}`,
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
            `  // 锚点检查：开场白切换会丢 full checkpoint，导致写库产生无锚点 artifacts，`,
            `  // 触发插件 V2 boundary_after_data_mismatch；表已存在且缺锚点时重建一次（最多 3 次）`,
            `  if(anchorChat!==key){anchorChat=key;anchorTries=0;}`,
            `  if(!mvu2shujukuInitSessionHung&&anchorTries<3){`,
            `    try{`,
            `      var tpl=parseTemplate();`,
            `      if(tpl&&!hasFullCheckpoint()){`,
            `        var miss=mvu2shujukuMissingTableNames(API,mvu2shujukuExpectedTableNames(tpl));`,
            `        if(miss.length===0&&mvu2shujukuTablesSafeToAnchor(API,tpl)&&typeof API.initGameSession==='function'){`,
            `          anchorTries++;`,
            `          console.log('['+BRIDGE_NAME+'] 聊天缺少 full checkpoint，重建数据库锚点…');`,
            `          var r3=await mvu2shujukuWithTimeout(API.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:currentCharName()+'模板'}),20000,'initGameSession(锚点)');`,
            `          console.log('['+BRIDGE_NAME+'] 数据库锚点重建：'+(r3&&r3.success===false?(r3.message||'失败'):(r3&&r3.timeout?'超时':'完成')));`,
            `        }else if(miss.length===0&&typeof API.importTableAsJson==='function'){`,
            `          // 表含用户数据但无锚点：把当前状态提交为 checkpoint，不丢数据`,
            `          anchorTries++;`,
            `          console.log('['+BRIDGE_NAME+'] 表含数据且无锚点，用 importTableAsJson 锚定当前状态…');`,
            `          try{`,
            `            var snap0=JSON.stringify(API.exportTableAsJson()||{});`,
            `            var ok2=await Promise.resolve(API.importTableAsJson(snap0,{}));`,
            `            console.log('['+BRIDGE_NAME+'] importTableAsJson 锚定='+(ok2?'成功':'失败'));`,
            `          }catch(e){console.warn('['+BRIDGE_NAME+'] importTableAsJson 锚定异常:',e);}`,
            `        }`,
            `      }`,
            `    }catch(e){anchorTries++;console.warn('['+BRIDGE_NAME+'] 数据库锚点重建异常:',e);}`,
            `  }`,
            `  if(initState.done&&initState.key===key)return;`,
            `  if(initState.running)return;`,
            `  initState.running=true;`,
            `  initState.key=key;`,
            `  try{`,
            `    var out=await mvu2shujukuEnsureInit(API,TEMPLATE_B64,currentCharName()+'模板');`,
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
                keptRegexes.push(copy);
                continue;
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
        // 仅开局阶段允许重置重建：表数据只是模板行被改动（没有额外新增行，例如开局捏人写入），
        // 重置+重放本次写入是无损的（前端 replaceMvuData 带完整快照）；进入正常对话后绝不重置。
        if (isOpeningPhase() && !mvu2shujukuHasExtraRows(api, tplCached) && !mvu2shujukuInitSessionHung && typeof api.initGameSession === 'function') {
            console.log('[mvu2shujuku][debug][锚点] ' + reason + '：表无额外行（仅模板行被改动），重置重建锚点并重放本次写入…');
            try {
                const r2 = await mvu2shujukuWithTimeout(
                    api.initGameSession({}, { injectTemplate: true, loadPreset: false, templateData: tplCached, templatePresetName: String((currentCharacter() && currentCharacter().name) || '') + '模板' }),
                    20000,
                    'initGameSession(无额外行锚点)'
                );
                const ok2 = !(r2 && r2.success === false) && !(r2 && r2.timeout);
                console.log('[mvu2shujuku][debug][锚点] ' + reason + '：无额外行重建=' + (r2 && r2.timeout ? '超时' : (r2 && r2.success === false ? (r2.message || '失败') : '完成')) + ' | 锚点=' + hasFullShujukuCheckpoint());
                return ok2 && hasFullShujukuCheckpoint();
            } catch (e) {
                console.warn('[mvu2shujuku][debug][锚点] ' + reason + '：无额外行重建异常:', e);
                return false;
            }
        }
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
        if (hasFullShujukuCheckpoint()) return true;
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

    function autoInitChatId() {
        try {
            const context = getContextSafe();
            return String(context.chatId || context.chat_id || context.chatFile || context.chatFileName || 'unknown');
        } catch (e) { return 'unknown'; }
    }

    // 对应 MVU 的 init 时机：进入聊天/收到首条消息时，若卡内有模板且表格缺失则自动建表。
    // 只处理本转换器产出的卡（世界书含 __ACU_TEMPLATE_DATA__），其余卡一律不动。
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
        // 锚点检查：表可能已存在但聊天缺 full checkpoint（开场白切换/首楼
        // 重写会丢锚点），此时继续写库会留下无锚点 artifacts，触发插件 V2 boundary_after_data_mismatch；
        // 用卡内模板重建 initGameSession 把锚点补上（全新聊天由下方 ensureInit 建立，不重复）；
        // 每次进入聊天都会复查，最多重试 3 次，避免 initGameSession 挂起时风暴。
        if (autoInitState.anchorChat !== key) {
            autoInitState.anchorChat = key;
            autoInitState.anchorTries = 0;
        }
        if (autoInitState.anchorTries < 3) {
            try {
                const tplCached = cachedTemplateForCurrentCard();
                const hadCheckpoint = hasFullShujukuCheckpoint();
                console.log('[mvu2shujuku][debug][流程] 开局锚点检查：chat=' + key + ' hasCheckpoint=' + hadCheckpoint + ' tries=' + autoInitState.anchorTries + ' hung=' + mvu2shujukuInitSessionHung);
                if (tplCached && !hadCheckpoint) {
                    autoInitState.anchorTries += 1;
                    await anchorCheckpointIfMissing(api, tplCached, '开局');
                }
            } catch (e) {
                autoInitState.anchorTries += 1;
                console.warn('[mvu2shujuku][debug] 数据库锚点重建异常:', e);
            }
        }
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
                    activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
                    hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                });
                es.on(et.MESSAGE_RECEIVED, () => {
                    hostWindow.setTimeout(autoInitDatabase, 600);
                    // 复刻 MVU：AI 回复后追加状态栏占位符，前端注入正则才能命中每条消息
                    ensureWindowStatusPlaceholder();
                });
                // 开场白切换/首楼换 swipe 会丢掉插件的 full checkpoint：必须立即重建锚点，
                // 否则捏人 UI 的写库会产生无锚点 artifacts，触发插件 V2 boundary_after_data_mismatch。
                // CHAT_CHANGED 只在换聊天时触发，swipe 切换不会触发，所以要单独监听。
                for (const evName of [et.MESSAGE_SWIPED, et.MESSAGE_UPDATED, et.MESSAGE_EDITED]) {
                    if (evName && typeof evName === 'string') {
                        es.on(evName, () => hostWindow.setTimeout(autoInitDatabase, 300));
                    }
                }
                if (et.GENERATION_ENDED) {
                    es.on(et.GENERATION_ENDED, () => {
                        ensureWindowStatusPlaceholder();
                        hostWindow.setTimeout(autoInitDatabase, 100);
                    });
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
        if (cb && Array.isArray(cb.entries) && cb.entries.length) return character;
        console.log('[mvu2shujuku] 角色列表对象缺世界书，尝试 /api/characters/get 取完整卡。avatar=', character.avatar, 'name=', character && character.name);
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
                    const n = await window.MVU2SHUJUKU_CORE.writeStatDiffToDb(api, activeLayout, prev, target);
                    if (n > 0) console.log('[mvu2shujuku][debug] Mvu 合并写入完成：差异 ' + n + ' 条');
                    if (!hasFullShujukuCheckpoint()) {
                        console.warn('[mvu2shujuku][debug][流程] 写库完成后聊天仍无 full checkpoint！若插件随后自动填表提交，可能出现 V2 boundary_after_data_mismatch。');
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

    // 扩展侧提供 window.getAllVariables：用卡内布局 + 插件表格实时重建 stat_data（惰性，零冗余）
    function installWindowGetAllVariables() {
        const core = window.MVU2SHUJUKU_CORE;
        if (typeof window.getAllVariables === 'function') return;
        if (!core || typeof core.statDataFromTables !== 'function') return;
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
        console.log('[mvu2shujuku][debug] 扩展侧已定义 window.getAllVariables（读插件表格重建 stat_data）');
    }

    // 表格更新广播：与 MVU 原版一致，数据库一有变动就广播 VARIABLE_UPDATE_ENDED，
    // 携带更新后的完整变量（before 在无基线时传空，前端结算逻辑会安全跳过）
    function dispatchVariableUpdateEnded(after, before) {
        try {
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
    function applyWindowMvuShim() {
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.writeStatDiffToDb !== 'function') return;
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
                if (oldM && typeof oldM === 'object' && oldM !== windowMvuFake) {
                    const SKIP = { getMvuData: 1, replaceMvuData: 1, setMvuVariable: 1, getMvuVariable: 1, getRecordFromMvuData: 1, parseMessage: 1, reloadInitVar: 1, getCurrentMvuData: 1, replaceCurrentMvuData: 1, isDuringExtraAnalysis: 1, events: 1 };
                    for (const pk in oldM) {
                        if (!Object.prototype.hasOwnProperty.call(oldM, pk)) continue;
                        if (SKIP[pk]) continue;
                        if (windowMvuFake[pk] === undefined) windowMvuFake[pk] = oldM[pk];
                    }
                }
                w.Mvu = windowMvuFake;
            } catch (e) {}
        }
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
            '        <button id="mvu2shujuku-convert-file" class="menu_button" disabled title="先在上方选择“本地文件”来源">转换所选文件</button>',
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
            if (btnCurrent) btnCurrent.style.display = isChar ? '' : 'none';
            if (btnFile) btnFile.style.display = isChar ? 'none' : '';
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
        installWindowGetAllVariables();
        installWindowMvuShim();
        // 表格更新回调：插件就绪后自动重试注册
        if (!installTableUpdateHook()) {
            hostWindow.setTimeout(function retryHook() {
                if (!installTableUpdateHook()) hostWindow.setTimeout(retryHook, 2000);
            }, 2000);
        }
        const ejs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
        console.log(
            '[mvu2shujuku][debug] 加载时 EjsTemplate=' + !!ejs +
            ' | defines=' + !!(ejs && ejs.defines) +
            ' | 已注册 mvu2shujukuGetAllVariables=' + typeof (ejs && ejs.defines && ejs.defines.mvu2shujukuGetAllVariables)
        );
        bindAutoInit(context);
        hostWindow.setTimeout(autoInitDatabase, 1500);
        activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
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


root.__MVU2SHUJUKU_PINYIN__ = {"bǎng páng pāng":"膀","líng":"〇伶凌刢囹坽夌姈婈孁岺彾掕昤朎柃棂櫺欞泠淩澪灵燯爧狑玲琌瓴皊砱祾秢竛笭紷綾绫羐羚翎聆舲苓菱蓤蔆蕶蛉衑裬詅跉軨輘酃醽鈴錂铃閝陵零霊霗霛霝靈駖魿鯪鲮鴒鸰鹷麢齡齢龄龗㥄","yī":"一乊伊依医吚咿噫壱壹夁嫛嬄弌揖撎檹毉洢渏漪瑿畩祎禕稦繄蛜衤譩辷郼醫銥铱鷖鹥黟黳","dīng zhēng":"丁","kǎo qiǎo yú":"丂","qī":"七倛僛凄嘁墄娸悽慼慽戚捿柒桤桼棲榿欺沏淒漆紪緀萋褄諆迉郪鏚霋魌鶈","shàng":"丄尙尚恦緔绱","xià":"丅下乤圷夏夓懗梺疜睱罅鎼鏬","hǎn":"丆喊浫罕豃㘎","wàn mò":"万","zhàng":"丈仗墇嶂帐帳幛扙杖涱痮瘬瘴瞕粀胀脹賬账障","sān":"三厁叁弎毵毶毿犙鬖","shàng shǎng shang":"上","qí jī":"丌其奇","bù fǒu":"不","yǔ yù yú":"与","miǎn":"丏偭免冕勉勔喕娩愐汅沔湎睌緬缅腼葂靦鮸𩾃","gài":"丐乢匃匄戤概槩槪溉漑瓂葢鈣钙𬮿","chǒu":"丑丒侴吜杽瞅矁醜魗","zhuān":"专叀嫥専專瑼甎砖磗磚蟤諯鄟顓颛鱄䏝","qiě jū":"且","pī":"丕伓伾噼坯岯憵批披炋狉狓砒磇礔礕秛秠耚豾邳鈚鉟銔錃錍霹駓髬魾𬳵","shì":"世丗亊事仕侍冟势勢卋呩嗜噬士奭嬕室市式弑弒恀恃戺拭揓是昰枾柿栻澨烒煶眂眎眡睗示礻筮簭舐舓襫視视觢試誓諡謚试谥貰贳軾轼逝遾釈释釋鈰鉃鉽铈飾餙餝饰鰘䏡𬤊","qiū":"丘丠坵媝恘恷楸秋秌穐篍緧萩蘒蚯蝵蟗蠤趥邱鞦鞧鰌鰍鳅鶖鹙龝","bǐng":"丙屛怲抦昞昺柄棅炳禀秉稟苪蛃邴鈵陃鞆餅餠饼","yè":"业亱僷墷夜嶪嶫抴捙擛擪擫晔曄曅曗曳曵枼枽業洂液澲烨燁爗璍皣瞱瞸礏腋葉謁谒邺鄴鍱鐷靥靨頁页餣饁馌驜鵺鸈","cóng":"丛从叢婃孮従徔徖悰樷欉淙灇爜琮藂誴賨賩錝","dōng":"东倲冬咚埬岽崬徚昸東氡氭涷笗苳菄蝀鮗鯟鶇鶫鸫鼕𬟽","sī":"丝俬凘厮司咝嘶噝媤廝恖撕斯楒泀澌燍禗禠私糹絲緦纟缌罳蕬虒蛳蜤螄蟖蟴鉰銯鍶鐁锶颸飔騦鷥鸶鼶㟃","chéng":"丞呈城埕堘塍塖宬峸惩懲成承挰掁揨枨棖橙檙洆溗澂珵珹畻程窚筬絾脭荿誠诚郕酲鋮铖騬鯎","diū":"丟丢銩铥","liǎng":"両两兩唡啢掚緉脼蜽裲魉魎𬜯","yǒu":"丣卣友梄湵牖禉羑聈苃莠蜏酉銪铕黝","yán":"严厳啱喦嚴塩壛壧妍姸娫娮岩嵒嵓巌巖巗延揅昖楌檐櫩欕沿炎炏狿琂盐碞筵簷莚蔅虤蜒言訁訮詽讠郔閆閻闫阎顏顔颜鹽麣𫄧","bìng":"並併倂傡垪摒栤病窉竝誁靐鮩","sàng sāng":"丧","gǔn":"丨惃滚滾磙緄绲蓘蔉衮袞輥辊鮌鯀鲧","jiū":"丩勼啾揪揫朻究糾纠萛赳阄鬏鬮鳩鸠","gè gě":"个個各","yā":"丫圧孲庘押枒桠椏錏鐚鴉鴨鵶鸦鸭","pán":"丬媻幋槃洀瀊爿盘盤磐縏蒰蟠蹒蹣鎜鞶","zhōng zhòng":"中","jǐ":"丮妀己戟挤掎撠擠橶泲犱脊虮蟣魢鱾麂","jiè":"丯介借唶堺屆届岕庎徣戒楐犗玠琾界畍疥砎蚧蛶衸褯誡诫鎅骱魪","fēng":"丰仹偑僼凨凬凮妦寷封峯峰崶枫楓檒沣沨渢灃烽犎猦琒疯瘋盽砜碸篈蘴蜂蠭豐鄷酆鋒鎽鏠锋霻靊飌麷","guàn kuàng":"丱","chuàn":"串汌玔賗釧钏","chǎn":"丳产冁剷囅嵼旵浐滻灛產産簅蒇蕆諂譂讇谄鏟铲閳闡阐骣𬊤","lín":"临冧壣崊嶙斴晽暽林潾瀶燐琳璘瞵碄磷粦粼繗翷臨轔辚遴邻鄰鏻阾隣霖驎鱗鳞麐麟𬴊𬭸","zhuó":"丵劅卓啄圴妰娺撯擆擢斫斮斱斲斵晫椓浊浞濁灼烵琸硺禚窡籗籱罬茁蠗蠿諁諑謶诼酌鐲镯鵫鷟䓬𬸦","zhǔ":"丶主劯嘱囑宔帾拄渚濐煑煮燝瞩矚罜詝陼鸀麈𬣞","bā":"丷仈八叭哵夿岜巴捌朳玐疤笆粑羓芭蚆豝釟","wán":"丸刓完岏抏捖汍烷玩琓笂紈纨翫芄貦頑顽","dān":"丹勯匰単妉媅殚殫甔眈砃箪簞耼耽聃聸褝襌躭郸鄲酖頕","wèi wéi":"为","jǐng dǎn":"丼","lì lí":"丽","jǔ":"举弆挙擧椇榉榘櫸欅矩筥聥舉莒蒟襷踽齟龃","piě":"丿苤鐅𬭯","fú":"乀伏俘凫刜匐咈哹垘孚岪巿帗幅幞弗彿怫扶柫栿桴氟泭浮涪澓炥玸甶畉癁祓福稪符箙紱紼絥綍绂绋罘罦翇艀芙芣苻茀茯菔葍虙蚨蜉蝠袚袱襆襥諨豧踾輻辐郛鉘鉜韍韨颫髴鮄鮲鳧鳬鴔鵩黻","yí jí":"乁","yì":"乂义亄亦亿伇伿佾俋億兿刈劓劮勚勩匇呓呭呹唈囈圛坄垼埸奕嫕嬑寱屹峄嶧帟帠幆廙异弈弋役忆怈怿悒意憶懌懿抑挹敡易晹曀曎杙枍棭榏槸檍歝殔殪殹毅浂浥浳湙溢潩澺瀷炈焲熠熤熼燚燡燱獈玴異疫痬瘗瘞瘱癔益瞖穓竩篒縊繶繹绎缢義羿翊翌翳翼耴肄肊膉臆艗艺芅苅萟蓺薏藙藝蘙虉蜴螠衪袣裔裛褹襼訲訳詍詣誼譯議讛议译诣谊豙豛豷貖贀跇轶逸邑鄓醷釴鈠鎰鐿镒镱阣隿霬饐駅驛驿骮鮨鶂鶃鶍鷁鷊鷧鷾鸃鹝鹢黓齸𬬩㑊𫄷𬟁","nǎi":"乃倷奶嬭廼氖疓艿迺釢","wǔ":"乄五仵伍侮倵儛午啎妩娬嫵庑廡忤怃憮摀武潕熓牾玝珷瑦甒碔舞躌迕逜陚鵡鹉𣲘","jiǔ":"久乆九乣奺杦汣灸玖紤舏酒镹韭韮","tuō zhé":"乇杔馲","me mó ma yāo":"么","zhī":"之倁卮巵搘支栀梔椥榰汁泜疷祗祬秓稙綕肢胑胝脂芝蘵蜘衼隻鳷鴲鼅𦭜","wū wù":"乌","zhà":"乍咤宱搾榨溠痄蚱詐诈醡霅䃎","hū":"乎乯匢匫呼唿嘑垀寣幠忽惚昒歑泘淴滹烀苸虍虖謼軤轷雐","fá":"乏伐傠坺垡墢姂栰浌瞂笩筏罚罰罸藅閥阀","lè yuè yào lào":"乐樂","yín":"乑吟噖嚚圁垠夤婬寅峾崟崯檭殥泿淫滛烎犾狺璌硍碒荶蔩訔訚訡誾鄞鈝銀银霪鷣齦","pīng":"乒俜娉涄甹砯聠艵頩","pāng":"乓滂胮膖雱霶","qiáo":"乔侨僑嫶憔桥槗樵橋櫵犞瞧硚礄荍荞蕎藮譙趫鐈鞒鞽顦","hǔ":"乕琥萀虎虝錿鯱","guāi":"乖","chéng shèng":"乗乘娍","yǐ":"乙乛以倚偯嬟崺已庡扆攺敼旑旖檥矣礒笖舣艤苡苢蚁螘蟻裿踦輢轙逘酏釔鈘鉯钇顗鳦齮𫖮𬺈","háo yǐ":"乚","niè miē":"乜","qǐ":"乞企启唘啓啔啟婍屺杞棨玘盀綺绮芑諬起邔闙","yě":"也冶嘢埜壄漜野","xí":"习喺媳嶍席椺檄漝習蓆袭襲覡觋謵趘郋鎴隰霫飁騱騽驨鰼鳛𠅤𫘬","xiāng":"乡厢廂忀楿欀湘瓖稥箱緗缃膷芗萫葙薌襄郷鄉鄊鄕鑲镶香驤骧鱜麘𬙋","shū":"书倏倐儵叔姝尗抒掓摅攄書枢梳樞殊殳毹毺淑瀭焂疎疏紓綀纾舒菽蔬踈軗輸输鄃陎鮛鵨","dǒu":"乧抖枓蚪鈄阧陡","shǐ":"乨使兘史始宩屎榁矢笶豕鉂駛驶","jī":"乩僟击刉刏剞叽唧喞嗘嘰圾基墼姬屐嵆嵇撃擊朞机枅樭機毄激犄玑璣畸畿癪矶磯积積笄筓箕簊緁羁羇羈耭肌芨虀覉覊譏譤讥賫賷赍跻踑躋躸銈錤鐖鑇鑙隮雞鞿韲飢饑饥魕鳮鶏鶺鷄鸄鸡齎齏齑𬯀𫓯𫓹𫌀","náng":"乪嚢欜蠰饢","jiā":"乫佳傢加嘉抸枷梜毠泇浃浹犌猳珈痂笳糘耞腵葭袈豭貑跏迦鉫鎵镓鴐麚𬂩","jù":"乬倨倶具剧劇勮埧埾壉姖屦屨岠巨巪怇惧愳懅懼拒拠昛歫洰澽炬烥犋秬窭窶簴粔耟聚虡蚷詎讵豦距踞躆遽邭醵鉅鐻钜颶飓駏鮔","shí":"乭十埘塒姼实実寔實峕嵵时旹時榯湜溡炻祏竍蚀蝕辻遈鉐飠饣鮖鰣鲥鼫鼭","mǎo":"乮冇卯峁戼昴泖笷蓩鉚铆","mǎi":"买嘪荬蕒買鷶","luàn":"乱亂釠","rǔ":"乳擩汝肗辱鄏","xué":"乴学學峃嶨斈泶澩燢穴茓袕踅鷽鸴","yǎn":"䶮乵俨偃儼兖兗厣厴噞孍嵃巘巚弇愝戭扊抁掩揜曮椼檿沇渷演琰甗眼罨萒蝘衍褗躽遃郾隒顩魇魘鰋鶠黡黤黬黭黶鼴鼹齴龑𬸘𬙂𪩘","fǔ":"乶俌俛俯府弣抚拊撫斧椨滏焤甫盙簠腐腑蜅輔辅郙釜釡阝頫鬴黼㕮𫖯","shā":"乷唦杀桬殺毮猀痧砂硰紗繺纱蔱裟鎩铩閷髿魦鯊鯋鲨","nǎ":"乸雫","qián":"乹亁仱偂前墘媊岒拑掮榩橬歬潛潜濳灊箝葥虔軡鈐鉗銭錢鎆钤钱钳靬騚騝鰬黔黚","suǒ":"乺唢嗩所暛溑溹琐琑瑣索褨鎖鎻鏁锁","yú":"乻于亐伃余堣堬妤娛娯娱嬩崳嵎嵛愚扵揄旟楡楰榆欤歈歟歶渔渝湡漁澞牏狳玗玙瑜璵盂睮窬竽籅羭腴臾舁舆艅茰萮萸蕍蘛虞虶蝓螸衧褕覦觎諛謣谀踰輿轝逾邘酑鍝隅雓雩餘馀騟骬髃魚魣鮽鯲鰅鱼鷠鸆齵","zhù":"乼伫佇住坾墸壴嵀拀杼柱樦殶注炷疰眝祝祩竚筯箸篫簗紵紸纻羜翥苎莇蛀註貯贮跓軴鉒鋳鑄铸馵駐驻","zhě":"乽者褶襵赭踷鍺锗","qián gān":"乾","zhì luàn":"乿","guī":"亀圭妫媯嫢嬀帰归摫椝槻槼櫷歸珪瑰璝瓌皈瞡硅茥蘬規规邽郌閨闺騩鬶鬹","lǐn lìn":"亃","jué":"亅决刔劂匷厥噊孒孓崛崫嶥彏憠憰戄抉挗掘攫桷橛橜欮氒決灍焳熦爑爴爵獗玃玦玨珏瑴瘚矍矡砄絕絶绝臄芵蕝蕨虳蟨蟩觖觮觼訣譎诀谲貜赽趉蹷躩鈌鐍鐝钁镢鴂鴃鷢𫘝㵐𫔎","le liǎo":"了","gè mā":"亇","yǔ yú":"予懙","zhēng":"争佂凧姃媜峥崝崢征徰炡烝爭狰猙癥眐睁睜筝箏篜聇脀蒸踭鉦錚鏳鬇","èr":"二刵咡弍弐樲誀貮貳贰髶","chù":"亍傗儊怵憷搐斶歜珿琡矗竌絀绌臅触觸豖鄐閦黜","kuī":"亏刲岿巋盔窥窺聧虧闚顝","yún":"云伝勻匀囩妘愪抣昀橒沄涢溳澐熉畇秐筼篔紜縜纭耘芸蒷蕓郧鄖鋆雲","hù":"互冱嗀嚛婟嫭嫮岵帍弖怙戶户戸戽扈护昈槴沍沪滬熩瓠祜笏簄粐綔蔰護豰鄠鍙頀鱯鳠鳸鸌鹱","qí":"亓剘埼岐岓崎嵜愭掑斉斊旂旗棊棋檱櫀歧淇濝猉玂琦琪璂畦疧碁碕祁祈祺禥竒簯簱籏粸綥綦肵脐臍艩芪萁萕蕲藄蘄蚑蚚蛴蜝蜞螧蠐褀軝鄿釮錡锜陭頎颀騎騏騹骐骑鬐鬿鯕鰭鲯鳍鵸鶀麒麡𨙸𬨂䓫","jǐng":"井儆刭剄坓宑幜憬暻殌汫汬澋璄璟璥穽肼蟼警阱頚頸","sì":"亖佀価儩兕嗣四姒娰孠寺巳柶榹汜泗泤洍洠涘瀃牭祀禩竢笥耜肂肆蕼覗貄釲鈶鈻飤飼饲駟騃驷","suì":"亗嬘岁嵗旞檖歲歳澻煫燧璲砕碎祟禭穂穗穟繀繐繸襚誶譢谇賥邃鐆鐩隧韢𫟦𬭼","gèn":"亘亙揯搄茛","yà":"亚亜俹冴劜圔圠埡娅婭揠氩氬犽砑稏聐襾覀訝讶迓齾","xiē suò":"些","qí zhāi":"亝齊","yā yà":"亞压垭壓铔","jí qì":"亟焏","tóu":"亠投頭骰","wáng wú":"亡","kàng háng gāng":"亢","dà":"亣眔","jiāo":"交僬娇嬌峧嶕嶣憍椒浇澆焦礁穚簥胶膠膲茭茮蕉虠蛟蟭跤轇郊鐎驕骄鮫鲛鵁鷦鷮鹪䴔","hài":"亥嗐害氦餀饚駭駴骇","hēng pēng":"亨","mǔ":"亩姆峔拇母牡牳畂畆畒畝畞畮砪胟踇鉧𬭁𧿹","ye":"亪","xiǎng":"享亯响想晑蚃蠁響飨餉饗饷鮝鯗鱶鲞","jīng":"京亰兢坕坙婛惊旌旍晶橸泾涇猄睛秔稉粳精経經綡聙腈茎荆荊菁葏驚鯨鲸鶁鶄麖麠鼱䴖","tíng":"亭停婷嵉庭廷楟榳筳聤莛葶蜓蝏諪邒霆鼮䗴","liàng":"亮喨悢晾湸諒谅輌輛辆鍄","qīn qìng":"亲親","bó":"亳仢侼僰博帛愽懪挬搏欂浡淿渤煿牔狛瓝礴秡箔簙糪胉脖膊舶艊萡葧袯襏襮謈踣郣鈸鉑鋍鎛鑮钹铂镈餺馎馛馞駁駮驳髆鵓鹁","yòu":"亴佑佦侑又右哊唀囿姷宥峟幼狖祐蚴誘诱貁迶酭釉鼬","xiè":"亵伳偞偰僁卨卸噧塮夑媟屑屧廨徢懈暬械榍榭泻洩渫澥瀉瀣灺炧炨燮爕獬祄禼糏紲絏絬繲纈绁缷薢薤蟹蠏褉褻謝谢躞邂靾韰齂齘齛齥𬹼𤫉","dǎn dàn":"亶馾","lián":"亷劆匲匳嗹噒奁奩嫾帘廉怜憐涟漣濂濓瀮熑燫簾籢籨縺翴联聨聫聮聯臁莲蓮薕螊蠊裢褳覝謰蹥连連鎌鐮镰鬑鰱鲢","duǒ":"亸哚嚲埵崜朵朶綞缍趓躱躲軃","wěi mén":"亹斖","rén":"人亻仁壬忈忎朲秂芢魜鵀","jí":"亼亽伋佶偮卙即卽及叝吉堲塉姞嫉岌嵴嶯彶忣急愱戢揤极棘楫極槉檝殛汲湒潗疾瘠皍笈箿籍級级膌艥蒺蕀蕺蝍螏襋觙谻踖蹐躤輯轚辑郆銡鍓鏶集雧霵鹡㴔","wáng":"亾仼兦莣蚟","shén shí":"什","lè":"仂叻忇氻泐玏砳簕艻阞韷餎鰳鱳鳓","dīng":"仃叮帄玎疔盯耵虰靪","zè":"仄崱庂捑昃昗汄","jǐn jìn":"仅僅嫤","pú pū":"仆","chóu qiú":"仇","zhǎng":"仉幥掌礃","jīn":"今堻巾惍斤津珒琻璡砛筋荕衿襟觔金釒釿钅鹶黅𬬱","bīng":"仌仒兵冫冰掤氷鋲","réng":"仍礽芿辸陾","fó":"仏坲梻","jīn sǎn":"仐","lún":"仑伦侖倫囵圇婨崘崙棆沦淪磮腀菕蜦踚輪轮錀陯鯩𬬭","cāng":"仓仺倉凔嵢沧滄濸獊舱艙苍蒼螥鸧","zǎi zǐ zī":"仔","tā":"他塌它榙溻牠祂褟趿遢闧","fù":"付偩傅冨副咐坿复妇婦媍嬔富復椱祔禣竎緮縛缚腹萯蕧蚹蛗蝜蝮袝複覄覆訃詂讣負賦賻负赋赙赴輹鍑鍢阜附馥駙驸鮒鰒鲋鳆㳇","xiān":"仙仚佡僊僲先嘕奾屳廯忺憸掀暹杴氙珗祆秈籼繊纎纖苮褼襳跹蹮躚酰鍁锨韯韱馦鱻鶱𬸣","tuō chà duó":"仛","hóng":"仜吰垬妅娂宏宖弘彋汯泓洪浤渱潂玒玜竑竤篊粠紘紭綋纮翃翝耾苰荭葒葓谹谼鈜鉷鋐閎闳霐霟鞃魟鴻鸿黉黌𫟹𬭎","tóng":"仝佟哃峂峝庝彤晍曈桐氃浵潼犝獞眮瞳砼秱童粡膧茼蚒詷赨酮鉖鉵銅铜餇鮦鲖𫍣𦒍","rèn":"仞仭刃刄妊姙屻岃扨牣祍紉紝絍纫纴肕腍衽袵訒認认讱軔轫鈓靭靱韌韧飪餁饪","qiān":"仟佥僉千圲奷孯岍悭愆慳扦拪搴撁攐攑攓杄櫏汘汧牵牽竏签簽籖籤粁芊茾蚈褰諐謙谦谸迁遷釺鈆鉛鏲钎阡韆顅騫骞鬜鬝鵮鹐","gǎn hàn":"仠","yì gē":"仡","dài":"代侢叇垈埭岱帒带帯帶廗怠戴曃柋殆瀻玳瑇甙簤紿緿绐艜蝳袋襶貣贷蹛軑軚軩轪迨霴靆鴏黛黱","lìng líng lǐng":"令","chào":"仦耖觘","cháng zhǎng":"仧兏長长","sā":"仨","cháng":"仩偿償嘗嚐嫦尝常徜瑺瓺甞肠腸膓苌萇镸鱨鲿","yí":"仪侇儀冝匜咦圯夷姨宐宜宧寲峓嶬嶷巸彛彜彝彞怡恞扅暆栘椬椸沂洟熪瓵痍移簃籎羠胰萓蛦螔觺謻貽贻跠迻遺鏔頉頤頥顊颐饴鮧鴺","mù":"仫凩募墓幕幙慔慕暮暯木楘毣沐炑牧狇目睦穆艒苜莯蚞鉬钼雮霂","men mén":"们","fǎn":"仮反橎返","chào miǎo":"仯","yǎng áng":"仰","zhòng":"仲众堹妕媑狆眾祌筗茽蚛衆衶諥","pǐ pí":"仳","wò":"仴偓卧媉幄握楃沃渥濣瓁瞃硪肟腛臥齷龌","jiàn":"件俴健僭剑剣剱劍劎劒劔墹寋建徤擶旔楗毽洊涧澗牮珔瞷磵礀箭糋繝腱臶舰艦荐薦覸諓諫譛谏賎賤贱趝践踐踺轞鉴鍳鍵鐱鑑鑒鑬鑳键間餞饯𬣡","jià jiè jie":"价","yǎo fó":"仸","rèn rén":"任","fèn bīn":"份","dī":"仾低啲埞堤岻彽樀滴磾秪羝袛趆隄鞮䃅","fǎng":"仿倣旊昉昘瓬眆紡纺舫訪访髣鶭","zhōng":"伀刣妐幒彸忠柊汷泈炂盅籦終终舯蔠蜙螤螽衳衷蹱鈡鍾鐘钟锺鴤鼨","pèi":"伂佩姵帔斾旆沛浿珮蓜轡辔配霈馷","diào":"伄吊弔掉瘹盄窎窵竨訋釣鈟銱鋽鑃钓铞雿魡","dùn":"伅潡炖燉盾砘碷踲逇遁遯鈍钝","wěn":"伆刎吻呅抆桽稳穏穩紊肳脗","xǐn":"伈","kàng":"伉匟囥抗炕鈧钪","ài":"伌僾塧壒嫒嬡愛懓暧曖爱瑷璦皧瞹砹硋碍礙薆譺賹鑀隘靉餲馤鱫鴱","jì qí":"伎薺","xiū xǔ":"休","jìn yín":"伒","dǎn":"伔刐撢玬瓭紞胆膽衴賧赕黕𬘘","fū":"伕呋娐孵尃怤懯敷旉玞砆稃筟糐綒肤膚荂荴衭趺跗邞鄜酜鈇麩麬麱麸𫓧","tǎng":"伖傥儻埫戃曭爣矘躺鎲钂镋","yōu":"优優呦嚘峳幽忧悠憂攸櫌滺瀀纋羪耰逌鄾麀","huǒ":"伙夥火煷邩鈥钬","huì kuài":"会會浍璯","yǔ":"伛俁俣偊傴匬噳圄圉宇寙屿嶼庾挧敔斞楀瑀瘐祤禹穥窳羽與萭貐鄅頨麌齬龉㺄","cuì":"伜啛忰悴毳淬焠疩瘁竁粋粹紣綷翆翠脃脆脺膬膵臎萃襊顇","sǎn":"伞傘糤繖饊馓","wěi":"伟伪偉偽僞儰娓寪屗崣嶉徫愇捤暐梶洧浘渨炜煒猥玮瑋痿緯纬腲艉芛苇荱萎葦蒍蔿蜼諉诿踓鍡韑韙韡韪頠颹骩骪骫鮪鲔𫇭𬀩𬱟","chuán zhuàn":"传傳","chē jū":"伡俥车","jū chē":"車","yá":"伢厑厓堐岈崕崖涯漄牙玡琊睚笌芽蚜衙齖","qiàn":"伣俔倩儙刋壍嬱悓棈椠槧欠歉皘篏篟縴芡蒨蔳輤𬘬","shāng":"伤傷商墒慯殇殤滳漡熵蔏螪觞觴謪鬺","chāng":"伥倀娼昌椙淐猖琩菖裮錩锠閶阊鯧鲳鼚","chen cāng":"伧","xùn":"伨侚卂噀巺巽徇愻殉殾汛潠狥蕈訊訓訙训讯迅迿逊遜鑂顨馴驯","xìn":"伩囟孞脪舋衅訫釁阠顖","chǐ":"伬侈卶叺呎垑恥歯耻肔胣蚇裭褫豉鉹齒齿","xián xuán":"伭","nú nǔ":"伮","bó bǎi":"伯","gū gù":"估","nǐ":"伱你儞孴拟擬旎晲狔苨薿隬","nì ní":"伲","bàn":"伴办半姅怑扮瓣秚絆绊辦鉡靽","xù":"伵侐勖勗卹叙垿壻婿序恤敍敘旭昫朂槒欰殈汿沀洫溆漵潊烅烼煦獝珬盢瞁稸絮続緒緖續绪续聓聟蓄藚訹賉酗頊鱮㳚","zhòu":"伷僽冑呪咒咮宙昼晝甃皱皺籀籒籕粙紂縐纣绉胄荮葤詋酎駎驟骤㤘㑇","shēn":"伸侁兟呻堔妽娠屾峷扟敒曑柛氠深燊珅甡甧申眒砷穼籶籸糂紳绅罙罧葠蓡蔘薓裑訷詵诜身駪鯓鯵鰺鲹鵢𬳽","qū":"伹佉匤呿坥屈岖岴嶇憈抾敺浀煀祛筁粬胠蛆蛐袪覻詘诎趍躯軀阹駆駈驅驱髷魼鰸鱋鶌麯麴麹黢㭕𪨰䓛","sì cì":"伺","bēng":"伻嘣奟崩嵭閍","sì shì":"似","jiā qié gā":"伽","yǐ chì":"佁","diàn tián":"佃钿","hān gàn":"佄","mài":"佅劢勱卖唛売脈衇賣迈邁霡霢麥麦鿏","dàn":"但僤啖啗啿噉嚪帎憺旦柦氮沊泹淡狚疍癚禫窞腅萏蓞蛋蜑觛訑誕诞贉霮餤饏駳髧鴠𫢸","bù":"佈勏吥咘埗埠布廍怖悑步歨歩瓿篰荹蔀踄部郶鈈钚餢","bǐ":"佊俾匕夶妣彼朼柀比毞沘疕秕笔筆粃聛舭貏鄙","zhāo shào":"佋","cǐ":"佌此泚皉𫚖","wèi":"位卫味喂墛媦慰懀未渭煟熭犚猬畏緭罻胃苿菋藯蘶蝟螱衛衞褽謂讆讏谓躗躛軎轊鏏霨餧餵饖魏鮇鳚","zuǒ":"佐左繓","yǎng":"佒傟养坱岟慃懩攁氧氱炴痒癢礢紻蝆軮養駚","tǐ tī":"体體","zhàn":"佔偡嶘战戦戰栈桟棧湛站綻绽菚蘸虥虦譧轏驏","hé hē hè":"何","bì":"佖咇哔嗶坒堛壁奰妼婢嬖币幣幤庇庳廦弊弻弼彃必怭愊愎敝斃梐毕毖毙湢滗滭潷煏熚狴獘獙珌璧畀畢疪痹痺皕睤碧筚箅箆篦篳粊綼縪繴罼腷苾荜萆萞蓖蓽蔽薜蜌袐襅襞襣觱詖诐貱贔赑跸蹕躃躄避邲鄨鄪鉍鏎鐴铋閇閉閟闭陛韠飶饆馝駜驆髀魓鮅鷝鷩鼊","tuó":"佗坨堶岮槖橐沱砣砤碢紽詑跎酡阤陀陁駝駞騨驒驝驼鮀鴕鸵鼉鼍鼧𬶍","shé":"佘舌虵蛥","yì dié":"佚昳泆軼","fó fú bì bó":"佛","zuò zuō":"作","gōu":"佝沟溝痀篝簼緱缑袧褠鈎鉤钩鞲韝","nìng":"佞侫倿寕泞澝濘","qú":"佢劬戵斪欋欔氍淭灈爠璖璩癯磲籧絇胊臞菃葋蕖蘧蟝蠷蠼衐衢躣軥鑺鴝鸜鸲鼩","yōng yòng":"佣","wǎ":"佤咓砙邷","kǎ":"佧垰胩裃鉲","bāo":"佨勹包孢煲笣胞苞蕔裦褒襃闁齙龅","huái huí":"佪","gé hè":"佫","lǎo":"佬咾恅栳狫珯硓老耂荖蛯轑銠铑鮱","xiáng":"佭庠栙祥絴翔詳跭","gé":"佮匌呄嗝塥愅挌搿槅櫊滆膈臵茖觡諽輵轕閣阁隔鞷韐韚騔骼鮯","yáng":"佯劷垟崸徉扬揚敭旸昜暘杨楊洋炀珜疡瘍眻蛘諹輰鍚钖阦阳陽霷颺飏鰑鴹鸉","bǎi":"佰捭摆擺栢百竡粨襬","fǎ":"佱峜法灋砝鍅","mǐng":"佲凕姳慏酩","èr nài":"佴","hěn":"佷很狠詪𬣳","huó":"佸活","guǐ":"佹匦匭厬垝姽宄庋庪恑晷湀癸祪簋蛫蟡觤詭诡軌轨陒鬼","quán":"佺全啳埢姾峑巏拳搼权楾権權泉洤湶牷犈瑔痊硂筌縓荃葲蜷蠸觠詮诠跧踡輇辁醛銓铨闎顴颧駩騡鬈鰁鳈齤","tiāo":"佻庣旫祧聎","jiǎo":"佼儌孂挢搅撟撹攪敫敽敿晈暞曒灚燞狡璬皎皦絞纐绞腳臫蟜譑賋踋鉸铰餃饺鱎龣","cì":"佽刾庛朿栨次絘茦莿蛓螆賜赐","xíng":"侀刑哘型娙形洐硎蛵邢郉鈃鉶銒钘铏陉陘餳𫰛","tuō":"侂咃咜圫托拕拖汑脫脱莌袥託讬飥饦魠鮵","kǎn":"侃偘冚坎惂砍莰輡轗顑","zhí":"侄値值埴執姪嬂戠执摭植樴淔漐直禃絷縶聀职職膱蟙跖踯蹠躑軄釞馽","gāi":"侅垓姟峐晐畡祴荄該该豥賅賌赅陔","lái":"來俫倈崃崍庲来梾棶涞淶猍琜筙箂莱萊逨郲錸铼騋鯠鶆麳","kuǎ":"侉咵垮銙","gōng":"侊公功匑匔塨宫宮工幊弓恭攻杛碽糼糿肱觥觵躬躳髸龔龚䢼","lì":"例俐俪傈儮儷凓利力励勵历厉厤厯厲叓吏呖唎唳嚦囇坜塛壢娳婯屴岦悧悷慄戾搮暦曆曞朸枥栃栗栛檪櫔櫪欐歴歷沥沴涖溧濿瀝爏犡猁珕瑮瓅瓑瓥疬痢癧盭睙砅砺砾磿礪礫礰禲秝立笠篥粒粝糲脷苈茘荔莅莉蒚蒞藶蚸蛎蛠蜧蝷蠇蠣詈讈赲轢轣轹酈鉝隶隷雳靂靋鬁鳨鴗鷅麜𫵷𬍛","yīn":"侌凐喑噾囙因垔堙姻婣愔慇栶氤洇溵濦瘖禋秵筃絪緸茵蒑蔭裀諲銦铟闉阥阴陰陻隂霒霠鞇音韾駰骃齗𬘡𬤇𬮱","mǐ":"侎孊弭敉洣渳灖米粎羋脒芈葞蔝銤","zhū":"侏株槠橥櫧櫫洙潴瀦猪珠硃秼絑茱蕏蛛蝫蠩袾誅諸诛诸豬跦邾銖铢駯鮢鯺鴸鼄","ān":"侒偣媕安峖庵桉氨盦盫腤菴萻葊蓭誝諳谙鞌鞍韽馣鮟鵪鶕鹌𩽾","lù":"侓僇勎勠圥坴塶娽峍廘彔录戮摝椂樚淕淥渌漉潞琭璐甪盝睩硉祿禄稑穋箓簏簬簵簶籙粶蔍蕗虂螰賂赂趢路踛蹗輅轆辂辘逯醁錄録錴鏴陸騄騼鯥鴼鵦鵱鷺鹭鹿麓𫘧","móu":"侔劺恈眸蛑謀谋踎鍪鴾麰","ér":"侕儿児兒峏栭洏粫而胹荋袻輀轜陑隭髵鮞鲕鴯鸸","dòng tǒng tóng":"侗","chà":"侘奼姹岔汊詫诧","chì":"侙傺勅勑叱啻彳恜慗憏懘抶敕斥杘湁灻炽烾熾痓痸瘛翄翅翤翨腟赤趩遫鉓雴飭饬鶒鷘","gòng gōng":"供共","zhōu":"侜周喌州徟洲淍炿烐珘矪舟謅譸诌賙赒輈輖辀週郮銂霌駲騆鵃鸼","rú":"侞儒嚅如嬬孺帤曘桇渪濡筎茹蕠薷蝡蠕袽襦邚醹銣铷顬颥鱬鴑鴽","jiàn cún":"侟","xiá":"侠俠匣峡峽敮暇柙炠烚狎狭狹珨瑕硖硤碬祫筪縖翈舝舺蕸赮轄辖遐鍜鎋陜陿霞騢魻鶷黠","lǚ":"侣侶儢吕呂屡屢履挔捛旅梠焒祣稆穭絽縷缕膂膐褛褸郘鋁铝","ta":"侤","jiǎo yáo":"侥僥徺","zhēn":"侦偵寊帧帪幀搸斟桢楨榛樼殝浈湞潧澵獉珍珎瑧甄眞真砧碪祯禎禛箴胗臻葴蒖蓁薽貞贞轃遉酙針鉁錱鍼针鱵","cè zè zhāi":"侧側","kuài":"侩儈凷哙噲圦块塊巜廥快旝欳狯獪筷糩脍膾郐鄶鱠鲙","chái":"侪儕喍柴犲祡豺","nóng":"侬儂农哝噥檂欁浓濃燶禯秾穠脓膿蕽襛譨農辳醲鬞𬪩","jǐn":"侭儘卺厪巹槿漌瑾紧緊菫蓳謹谨錦锦饉馑","hóu hòu":"侯矦","jiǒng":"侰僒冏囧泂澃炯烱煚煛熲燛窘綗褧迥逈顈颎䌹","chěng tǐng":"侱","zhèn zhēn":"侲揕","zuò":"侳做唑坐岝岞座祚糳胙葃葄蓙袏阼","qīn":"侵兓媇嵚嶔欽衾誛钦顉駸骎鮼","jú":"侷啹婅局巈椈橘泦淗湨焗犑狊粷菊蘜趜跼蹫輂郹閰駶驧鵙鵴鶪鼰鼳䴗","shù dōu":"侸","tǐng":"侹圢娗挺涏烶珽脡艇誔頲颋","shèn":"侺愼慎昚涁渗滲瘆瘮眘祳肾胂脤腎蜃蜄鋠","tuì tuó":"侻","nán":"侽喃娚抩暔枏柟楠男畘莮萳遖","xiāo":"侾哓嘵嚻囂婋宯宵庨彇揱枭枵梟櫹歊毊消潇瀟灱灲烋焇猇獢痚痟硝硣窙箫簘簫綃绡翛膮萧蕭虈虓蟂蟏蟰蠨踃逍銷销霄颵驍骁髇髐魈鴞鴵鷍鸮","biàn pián":"便緶缏","tuǐ":"俀腿蹆骽","xì":"係匸卌呬墍屃屓屭忥怬恄椞潝潟澙熂犔磶禊細綌縘细绤舃舄蕮虩衋覤赩趇郤釳阋隙隟霼餼饩鬩黖","cù":"促媨憱猝瘄瘯簇縬脨蔟誎趗踧踿蹙蹴蹵醋顣鼀","é":"俄囮娥峉峨峩涐珴皒睋磀莪訛誐譌讹迗鈋鋨锇頟額额魤鵝鵞鹅","qiú":"俅叴唒囚崷巯巰扏梂殏毬求汓泅浗湭煪犰玌球璆皳盚紌絿肍芁莍虬虯蛷裘觓觩訄訅賕赇逎逑遒酋釚釻銶頄鮂鯄鰽鼽𨱇","xú":"俆徐禑","guàng kuāng":"俇","kù":"俈喾嚳库庫廤瘔絝绔袴裤褲酷","wù":"俉务務勿卼坞塢奦婺寤屼岉嵨忢悞悟悮戊扤晤杌溩焐熃物痦矹窹粅蘁誤误鋈阢隖雾霚霧靰騖骛鶩鹜鼿齀","jùn":"俊儁呁埈寯峻懏捃攟晙棞燇珺畯竣箟蜠賐郡陖餕馂駿骏鵔鵕鵘䐃","liáng":"俍墚梁椋樑粮粱糧良輬辌𫟅","zǔ":"俎唨爼祖組组詛诅鎺阻靻","qiào xiào":"俏","yǒng":"俑勇勈咏埇塎嵱彮怺恿悀惥愑愹慂柡栐永泳湧甬蛹詠踊踴鯒鲬","hùn":"俒倱圂尡慁掍溷焝睴觨諢诨","jìng":"俓傹境妌婙婧弪弳径徑敬曔桱梷浄瀞獍痉痙竞竟竫競竸胫脛莖誩踁迳逕鏡镜靖静靜鵛","sàn":"俕閐","pěi":"俖","sú":"俗","xī":"俙僖兮凞卥厀吸唏唽嘻噏嚱夕奚嬆嬉屖嵠巇希徆徯息悉悕惁惜昔晞晰晳曦析桸榽樨橀欷氥汐浠淅渓溪烯焁焈焟熄熈熙熹熺熻燨爔牺犀犠犧琋瘜皙睎瞦矽硒磎礂稀穸窸粞糦緆繥羲翕翖肸肹膝舾莃菥蒠蜥螅蟋蠵西觹觽觿譆谿豀豨豯貕赥邜鄎酅醯釸錫鏭鐊鑴锡隵餏饎饻鯑鵗鸂鼷","lǐ":"俚娌峢峲李欚浬澧理礼禮粴裏裡豊逦邐醴鋰锂鯉鱧鱱鲤鳢","bǎo":"保堢媬宝寚寳寶珤緥葆藵褓賲靌飹飽饱駂鳵鴇鸨","yú shù yù":"俞","sì qí":"俟","xìn shēn":"信","xiū":"俢修咻庥樇烌羞脙脩臹貅銝鎀飍饈馐髤髹鮴鱃鵂鸺䗛","dì":"俤偙僀埊墑墬娣帝怟旳梊焍玓甋眱睇碲祶禘第締缔腣菂蒂蔕蝃蝭螮諦谛踶递逓遞遰鉪𤧛䗖","chóu":"俦儔嬦惆愁懤栦燽畴疇皗稠筹籌絒綢绸菗詶讎讐踌躊酧酬醻雔雠雦","zhì":"俧偫儨制劕垁娡寘帙帜幟庢庤廌彘徏徝志忮懥懫挃挚掷摯擲旘晊智栉桎梽櫍櫛治洷滍滞滯潌瀄炙熫狾猘璏瓆痔痣礩祑秩秷稚稺穉窒紩緻置翐膣至致芖蛭袟袠製覟觗觯觶誌豑豒貭質贄质贽跱踬躓輊轾郅銍鋕鑕铚锧陟隲雉駤騭騺驇骘鯯鴙鷙鸷𬃊","liǎ liǎng":"俩","jiǎn":"俭倹儉减剪堿弿彅戩戬拣挸捡揀撿枧柬梘检検檢減湕瀽瑐睑瞼硷碱礆笕筧简簡絸繭翦茧藆蠒裥襇襉襺詃謇謭譾谫趼蹇鐗鬋鰎鹸鹻鹼","huò":"俰咟嚯嚿奯彠惑或擭旤曤檴沎湱瀖獲癨眓矐祸禍穫窢耯臛艧获蒦藿蠖謋貨货鍃鑊镬雘霍靃韄㸌","jù jū":"俱据鋸锯","xiào":"俲傚効咲哮啸嘋嘨嘯孝效斅斆歗涍熽笑詨誟","pái":"俳徘牌犤猅簰簲輫","biào":"俵鰾鳔","chù tì":"俶","fèi":"俷剕厞吠屝废廃廢昲曊櫠沸濷狒癈肺萉費费鐨镄陫靅鼣","fèng":"俸凤奉湗焨煈賵赗鳯鳳鴌","ǎn":"俺唵埯揞罯銨铵","bèi":"俻倍偝偹備僃备悖惫愂憊昁梖焙牬犕狈狽珼琲碚禙糒苝蓓蛽褙貝贝軰輩辈邶郥鄁鋇鐾钡鞁鞴𬇙","yù":"俼儥喅喩喻域堉妪嫗寓峪嶎庽彧御愈慾戫昱棛棜棫櫲欎欝欲毓浴淯滪潏澦灪焴煜燏燠爩狱獄玉琙瘉癒砡硢硲礇礖礜禦秗稢稶篽籞籲粖緎罭聿肀艈芋芌茟蒮蓣蓹蕷蘌蜟蜮袬裕誉諭譽谕豫軉輍逳遇遹郁醧鈺鋊錥鐭钰閾阈雤霱預预飫饇饫馭驈驭鬰鬱鬻魊鱊鳿鴥鴧鴪鵒鷸鸒鹆鹬","xīn":"俽噺妡嬜廞心忄忻惞新昕杺欣歆炘盺薪訢辛邤鈊鋅鑫锌馨馫䜣𫷷","hǔ chí":"俿","jiù":"倃僦匓匛匶厩咎就廄廏廐慦捄救旧柩柾桕欍殧疚臼舅舊鯦鷲鹫麔齨㠇","yáo":"倄傜嗂垚堯姚媱尧尭峣嶢嶤徭揺搖摇摿暚榣烑爻猺珧瑤瑶磘窑窯窰肴蘨謠謡谣軺轺遙遥邎顤颻飖餆餚鰩鱙鳐","cuì zú":"倅","liǎng liǎ":"倆","wǎn":"倇唍婉惋挽晚晥晩晼梚椀琬畹皖盌碗綩綰绾脘萖踠輓鋔","zǒng":"倊偬傯嵸总惣捴搃摠燪総緫縂總蓗","guān":"倌关官棺瘝癏窤蒄関闗關鰥鱞鳏","tiǎn":"倎唺忝悿晪殄淟睓腆舔覥觍賟錪餂","mén":"們扪捫璊菛虋鍆钔門閅门𫞩","dǎo dào":"倒","tán tàn":"倓埮","juè jué":"倔","chuí":"倕垂埀捶搥桘棰槌箠腄菙錘鎚锤陲顀","xìng":"倖姓婞嬹幸性悻杏涬緈臖荇莕葕","péng":"倗傰塜塳弸憉捀朋棚椖樥硼稝竼篷纄膨芃蓬蘕蟚蟛袶輣錋鑝韸韼騯髼鬅鬔鵬鹏","tǎng cháng":"倘","hòu":"候厚后垕堠後洉茩豞逅郈鮜鱟鲎鲘","tì":"倜剃嚏嚔屉屜悌悐惕惖戻掦替朑歒殢涕瓋笹籊薙褅逖逷髰鬀鬄","gàn":"倝凎幹榦檊淦灨盰紺绀詌贑赣骭㽏","liàng jìng":"倞靓","suī":"倠哸夊滖濉眭睢芕荽荾虽雖鞖","chàng chāng":"倡","jié":"倢偼傑刦刧刼劫劼卩卪婕媫孑岊崨嵥嶻巀幯截捷掶擮昅杢杰桀桝楬楶榤洁滐潔狤睫礍竭節羯莭蓵蛣蜐蠘蠞蠽衱袺訐詰誱讦踕迼鉣鍻镼頡鮚鲒㛃","kǒng kōng":"倥","juàn":"倦劵奆慻桊淃狷獧眷睊睠絭絹绢罥羂腃蔨鄄餋","zōng":"倧堫宗嵏嵕惾朡棕椶熧猣磫緃翪腙葼蝬豵踨踪蹤鍐鑁騌騣骔鬃鬉鬷鯮鯼","ní":"倪坭埿尼屔怩淣猊籾聣蚭蜺觬貎跜輗郳鈮铌霓馜鯢鲵麑齯𫐐𫠜","zhuō":"倬拙捉桌梲棁棳槕涿窧鐯䦃","wō wēi":"倭","luǒ":"倮剆曪瘰癳臝蓏蠃裸躶","sōng":"倯凇娀崧嵩庺憽松枀枩柗梥檧淞濍硹菘鬆","lèng":"倰堎愣睖踜","zì":"倳剚字恣渍漬牸眥眦胔胾自茡荢","bèn":"倴坌捹撪渀笨逩","cǎi":"倸啋婇彩採棌毝睬綵跴踩","zhài":"债債寨瘵砦","yē":"倻吔噎擨暍椰歋潱蠮","shà":"倽唼喢歃箑翜翣萐閯霎","qīng":"倾傾卿圊寈氢氫淸清蜻軽輕轻郬錆鑋靑青鯖","yīng":"偀嘤噟嚶婴媖嫈嬰孆孾愥撄攖朠桜樱櫻渶煐珱瑛璎瓔甇甖碤礯緓纓绬缨罂罃罌膺英莺蘡蝧蠳褮譻賏軈鑍锳霙韺鴬鶑鶧鶯鷪鷹鸎鸚鹦鹰䓨","chēng chèn":"偁爯","ruǎn":"偄朊瑌瓀碝礝腝軟輭软阮","zhòng tóng":"偅","chǔn":"偆惷睶萶蠢賰","jiǎ jià":"假","jì jié":"偈","bǐng bìng":"偋","ruò":"偌叒嵶弱楉焫爇箬篛蒻鄀鰙鰯鶸","tí":"偍厗啼嗁崹漽瑅睼禵稊緹缇罤蕛褆謕趧蹄蹏醍鍗題题騠鮷鯷鳀鵜鷤鹈𫘨","wēi":"偎危喴威媙嶶巍微愄揋揻椳楲溦烓煨燰癓縅葨葳薇蜲蝛覣詴逶隇隈霺鰃鰄鳂","piān":"偏囨媥楄犏篇翩鍂","yàn":"偐厌厭唁喭嚈嚥堰妟姲嬊嬿宴彥彦敥晏暥曕曣滟灎灔灧灩焔焰焱熖燄牪猒砚硯艳艶艷覎觃觾諺讌讞谚谳豓豔贋贗赝軅酀酽醼釅雁餍饜騐験騴驗驠验鬳鳫鴈鴳鷃鷰齞","tǎng dàng":"偒","è":"偔匎卾厄呝咢噩垩堊堮岋崿廅悪愕戹扼搤搹擜櫮歞歺湂琧砈砐硆腭苊萼蕚蚅蝁覨諤讍谔豟軛軶轭遌遏遻鄂鈪鍔鑩锷阨阸頞顎颚餓餩饿鰐鰪鱷鳄鶚鹗齃齶𫫇𥔲","xié":"偕勰协協嗋垥奊恊愶拹携撷擕擷攜斜旪熁燲綊緳縀缬翓胁脅脇脋膎蝢衺襭諧讗谐鞋鞵龤㙦","chě":"偖扯撦","shěng":"偗渻眚","chā":"偛嗏扠挿插揷疀臿艖銟鍤锸餷","huáng":"偟凰喤堭墴媓崲徨惶楻湟煌獚瑝璜癀皇磺穔篁簧艎葟蝗蟥諻趪遑鍠鐄锽隍韹餭騜鰉鱑鳇鷬黃黄𨱑","yǎo":"偠咬婹宎岆杳柼榚溔狕窅窈舀苭闄騕鷕齩","chǒu qiào":"偢","yóu":"偤尤庮怣沋油浟游犹猶猷由疣秞肬莜莸蕕蚰蝣訧輏輶逰遊邮郵鈾铀駀魷鮋鱿鲉𬨎","xū":"偦墟媭嬃楈欨歔燸疞盱綇縃繻胥蕦虗虚虛蝑裇訏許諝譃谞鑐需須须顼驉鬚魆魖𬣙𦈡","zhā":"偧哳抯挓揸摣樝渣皶觰譇齄齇","cī":"偨疵蠀趀骴髊齹","bī":"偪屄楅毴豍逼鰏鲾鵖","xún":"偱噚寻尋峋巡廵循恂揗攳旬杊栒桪樳洵浔潯燅燖珣璕畃紃荀蟳詢询鄩鱏鱘鲟𬘓𬩽𬍤𬊈","cāi sī":"偲","duān":"偳媏端褍鍴","ǒu":"偶吘嘔耦腢蕅藕𬉼𠙶","tōu":"偷偸鍮","zán zá zǎ":"偺","lǚ lóu":"偻僂","fèn":"偾僨奋奮弅忿愤憤瀵瞓秎粪糞膹鱝鲼","kuǐ guī":"傀","sǒu":"傁叜叟嗾櫢瞍薮藪","zhì sī tí":"傂","sù":"傃僳嗉塐塑夙嫊愫憟榡樎樕殐泝涑溯溸潚潥玊珟璛簌粛粟素縤肃肅膆蔌藗觫訴謖诉谡趚蹜速遡遬鋉餗驌骕鱐鷫鹔𫗧","xiā":"傄煆瞎虲谺颬鰕","yuàn yuán":"傆媛","rǒng":"傇冗宂氄軵","nù":"傉怒","yùn":"傊孕恽惲愠慍枟腪蕴薀藴蘊褞貟运運郓鄆酝醖醞韗韞韵韻餫","gòu jiǎng":"傋","mà":"傌嘜榪睰祃禡罵閁駡骂鬕","bàng":"傍塝棒玤稖艕蒡蜯謗谤鎊镑","diān":"傎厧嵮巅巓巔掂攧敁槇滇癫癲蹎顚顛颠齻","táng":"傏唐啺坣堂塘搪棠榶溏漟煻瑭磄禟篖糃糖糛膅膛蓎螗螳赯踼鄌醣鎕隚餹饄鶶䣘","hào":"傐哠恏昊昦晧暠暤暭曍浩淏澔灏灝皓皜皞皡皥耗聕薃號鄗顥颢鰝","xī xì":"傒","shān":"傓删刪剼圸山挻搧柵檆潸澘煽狦珊笘縿羴羶脠舢芟衫跚軕邖閊鯅","qiàn jiān":"傔","què jué":"傕埆","cāng chen":"傖","róng":"傛媶嫆嬫容峵嵘嶸戎搈曧栄榕榮榵毧溶瀜烿熔狨瑢穁絨绒羢肜茙茸荣蓉蝾融螎蠑褣鎔镕駥","tà tàn":"傝","suō":"傞唆嗍嗦娑摍桫梭睃簑簔羧莏蓑趖鮻","dǎi":"傣歹","zài":"傤儎再在扗洅載酨","gǔ":"傦古啒尳愲榖榾汩淈濲瀔牯皷皼盬瞽穀罟羖股脵臌薣蛊蠱詁诂轂逧鈷钴餶馉鼓鼔𦙶","bīn":"傧宾彬斌椕滨濒濱濵瀕繽缤虨豩豳賓賔邠鑌镔霦顮","chǔ":"储儲杵椘楚楮檚濋璴础礎禇處齭齼𬺓","nuó":"傩儺挪梛橠","cān càn":"傪","lěi":"傫儡厽垒塁壘壨櫐灅癗矋磊礨耒蕌蕾藟蘽蠝誄讄诔鑸鸓","cuī":"催凗墔崔嵟慛摧榱獕磪鏙","yōng":"傭嗈墉壅嫞庸廱慵拥擁滽灉牅痈癕癰臃邕郺鄘鏞镛雍雝饔鱅鳙鷛","zāo cáo":"傮","sǒng":"傱嵷怂悚愯慫竦耸聳駷㧐","ào":"傲坳垇墺奡嫯岙岰嶴懊擙澳鏊驁骜","qī còu":"傶","chuǎng":"傸磢闖闯","shǎ":"傻儍","hàn":"傼垾悍憾扞捍撖撼旱晘暵汉涆漢瀚焊猂皔睅翰莟菡蛿蜭螒譀輚釬銲鋎雗頷顄颔駻鶾","zhāng":"傽嫜张張彰慞暲樟漳獐璋章粻蔁蟑遧鄣鏱餦騿鱆麞","yān yàn":"傿墕嬮","piào biāo":"僄骠","liàn":"僆堜媡恋戀楝殓殮湅潋澰瀲炼煉瑓練纞练萰錬鍊鏈链鰊𬶠","màn":"㵘僈墁幔慢曼漫澷熳獌縵缦蔄蘰鄤鏝镘𬜬","tàn tǎn":"僋","yíng":"僌営塋嬴攍楹櫿溁溋滢潆濙濚濴瀅瀛瀠瀯灐灜熒營瑩盁盈禜籝籯縈茔荧莹萤营萦萾蓥藀蛍蝇蝿螢蠅謍贏赢迎鎣","dòng":"働冻凍动動姛戙挏栋棟湩硐胨胴腖迵霘駧","zhuàn":"僎啭囀堟撰灷瑑篆腞蒃襈譔饌馔","xiàng":"像勨向嚮姠嶑曏橡珦缿蟓衖襐象鐌項项鱌","shàn":"僐善墠墡嬗擅敾椫樿歚汕灗疝磰繕缮膳蟮蟺訕謆譱讪贍赡赸鄯鐥饍騸骟鱓鱔鳝𫮃","tuí tuǐ":"僓","zǔn":"僔噂撙譐","pú":"僕匍圤墣濮獛璞瞨穙莆菐菩葡蒱蒲贌酺鏷镤","láo":"僗劳労勞哰崂嶗憥朥浶牢痨癆窂簩醪鐒铹顟髝𫭼","chǎng":"僘厰廠敞昶氅鋹𬬮","guāng":"僙光咣垙姯洸灮炗炚炛烡珖胱茪輄銧黆𨐈","liáo":"僚嘹嫽寥寮尞屪嵺嶚嶛廫憀敹暸橑獠璙疗療竂簝繚缭聊膋膫藔蟟豂賿蹘辽遼飉髎鷯鹩","dèng":"僜凳墱嶝櫈瞪磴覴邓鄧隥","chán zhàn zhuàn":"僝","bō":"僠嶓拨撥播波溊玻癶盋砵碆礡缽菠袰蹳鉢钵餑饽驋鱍𬭛","huì":"僡匯卉喙嘒嚖圚嬒寭屶屷彗彙彚徻恚恵惠慧憓懳晦暳槥橞檅櫘汇泋滙潓烩燴獩璤瞺硊秽穢篲絵繪绘翙翽荟蔧蕙薈薉蟪詯誨諱譓譿讳诲賄贿鐬闠阓靧頮顪颒餯𬤝𬭬","chuǎn":"僢喘舛荈踳","tiě jiàn":"僣","sēng":"僧鬙","xiàn":"僩僴哯垷塪姭娊宪岘峴憲撊晛橌橺涀瀗献獻现現県睍粯糮絤綫線线缐羡羨腺臔臽苋莧誢豏鋧錎限陥陷霰餡馅麲鼸𬀪𪾢","yù jú":"僪","è wū":"僫","tóng zhuàng":"僮","lǐn":"僯凛凜廩廪懍懔撛檁檩澟癛癝","gù":"僱凅固堌崓崮故梏棝牿痼祻錮锢雇顧顾鯝鲴","jiāng":"僵壃姜橿殭江畕疅礓繮缰翞茳葁薑螀螿豇韁鱂鳉","mǐn":"僶冺刡勄悯惽愍慜憫抿敃敏敯泯潣皿笢笽簢蠠閔閩闵闽鰵鳘黽","jìn":"僸凚噤嚍墐壗妗嬧搢晉晋枃殣浕浸溍濅濜烬煡燼琎瑨璶盡祲縉缙荩藎覲觐賮贐赆近进進靳齽","jià jie":"價","qiào":"僺峭帩撬殻窍竅誚诮躈陗鞩韒髚","pì":"僻媲嫓屁澼甓疈譬闢鷿鸊䴙","sài":"僿簺賽赛","chán tǎn shàn":"儃","dāng dàng":"儅当闣","xuān":"儇喧塇媗宣愃愋揎昍暄煊煖瑄睻矎禤箮翧翾萱萲蓒蕿藼蘐蝖蠉諠諼譞谖軒轩鍹駽鰚𫓶𫍽","dān dàn":"儋擔瘅","càn":"儏澯灿燦璨粲薒謲","bīn bìn":"儐","án àn":"儑","tái":"儓坮嬯抬擡檯炱炲籉臺薹跆邰颱鮐鲐","lán":"儖兰囒婪岚嵐幱拦攔斓斕栏欄欗澜瀾灆灡燣燷璼篮籃籣繿葻蓝藍蘫蘭褴襕襤襴襽譋讕谰躝鑭镧闌阑韊𬒗","nǐ yì ài yí":"儗","méng":"儚幪曚朦橗檬氋溕濛甍甿盟礞艨莔萌蕄虻蝱鄳鄸霿靀顭饛鯍鸏鹲𫑡㠓","níng":"儜凝咛嚀嬣柠橣檸狞獰聍聹薴鑏鬡鸋","qióng":"儝卭宆惸憌桏橩焪焭煢熍琼瓊睘穷穹窮竆笻筇舼茕藑藭蛩蛬赹跫邛銎䓖","liè":"儠冽列劣劽埒埓姴峛巤挒捩栵洌浖烈烮煭犣猎猟獵聗脟茢蛚趔躐迾颲鬛鬣鮤鱲鴷䴕𫚭","kuǎng":"儣夼懭","bào":"儤勽報忁报抱曓爆犦菢虣蚫豹鉋鑤铇骲髱鮑鲍","biāo":"儦墂幖彪标標滮瀌熛爂猋瘭磦膘臕謤贆鏢鑣镖镳颮颷飆飇飈飊飑飙飚驫骉髟","zǎn":"儧儹噆攅昝趱趲","háo":"儫嗥嘷噑嚎壕椃毜毫濠獆獔竓籇蚝蠔譹豪","qìng":"儬凊庆慶櫦濪碃磬罄靘","chèn":"儭嚫榇櫬疢衬襯讖谶趁趂齓齔龀","téng":"儯幐滕漛疼籐籘縢腾藤虅螣誊謄邆駦騰驣鰧䲢","lǒng lóng lòng":"儱","chán chàn":"儳","ráng xiāng":"儴勷","huì xié":"儶","luó":"儸攞椤欏猡玀箩籮罗羅脶腡萝蘿螺覼逻邏鏍鑼锣镙饠騾驘骡鸁","léi":"儽嫘檑欙瓃畾縲纍纝缧罍羸蔂蘲虆轠鐳鑘镭雷靁鱩鼺","nàng nāng":"儾","wù wū":"兀","yǔn":"允喗夽抎殒殞狁磒荺賱鈗阭陨隕霣馻齫齳","zān":"兂橵簪簮糌鐕鐟鵤","yuán":"元円原厡厵园圆圎園圓垣塬媴嫄援榞榬橼櫞沅湲源溒爰猨猿笎緣縁缘羱茒薗蝝蝯螈袁褤謜轅辕邍邧酛鈨鎱騵魭鶢鶰黿鼋𫘪","xiōng":"兄兇凶匂匈哅忷恟汹洶胷胸芎訩詾讻","chōng":"充嘃忡憃憧摏沖浺珫罿翀舂艟茺衝蹖㳘","zhào":"兆垗旐曌枛櫂照燳狣瞾笊罀罩羄肁肇肈詔诏赵趙鮡𬶐","duì ruì yuè":"兊兌兑","kè":"克刻勀勊堁娔客恪愙氪溘碦緙缂艐衉課课錁锞騍骒","tù":"兎兔堍迌鵵","dǎng":"党攩欓譡讜谠黨𣗋","dōu":"兜兠唗橷篼蔸","huǎng":"兤奛幌怳恍晄炾熀縨詤謊谎","rù":"入嗕媷扖杁洳溽縟缛蓐褥鳰","nèi":"內氝氞錗","yú shù":"兪","liù lù":"六","han":"兯爳","tiān":"兲天婖添酟靔靝黇","xīng xìng":"兴","diǎn":"典嚸奌婰敟椣点碘蒧蕇踮點","zī cí":"兹","jiān":"兼冿囏坚堅奸姦姧尖幵惤戋戔搛椾樫櫼歼殱殲湔瀐瀸煎熞熸牋瑊睷礛礷笺箋緘縑缄缣肩艰艱菅菺葌蒹蔪蕑蕳虃譼豜鑯雃鞯韀韉餰馢鰔鰜鰹鲣鳒鵑鵳鶼鹣麉","shòu":"兽受售壽夀寿授狩獣獸痩瘦綬绶膄","jì":"兾冀剂剤劑勣坖垍塈妓季寂寄廭彑徛忌悸惎懻技旡既旣暨暩曁梞檕檵洎漃漈瀱痵癠禝稩稷穄穊穧紀継績繋繼继绩罽臮芰茍茤葪蓟蔇薊蘎蘮蘻裚襀覬觊計記誋计记跡跽蹟迹际際霁霽驥骥髻鬾魝魥鯚鯽鰶鰿鱀鱭鲚鲫鵋鷑齌𪟝𬶨𬶭","jiōng":"冂冋坰埛扃蘏蘔駉駫𬳶","mào":"冃冐媢帽愗懋暓柕楙毷瑁皃眊瞀耄茂萺蝐袤覒貌貿贸鄚鄮","rǎn":"冄冉姌媣染珃苒蒅䎃","nèi nà":"内","gāng":"冈冮刚剛堈堽岡掆摃棡牨犅疘綱纲缸罁罡肛釭鎠㭎","cè":"冊册厕厠夨廁恻惻憡敇测測笧策筞筴箣荝萗萴蓛","guǎ":"冎剐剮叧寡","mào mò":"冒","gòu":"冓啂坸垢够夠媾彀搆撀构構煹覯觏訽詬诟購购遘雊","xǔ":"冔喣暊栩珝盨糈詡諿诩鄦醑","mì":"冖冪嘧塓宻密峚幂幎幦怽榓樒櫁汨淧滵漞濗熐羃蔤蜜覓覔覛觅謐谧鼏","yóu yín":"冘","xiě":"写冩藛","jūn":"军君均桾汮皲皸皹碅莙蚐袀覠軍鈞銁銞鍕钧頵鮶鲪麏","mí":"冞擟瀰爢猕獼祢禰縻蒾藌蘪蘼袮詸謎迷醚醾醿釄镾鸍麊麋麛","guān guàn":"冠覌観觀观","měng":"冡勐懵掹猛獴艋蜢蠓錳锰鯭鼆","zhǒng":"冢塚尰歱煄瘇肿腫踵","zuì":"冣嶵晬最栬槜檇檌祽絊罪蕞辠酔酻醉錊","yuān":"冤剈囦嬽寃棩淵渁渆渊渕灁眢肙葾蒬蜎蜵駌鳶鴛鵷鸢鸳鹓鼘鼝","míng":"冥名明暝朙榠洺溟猽眀眳瞑茗螟覭詺鄍銘铭鳴鸣","kòu":"冦叩宼寇扣敂滱窛筘簆蔲蔻釦鷇","tài":"冭太夳忲态態汰汱泰溙肽舦酞鈦钛","féng píng":"冯馮","chōng chòng":"冲","kuàng":"况圹壙岲懬旷昿曠框況爌眖眶矿砿礦穬絋絖纊纩貺贶軦邝鄺鉱鋛鑛黋","lěng":"冷","pàn":"冸判叛沜泮溿炍牉畔盼聁袢襻詊鋬鑻頖鵥","fā":"冹彂沷発發","xiǎn":"冼尟尠崄嶮幰攇显櫶毨灦烍燹狝猃獫獮玁禒筅箲藓蘚蚬蜆譣赻跣鍌险険險韅顕顯㬎","qià":"冾圶帢恰殎洽硈胢髂","jìng chēng":"净凈淨","sōu":"凁嗖廀廋捜搜摉溲獀艘蒐螋鄋醙鎪锼颼飕餿馊騪","měi":"凂媄媺嬍嵄挴毎每浼渼燘美躾鎂镁黣","tú":"凃図图圖圗塗屠峹嵞庩廜徒悇揬涂瘏筡腯荼蒤跿途酴鈯鍎馟駼鵌鶟鷋鷵𬳿","zhǔn":"准凖埻準𬘯","liáng liàng":"凉涼量","diāo":"凋刁刟叼奝弴彫汈琱碉簓虭蛁貂錭雕鮉鯛鲷鵰鼦","còu":"凑湊腠輳辏","ái":"凒啀嘊捱溰癌皑皚","duó":"凙剫夺奪痥踱鈬鐸铎","dú":"凟匵嬻椟櫝殰涜牍牘犊犢独獨瓄皾裻読讀讟豄贕錖鑟韇韣韥騳髑黩黷","jǐ jī":"几","fán":"凡凢凣匥墦杋柉棥樊瀿烦煩燔璠矾礬笲籵緐羳舤舧薠蘩蠜襎蹯釩鐇鐢钒鷭𫔍𬸪","jū":"凥匊娵婮居崌抅挶掬梮椐檋毩毱泃涺狙琚疽砠罝腒艍蜛裾諊跔踘躹陱雎鞠鞫駒驹鮈鴡鶋𬶋","chù chǔ":"処处","zhǐ":"凪劧咫址坧帋恉扺指旨枳止汦沚洔淽疻砋祉秖紙纸芷藢衹襧訨趾軹轵酯阯黹","píng":"凭凴呯坪塀岼帡帲幈平慿憑枰洴焩玶瓶甁竮箳簈缾荓萍蓱蚲蛢評评軿輧郱鮃鲆","kǎi":"凯凱剀剴垲塏恺愷慨暟蒈輆鍇鎧铠锴闓闿颽","gān":"凲坩尲尴尶尷柑泔漧玕甘疳矸竿筸粓肝苷迀酐魐","kǎn qiǎn":"凵","tū":"凸堗嶀捸涋湥痜禿秃突葖鋵鵚鼵㻬","āo wā":"凹","chū":"出初岀摴榋樗貙齣䢺䝙","dàng":"凼圵垱壋档檔氹璗瓽盪瞊砀碭礑簜荡菪蕩蘯趤逿雼𬍡","hán":"函凾含圅娢寒崡晗梒浛涵澏焓琀甝筨蜬邗邯鋡韓韩","záo":"凿鑿","dāo":"刀刂忉氘舠螩釖魛鱽","chuāng":"刅摐牎牕疮瘡窓窗窻","fēn fèn":"分","qiè qiē":"切","kān":"刊勘堪戡栞龕龛","cǔn":"刌忖","chú":"刍厨幮廚橱櫉櫥滁犓篨耡芻蒢蒭蜍蟵豠趎蹰躇躕鉏鋤锄除雏雛鶵","huà huá":"划","lí":"刕剓剺劙厘喱嚟囄嫠孷廲悡梨梸棃漓灕犁犂狸琍璃瓈盠睝离穲竰筣篱籬糎縭缡罹艃荲菞蓠蔾藜蘺蜊蟍蟸蠫褵謧貍醨鋫錅鏫鑗離驪骊鯏鯬鱺鲡鵹鸝鹂黎黧㰀","yuè":"刖嬳岄岳嶽恱悅悦戉抈捳月樾瀹爚玥礿禴篗籆籥籰粤粵蘥蚎蚏説越跀跃躍軏鈅鉞鑰钺閱閲阅鸑鸙黦龠𫐄𬸚","liú":"刘劉嚠媹嵧旈旒榴橊流浏瀏琉瑠瑬璢畄留畱疁瘤癅硫蒥蓅蟉裗鎏鏐鐂镠飀飅飗駠駵騮驑骝鰡鶹鹠麍","zé":"则則啧嘖嫧帻幘択樍歵沢泎溭皟瞔矠礋箦簀舴蔶蠌襗謮賾赜迮鸅齚齰","chuàng chuāng":"创創","qù":"刞厺去閴闃阒麮鼁","bié biè":"別别","páo bào":"刨","chǎn chàn":"刬剗幝","guā":"刮劀桰歄煱瓜胍踻颪颳騧鴰鸹","gēng":"刯庚椩浭焿畊絚羮羹耕菮賡赓鶊鹒","dào":"到噵悼椡檤燾瓙盗盜稲稻纛翿艔菿衜衟軇道","chuàng":"刱剏剙怆愴","kū":"刳哭圐堀枯桍矻窟跍郀骷鮬","duò":"刴剁墯尮惰憜挅桗舵跥跺陊陏飿饳鵽","shuā shuà":"刷","quàn xuàn":"券","chà shā":"刹剎","cì cī":"刺","guì":"刽刿劊劌撌攰昋桂椢槶樻櫃猤禬筀蓕襘貴贵跪鐀鑎鞼鱖鱥","lóu":"剅娄婁廔楼樓溇漊熡耧耬艛蒌蔞蝼螻謱軁遱鞻髅髏𪣻","cuò":"剉剒厝夎挫措棤莝莡蓌逪銼錯锉错","xiāo xuē":"削","kēi kè":"剋尅","là lá":"剌","tī":"剔梯踢銻锑鷈鷉䏲䴘","pōu":"剖","wān":"剜塆壪帵弯彎湾潫灣睕蜿豌","bāo bō":"剝剥","duō":"剟咄哆嚉多夛掇毲畓裰㙍","qíng":"剠勍夝情擎晴暒棾樈檠氰甠硘葝黥","yǎn shàn":"剡","dū zhuó":"剢","yān":"剦嫣崦嶖恹懕懨樮淊淹漹烟焉焑煙珚篶胭臙菸鄢醃閹阉黫","huō":"剨劐吙攉秴耠锪騞𬴃","shèng":"剩剰勝圣墭嵊晠榺橳琞聖蕂貹賸","duān zhì":"剬","wū":"剭呜嗚圬屋巫弙杇歍汙汚污洿烏窏箼螐誈誣诬邬鄔鎢钨鰞鴮","gē":"割哥圪彁戈戓戨歌滒犵肐袼謌鎶鴚鴿鸽","dá zhá":"剳","chuán":"剶暷椽篅舡舩船輲遄","tuán zhuān":"剸漙篿","lù jiū":"剹","pēng":"剻匉嘭怦恲抨梈烹砰軯駍","piāo":"剽勡慓旚犥翲螵飃飄飘魒","kōu":"剾彄抠摳眍瞘芤𫸩","jiǎo chāo":"剿劋勦摷","qiāo":"劁勪墝幧敲橇毃燆硗磽繑趬跷踍蹺蹻郻鄡鄥鍫鍬鐰锹頝","huá huà":"劃","zhā zhá":"劄","pī pǐ":"劈悂","tāng":"劏嘡羰薚蝪蹚鞺鼞","chán":"劖嚵壥婵嬋巉廛棎毚湹潹潺澶瀍瀺煘獑磛緾纏纒缠艬蝉蟐蟬蟾誗讒谗躔鄽酁鋋鑱镵饞馋","zuān":"劗躜躦鉆鑚","mó":"劘嫫嬤嬷尛摹擵橅糢膜藦蘑謨謩谟饃饝馍髍魔魹","zhú":"劚斸曯欘灟炢烛燭爥瘃竹笁笜舳茿蓫蠋蠾躅逐逫钃鱁","quàn":"劝勧勸牶韏","jìn jìng":"劤劲勁","kēng":"劥坑牼硁硜誙銵鍞鏗铿阬","xié liè":"劦","zhù chú":"助","nǔ":"努弩砮胬","shào":"劭卲哨潲紹綤绍袑邵","miǎo":"劰杪淼渺眇秒篎緲缈藐邈","kǒu":"劶口","wā":"劸娲媧屲挖攨洼溛漥瓾畖穵窊窪蛙韈鼃","kuāng":"劻匡匩哐恇洭筐筺誆诓軭邼","hé":"劾咊啝姀峆敆曷柇楁毼河涸渮澕熆皬盇盉盍盒禾篕籺粭翮菏萂覈訸詥郃釛鉌鑉閡闔阂阖鞨頜餄饸魺鹖麧齕龁龢𬌗","gào":"勂吿告峼祮祰禞筶誥诰郜鋯锆","bó bèi":"勃","láng":"勆嫏廊斏桹榔樃欴狼琅瑯硠稂艆蓈蜋螂躴郒郞鋃鎯锒","xūn":"勋勛勲勳嚑坃埙塤壎壦曛燻獯矄纁臐薫薰蘍醺𫄸","juàn juān":"勌瓹","lè lēi":"勒","kài":"勓炌烗鎎","wěng yǎng":"勜","qín":"勤嗪噙嶜庈懃懄捦擒斳檎澿珡琴琹瘽禽秦耹芩芹菦螓蠄鈙鈫雂靲鳹鵭","jiàng":"勥匞匠嵹弜弶摾櫤洚滰犟糡糨絳绛謽酱醤醬","fān":"勫嬏帆幡忛憣旙旛繙翻藩轓颿飜鱕","juān":"勬姢娟捐涓蠲裐鎸鐫镌鹃","tóng dòng":"勭烔燑狪","lǜ":"勴垏嵂律慮氯滤濾爈箻綠繂膟葎虑鑢","chè":"勶坼彻徹掣撤澈烢爡瞮硩聅迠頙㬚","sháo":"勺玿韶","gōu gòu":"勾","cōng":"匆囪囱忩怱悤暰樬漗瑽璁瞛篵繱聡聦聪聰苁茐葱蓯蔥蟌鍯鏓鏦騘驄骢","táo yáo":"匋陶","páo":"匏咆垉庖爮狍袍褜軳鞄麅","dá":"匒妲怛炟燵畣笪羍荙薘蟽詚达迏迖迚逹達鐽靼鞑韃龖龘𫟼","huà huā":"化","běi bèi":"北","nǎo":"匘垴堖嫐恼悩惱瑙碯脑脳腦","chí shi":"匙","fāng":"匚堏方淓牥芳邡鈁錺钫鴋","zā":"匝咂帀沞臜臢迊鉔魳","qiè":"匧厒妾怯悏惬愜挈穕窃竊笡箧篋籡踥鍥锲鯜","zāng cáng":"匨","fěi":"匪奜悱棐榧篚翡蕜誹诽","kuì guì":"匮匱","suǎn":"匴","pǐ":"匹噽嚭圮庀痞癖脴苉銢鴄","qū ōu":"区區","kē qià":"匼","yǎn yàn":"匽棪","biǎn":"匾惼揙碥稨窆藊褊貶贬鴘","nì":"匿堄嫟嬺惄愵昵暱氼眤睨縌胒腻膩逆𨺙","niàn":"卄唸埝廿念惗艌","sà":"卅櫒脎萨蕯薩鈒隡颯飒馺","zú":"卆哫崪族箤足踤镞","shēng":"升呏声斘昇曻枡殅泩湦焺牲珄生甥竔笙聲鉎鍟阩陞陹鵿鼪","wàn":"卍卐忨杤瞣脕腕萬蟃贎輐錽𬇕","huá huà huā":"华華","bēi":"卑悲揹杯桮盃碑藣鵯鹎","zú cù":"卒","dān shàn chán":"单單","nán nā":"南","shuài lǜ":"卛","bǔ bo pú":"卜","kuàng guàn":"卝","biàn":"卞变変峅弁徧忭抃昪汳汴玣艑苄覍諚變辡辧辨辩辫辮辯遍釆𨚕","bǔ":"卟哺捕补補鸔𬷕","zhàn zhān":"占覱","kǎ qiǎ":"卡","lú":"卢嚧垆壚庐廬曥枦栌櫨泸瀘炉爐獹玈瓐盧矑籚纑罏胪臚舮舻艫芦蘆蠦轤轳鈩鑪顱颅馿髗魲鱸鲈鸕鸬黸𬬻","lǔ":"卤塷掳擄樐橹櫓氌滷澛瀂硵磠穞艣艪蓾虏虜鏀鐪鑥镥魯鲁鹵","guà":"卦啩挂掛罣褂詿诖","áng yǎng":"卬","yìn":"印垽堷廕慭憖憗懚洕湚猌癊胤茚酳鮣䲟","què":"却卻塙崅悫愨慤搉榷燩琷皵确確礭闋阕鵲鹊𬒈","luǎn":"卵","juàn juǎn":"卷巻","chǎng ān hàn":"厂","wěi yán":"厃","tīng":"厅厛听庁廰廳汀烃烴綎耓聴聼聽鞓𬘩","zhé zhái":"厇","hàn àn":"厈屽","yǎ":"厊唖庌痖瘂蕥","shè":"厍厙弽慑慴懾摂欇涉涻渉滠灄社舎蔎蠂設设赦騇麝","dǐ":"厎呧坘弤抵拞掋牴砥菧觝詆诋軧邸阺骶鯳","zhǎ zhǎi":"厏","páng":"厐嫎庞徬舽螃逄鰟鳑龎龐","zhì shī":"厔","máng":"厖吂哤娏忙恾杗杧汒浝牻痝盲硭笀芒茫蘉邙釯鋩铓駹","zuī":"厜樶纗蟕","shà xià":"厦廈","áo":"厫嗷嗸廒敖滶獒獓璈翱翶翺聱蔜螯謷謸遨鏖隞鰲鳌鷔鼇","lán qiān":"厱","sī mǒu":"厶","gōng hóng":"厷","lín miǎo":"厸","qiú róu":"厹","dū":"厾嘟督醏","xiàn xuán":"县縣","cān shēn cēn sān":"参參叄叅","ài yǐ":"叆","chā chà chǎ chá":"叉","shuāng":"双孀孇欆礵艭雙霜騻驦骦鷞鸘鹴","shōu":"収收","guái":"叏","bá":"叐妭抜拔炦癹胈茇菝詙跋軷魃鼥","fā fà":"发","zhuó yǐ lì jué":"叕","qǔ":"取娶竬蝺詓齲龋","jiǎ xiá":"叚徦","wèi yù":"叞尉蔚","dié":"叠垤堞峌幉恎惵戜曡殜氎牃牒瓞畳疂疉疊碟絰绖耊耋胅艓苵蜨蝶褋詄諜谍跮蹀迭镻鰈鲽鴩𫶇","ruì":"叡枘汭瑞睿芮蚋蜹銳鋭锐","jù gōu":"句","lìng":"另呤炩蘦","dāo dáo tāo":"叨","zhī zhǐ":"只","jiào":"叫呌嘂嘦噍嬓斍斠滘漖獥珓皭窖藠訆譥趭較轎轿较酵醮釂","zhào shào":"召","kě kè":"可","tái tāi":"台苔","pǒ":"叵尀笸箥鉕钷駊","yè xié":"叶","hào háo":"号","tàn":"叹嘆探歎湠炭碳舕","hōng hóng":"叿","miē":"吀咩哶孭","xū yū yù":"吁","chī":"吃哧喫嗤噄妛媸彨彲摛攡殦瓻痴癡眵瞝笞粚胵蚩螭訵魑鴟鵄鸱黐齝𫄨","xuān sòng":"吅","yāo":"吆喓夭妖幺楆殀祅腰葽訞邀鴁鴢㙘","zǐ":"吇姉姊子杍梓榟橴滓矷秭笫籽紫耔虸訿釨","hé gě":"合鲄","cùn dòu":"吋","tóng tòng":"同","tǔ tù":"吐唋","zhà zhā":"吒奓","xià hè":"吓","ā yā":"吖","ma má mǎ":"吗","lìn":"吝恡悋橉焛甐膦蔺藺賃赁蹸躏躙躪轥閵","tūn":"吞暾朜焞","bǐ pǐ":"吡","qìn":"吢吣唚抋揿搇撳沁瀙菣藽","jiè gè":"吤","fǒu pǐ":"否","ba bā":"吧","dūn":"吨噸墩墪惇撉撴犜獤礅蜳蹾驐","fēn":"吩帉昐朆梤棻氛竕紛纷翂芬衯訜躮酚鈖雰餴饙馚","é huā":"吪","kēng háng":"吭妔","shǔn":"吮","zhī zī":"吱","yǐn shěn":"吲","wú":"吳吴呉墲峿梧橆毋洖浯無珸璑祦芜茣莁蕪蜈蟱譕郚鋙铻鯃鵐鷡鹀鼯","chǎo chāo":"吵","nà nè":"吶","xuè chuò jué":"吷","chuī":"吹炊龡","dōu rú":"吺","hǒu":"吼犼","hōng hǒu ōu":"吽","wú yù":"吾","ya yā":"呀","è e":"呃","dāi":"呆懛獃","mèn qǐ":"呇","hōng":"呍嚝揈灴烘焢硡薨訇谾軣輷轟轰鍧","nà":"呐捺笝納纳肭蒳衲豽貀軜郍鈉钠靹魶","tūn tiān":"呑","fǔ ḿ":"呒嘸","dāi tǎi":"呔","ǒu ōu òu":"呕","bài bei":"呗","yuán yún yùn":"员員","guō":"呙啯嘓埚堝墎崞彉彍懖猓瘑聒蝈蟈郭鈛鍋锅","huá qì":"呚","qiàng qiāng":"呛跄","shī":"呞失尸屍师師施浉湤湿溮溼濕狮獅瑡絁葹蒒蓍虱蝨褷襹詩诗邿釃鉇鍦鯴鰤鲺鳲鳾鶳鸤䴓𫚕","juǎn":"呟埍臇菤錈锩","pěn":"呠翸","wěn mǐn":"呡","ne ní":"呢","ḿ m̀ móu":"呣","rán":"呥嘫然燃繎肰蚦蚺衻袇袡髥髯","tiè chè":"呫","qì zhī":"呮","zǐ cī":"呰","guā gū guǎ":"呱","cī zī":"呲","hǒu xǔ gòu":"呴","hē ā á ǎ à a":"呵","náo":"呶夒峱嶩巎挠撓猱硇蛲蟯詉譊鐃铙","xiā gā":"呷","pēi":"呸怌肧胚衃醅","háo xiāo":"呺","mìng":"命掵","dá dàn":"呾","zuǐ jǔ":"咀","xián gān":"咁","pǒu":"咅哣犃","yǎng yāng":"咉","zǎ zé zhā":"咋","hé hè huó huò hú":"和","hāi":"咍","dā":"咑哒噠墶搭撘耷褡鎝𨱏","kǎ kā":"咔","gū":"咕唂唃姑嫴孤巬巭柧橭沽泒稒笟箍箛篐罛苽菇菰蓇觚軱軲轱辜酤鈲鮕鴣鸪","kā gā":"咖","zuo":"咗","lóng":"咙嚨嶐巃巄昽曨朧栊槞櫳湰滝漋爖珑瓏癃眬矓砻礱礲窿竜聋聾胧茏蘢蠪蠬襱豅鏧鑨霳靇驡鸗龍龒龙","xiàn xián":"咞","qì":"咠唭噐器夡弃憇憩暣棄欫气気氣汔汽泣湆湇炁甈盵矵碛碶磜磧罊芞葺藒蟿訖讫迄鐑","xì dié":"咥","liē liě lié lie":"咧","zī":"咨嗞姕姿孜孳孶崰嵫栥椔淄湽滋澬玆禌秶粢紎緇緕纃缁茊茲葘諮谘貲資赀资赼趑趦輜輺辎鄑鈭錙鍿鎡锱镃頾頿髭鯔鰦鲻鶅鼒齍齜龇","mī":"咪","jī xī qià":"咭","gē luò kǎ lo":"咯","shù xún":"咰","zán zá zǎ zan":"咱","hāi ké":"咳","huī":"咴噅噕婎媈幑徽恢拻挥揮晖暉楎洃瀈灰灳烣睳禈翚翬蘳袆褘詼诙豗輝辉鰴麾㧑","huài shì":"咶","táo":"咷啕桃檮洮淘祹綯绹萄蜪裪迯逃醄鋾鞀鞉饀駣騊鼗𫘦","xián":"咸啣娴娹婱嫌嫺嫻弦挦撏涎湺澖甉痫癇癎絃胘舷藖蚿蛝衔衘誸諴賢贒贤輱醎銜鑦閑闲鷳鷴鷼鹇鹹麙𫍯","è àn":"咹","xuān xuǎn":"咺烜","wāi hé wǒ guǎ guō":"咼","yàn yè yān":"咽","āi":"哀哎埃溾銰鎄锿","pǐn":"品榀","shěn":"哂婶嬸审宷審弞曋渖瀋瞫矤矧覾訠諗讅谂谉邥頣魫","hǒng hōng hòng":"哄","wā wa":"哇","hā hǎ hà":"哈","zāi":"哉栽渽溨災灾烖睵賳","dì diè":"哋","pài":"哌沠派渒湃蒎鎃","gén hěn":"哏","yǎ yā":"哑雅","yuě huì":"哕噦","nián":"哖年秊秥鮎鯰鲇鲶鵇黏","huá huā":"哗嘩","jì jiē zhāi":"哜嚌","mōu":"哞","yō yo":"哟喲","lòng":"哢梇贚","ò ó é":"哦","lī lǐ li":"哩","nǎ na nǎi né něi":"哪","hè":"哬垎壑寉惒焃煂燺爀癋碋翯褐謞賀贺赫靍靎靏鶴鸖鹤","bō pò bā":"哱","zhé":"哲啠喆嚞埑悊摺晢晣歽矺砓磔籷粍虴蛰蟄袩詟謫謺讁讋谪輒輙轍辄辙鮿","liàng láng":"哴","liè lǜ":"哷","hān":"哻憨蚶谽酣頇顸馠魽鼾","hēng hng":"哼","gěng":"哽埂峺挭梗綆绠耿莄郠骾鯁鲠𬒔","chuò yuè":"哾","gě jiā":"哿","bei bài":"唄","hán hàn":"唅","chún":"唇浱湻滣漘犉純纯脣莼蒓蓴醇醕錞陙鯙鶉鹑𬭚","ài āi":"唉","jiá qiǎn":"唊","yán dàn xián":"唌","chē":"唓砗硨莗蛼","wú ńg ń":"唔","zào":"唕唣噪慥梍灶煰燥皁皂竃竈簉艁譟趮躁造𥖨","dí":"唙啇嘀嚁嫡廸敌敵梑涤滌狄笛籴糴苖荻蔋蔐藡覿觌豴迪靮頔馰髢鸐𬱖","gòng hǒng gǒng":"唝嗊","dóu":"唞","lào láo":"唠嘮憦","huàn":"唤喚奂奐宦嵈幻患愌换換擐攌梙槵浣涣渙漶澣烉焕煥瑍痪瘓睆肒藧豢轘逭鯇鯶鰀鲩","léng":"唥塄楞碐薐","wō wěi":"唩","fěng":"唪覂諷讽","yín jìn":"唫","hǔ xià":"唬","wéi":"唯围圍壝峗峞嵬帏帷幃惟桅沩洈涠湋溈潍潙潿濰犩矀維维蓶覹违違鄬醀鍏闈闱韋韦鮠𣲗𬶏","shuā":"唰","chàng":"唱怅悵暢焻畅畼誯韔鬯","ér wā":"唲","qiàng":"唴炝熗羻","yō":"唷","yū":"唹淤瘀盓箊紆纡込迂迃陓","lài":"唻濑瀨瀬癞癩睐睞籁籟藾賚賴赉赖頼顂鵣","tuò":"唾嶞柝毤毻箨籜萚蘀跅","zhōu zhāo tiào":"啁","kěn":"啃垦墾恳懇肎肯肻豤錹","zhuó zhào":"啅濯","hēng hèng":"啈悙","lín lán":"啉","a ā á ǎ à":"啊","qiāng":"啌嗴嶈戕摤斨枪槍溬牄猐獇羌羗腔蜣謒鏘锖锵","tūn zhūn xiāng duǐ":"啍","wèn":"問妏揾搵璺问顐","cuì qi":"啐","dié shà jié tì":"啑","yuē wā":"啘","zǐ cǐ":"啙","bǐ tú":"啚","chuò chuài":"啜","yǎ yā è":"啞","fēi":"啡婓婔扉暃渄猆緋绯裶霏非靟飛飝飞餥馡騑騛鯡鲱𬴂","pí":"啤壀枇毗毘焷琵疲皮篺罴羆脾腗膍蚍蚽蜱螷蠯豼貔郫鈹阰陴隦魮鮍鲏鵧鼙","shá":"啥","lā la":"啦","yīng qíng":"啨","pā":"啪妑舥葩趴","zhě shì":"啫","sè":"啬嗇懎擌栜歮涩渋澀澁濇濏瀒瑟璱瘷穑穡穯繬譅轖銫鏼铯飋","niè":"啮嗫噛嚙囁囓圼孼孽嵲嶭巕帇敜枿槷櫱涅湼痆篞籋糱糵聂聶臬臲蘖蠥讘踂踗踙蹑躡錜鎳鑈鑷钀镊镍闑陧隉顳颞齧𫔶","luō luó luo":"啰囉","tān chǎn tuō":"啴","bo":"啵蔔","dìng":"啶定椗矴碇碠磸聢腚萣蝊訂订錠锭顁飣饤","lāng":"啷","án ān":"啽","kā":"喀擖","yóng yú":"喁","lā lá lǎ":"喇","jiē":"喈喼嗟堦媘接掲擑湝煯疖痎癤皆秸稭脻蝔街謯阶階鞂鶛","hóu":"喉帿猴瘊睺篌糇翭葔鄇鍭餱骺鯸𬭤","dié zhá":"喋","wāi":"喎歪竵","nuò rě":"喏","xù huò guó":"喐","zán":"喒","wō ō":"喔","hú":"喖嘝囫壶壷壺媩弧搰斛楜槲湖瀫焀煳狐猢瑚瓳箶絗縠胡葫蔛蝴螜衚觳醐鍸頶餬鬍魱鰗鵠鶘鶦鹕","huàn yuán xuǎn hé":"喛","xǐ":"喜囍壐屣徙憙枲橲歖漇玺璽矖禧縰葈葸蓰蟢謑蹝躧鈢鉨鉩鱚𬭳𬶮","hē hè yè":"喝","kuì":"喟嘳媿嬇愦愧憒篑簣籄聩聭聵膭蕢謉餽饋馈","zhǒng chuáng":"喠","wéi wèi":"喡為爲","duó zhà":"喥","sāng sàng":"喪","qiáo jiāo":"喬","pèn bēn":"喯","cān sūn qī":"喰","zhā chā":"喳","miāo":"喵","pēn pèn":"喷","kuí":"喹夔奎巙戣揆晆暌楏楑櫆犪睽葵藈蘷虁蝰躨逵鄈鍨鍷頯馗騤骙魁","lou lóu":"喽","zào qiāo":"喿","hè xiāo xiào hù":"嗃","á shà":"嗄","xiù":"嗅岫峀溴珛琇璓秀綉繍繡绣螑袖褎褏銹鏥鏽锈齅","qiāng qiàng":"嗆戗戧蹌蹡","ài yì":"嗌艾","má mǎ ma":"嗎","kè kē":"嗑","dā tà":"嗒鎉","sǎng":"嗓搡磉褬鎟顙颡","chēn":"嗔抻琛瞋諃謓賝郴𬘭","wā gǔ":"嗗","pǎng bēng":"嗙","xián qiǎn qiān":"嗛","lào":"嗠嫪橯涝澇耢耮躼軂酪","wēng":"嗡翁聬螉鎓鶲鹟𬭩","wà":"嗢腽膃袜襪韤","hēi hāi":"嗨","hē":"嗬欱蠚訶诃","zi":"嗭","sǎi":"嗮","ǹg ńg ňg":"嗯","gě":"嗰舸","ná":"嗱拏拿鎿镎","diǎ":"嗲","ài ǎi āi":"嗳","tōng":"嗵樋炵蓪","zuī suī":"嗺","zhē zhè zhù zhe":"嗻","mò":"嗼圽塻墨妺嫼寞帞昩末枺歿殁沫漠爅獏瘼皌眽眿瞐瞙砞礳秣絈纆耱茉莈蓦蛨蟔貃貊貘銆鏌镆陌靺驀魩默黙𬙊","sòu":"嗽瘶","tǎn":"嗿坦忐憳憻暺毯璮菼袒襢醓鉭钽","jiào dǎo":"嘄","kǎi gě":"嘅","shān càn":"嘇","cáo":"嘈嶆曹曺槽漕艚蓸螬褿鏪𥕢","piào":"嘌徱蔈驃","lóu lou":"嘍","gǎ":"尕玍","gǔ jiǎ":"嘏","jiāo xiāo":"嘐","xū shī":"嘘噓","pó":"嘙嚩婆櫇皤鄱","dē dēi":"嘚","ma má":"嘛","lē lei":"嘞","gā gá gǎ":"嘠","sāi":"嘥噻毢腮顋鰓","zuō chuài":"嘬","cháo zhāo":"嘲朝鼂","zuǐ":"嘴噿嶊璻","qiáo qiào":"嘺翹谯","chù xù shòu":"嘼","tān chǎn":"嘽","dàn tán":"嘾弾彈惔澹","hēi mò":"嘿","ě":"噁砨頋騀鵈","fān bo":"噃","chuáng":"噇床牀","cù zā hé":"噈","tūn kuò":"噋","cēng chēng":"噌","dēng":"噔嬁灯燈璒登竳簦艠豋","pū":"噗扑撲攴攵潽炇陠","juē":"噘屩屫撧","lū":"噜嚕撸擼謢","zhān":"噡岾惉旃旜枬栴毡氈氊沾瞻薝蛅詀詹譫谵趈邅閚霑飦饘驙魙鱣鸇鹯𫗴","ō":"噢","zhòu zhuó":"噣","jiào qiào chī":"噭","yuàn":"噮妴怨愿掾瑗禐苑衏裫褑院願","ǎi ài āi":"噯","yōng yǒng":"噰澭","jué xué":"噱","pēn pèn fèn":"噴","gá":"噶尜釓錷钆","xīn hěn hèn":"噷","dāng":"噹澢珰璫筜簹艡蟷裆襠","làn":"嚂滥濫烂燗爁爛爤瓓糷钄","tà":"嚃嚺崉挞搨撻榻橽毾涾澾濌禢粏誻譶蹋蹹躂躢遝錔闒闥闼阘鞜鞳","huō huò ǒ":"嚄","hāo":"嚆茠蒿薅","hè xià":"嚇","xiù pì":"嚊","zhōu chóu":"嚋盩诪","mē":"嚒","chā cā":"嚓","bó pào bào":"嚗","me mèi mò":"嚜","xié hái":"嚡","áo xiāo":"嚣","mō":"嚤摸","pín":"嚬娦嫔嬪玭矉薲蠙貧贫顰颦𬞟","mè":"嚰濹","rǎng rāng":"嚷","lá":"嚹旯","jiáo jué jiào":"嚼","chuò":"嚽娖擉歠涰磭踀輟辍辵辶酫鑡餟齪龊","huān huàn":"嚾","zá cà":"囃","chài":"囆虿蠆袃訍","náng nāng":"囊","zá zàn cān":"囋","sū":"囌櫯甦稣穌窣蘇蘓酥鯂","zèng":"囎熷甑贈赠鋥锃","zá niè yàn":"囐","nāng":"囔","luó luō luo":"囖","wéi guó":"囗","huí":"囘回囬廻廽恛洄痐茴蚘蛔蛕蜖迴逥鮰","nín":"囜您脌","jiǎn nān":"囝","nān":"囡","tuán":"团団團慱抟摶檲糰鏄鷒鷻","tún dùn":"囤坉","guó":"囯囶囻国圀國帼幗慖摑漍聝腘膕蔮虢馘𬇹","kùn":"困涃睏","wéi tōng":"囲","qūn":"囷夋逡","rì":"囸日衵鈤馹驲","tāi":"囼孡胎","pǔ":"圃圑擈普暜樸檏氆浦溥烳諩譜谱蹼鐠镨","quān juàn juān":"圈圏","chuí chuán":"圌","tuǎn":"圕畽疃","lüè":"圙掠略畧稤鋝鋢锊䂮","huán yuán":"圜","luán":"圝圞奱娈孌孪孿峦巒挛攣曫栾欒滦灤癴癵羉脔臠虊銮鑾鵉鸞鸾","tǔ":"土圡釷钍","xū wéi":"圩","dì de":"地嶳","qiān sú":"圱","zhèn":"圳塦挋振朕栚甽眹紖絼纼誫賑赈鋴鎭鎮镇阵陣震鴆鸩","chǎng cháng":"场場塲","qí yín":"圻","jiá":"圿忦恝戞扴脥荚莢蛱蛺裌跲郏郟鋏铗頬頰颊鴶鵊","zhǐ zhì":"坁","bǎn":"坂岅昄板版瓪粄舨蝂鈑钣阪魬","qǐn":"坅寑寝寢昑梫笉螼赾鋟锓","méi fén":"坆","rǒng kēng":"坈","fāng fáng":"坊","fèn bèn":"坋","tān":"坍怹摊擹攤滩灘瘫癱舑貪贪","huài pēi pī péi":"坏","dì làn":"坔","tán":"坛墰墵壇壜婒憛昙曇榃檀潭燂痰磹罈罎藫談譚譠谈谭貚郯醰錟顃","bà":"坝垻壩弝欛灞爸矲覇霸鮁鲅","fén":"坟墳妢岎幩枌棼汾焚燌燓羒羵蒶蕡蚠蚡豮豶轒鐼隫馩魵黂鼖鼢𣸣","zhuì":"坠墜惴甀畷礈綴縋缀缒腏膇諈贅赘醊錣鑆","pō":"坡岥泼溌潑釙鏺钋頗颇䥽","pǎn bàn":"坢","kūn":"坤堃堒崐崑昆晜潉焜熴猑琨瑻菎蜫裈裩褌醌錕锟騉髠髡髨鯤鲲鵾鶤鹍","diàn":"坫垫墊壂奠婝店惦扂橂殿淀澱玷琔电癜簟蜔鈿電靛驔","mù mǔ":"坶","kē kě":"坷軻","xuè":"坹岤桖瀥狘瞲謔谑趐","dǐ chí":"坻柢","lā":"垃柆菈邋","lǒng":"垄垅壟壠拢攏竉陇隴𬕂","mín":"垊姄岷崏捪旻旼民珉琘琝瑉痻盿砇緍緡缗罠苠鈱錉鍲鴖","dòng tóng":"垌峒洞","cí":"垐嬨慈柌濨珁瓷甆磁礠祠糍茨詞词辝辞辤辭雌飺餈鴜鶿鷀鹚","duī":"垖堆塠痽磓鐓鐜鴭","duò duǒ":"垛","duǒ duò":"垜挆","chá":"垞察嵖搽槎檫猹茬茶詧靫𥻗","shǎng":"垧晌樉賞贘赏鋿鏛鑜","shǒu":"垨守手扌艏首","da":"垯繨跶","háng":"垳斻杭筕絎绗航苀蚢裄貥迒頏颃魧","ān ǎn":"垵","xīng":"垶惺星曐煋猩瑆皨篂腥興觪觲謃騂骍鮏鯹","yuàn huán":"垸","bāng":"垹帮幇幚幫捠梆浜邦邫鞤𠳐","póu fú":"垺","cén":"埁岑涔","běng fēng":"埄","dì fáng":"埅","xiá jiā":"埉","mái mán":"埋","làng":"埌崀浪蒗閬㫰","shān yán":"埏","qín jīn":"埐","pǔ bù":"埔","huā":"埖婲椛硴糀花蒊蘤誮錵","suì sù":"埣","pí pì":"埤","qīng zhēng":"埥鲭","wǎn wān":"埦","lǔn":"埨稐𫭢","zhēng chéng":"埩","kōng":"埪崆箜躻錓鵼","cǎi cài":"埰寀采","chù tòu":"埱","běng":"埲琫菶鞛","kǎn xiàn":"埳","yì shì":"埶醳","péi":"培毰裴裵賠赔錇锫阫陪","sào sǎo":"埽","jǐn qīn jìn":"堇","péng bèng":"堋","qiàn zàn jiàn":"堑","àn":"堓屵岸按暗案胺荌豻貋錌闇隌黯","duò huī":"堕墮","huán":"堚寏寰峘桓洹澴獂环環糫繯缳羦荁萈萑豲鍰鐶锾镮闤阛雈鬟鹮𬘫𤩽","bǎo bǔ pù":"堡","máo móu wǔ":"堥","ruán":"堧壖撋","ài è yè":"堨","gèng":"堩暅","méi":"堳塺媒嵋徾攗枚栂梅楣楳槑湄湈煤猸玫珻瑂眉睂禖脄脢腜苺莓葿郿酶鎇镅霉鶥鹛黴","dǔ":"堵琽睹笃篤覩賭赌","féng":"堸綘艂逢","hèng":"堼","chūn":"堾媋旾春暙杶椿槆橁櫄瑃箺萅蝽輴鰆鶞䲠","jiǎng":"塂奖奨奬桨槳獎耩膙蒋蔣講讲顜","huāng":"塃巟慌肓荒衁","duàn":"塅断斷椴段毈煅瑖碫簖籪緞缎腶葮躖鍛锻","tǎ":"塔墖獭獺鮙鰨鳎","wěng":"塕奣嵡攚暡瞈蓊","sāi sài sè":"塞","zàng":"塟弉臓臟葬蔵銺","tián":"塡屇恬沺湉璳甛甜田畋畑碵磌胋闐阗鴫鷆鷏","zhèng":"塣幁政証諍證证诤郑鄭靕鴊","tián zhèn":"填","wēn":"塭昷榲殟温溫瑥瘟蕰豱輼轀辒鎾饂鰛鰮鳁","liù":"塯廇磟翏雡霤餾鬸鷚鹨","hǎi":"塰海烸酼醢","lǎng":"塱朖朗朤烺蓢㮾","bèng":"塴揼泵甏綳蹦迸逬鏰镚","chén":"塵宸尘忱敐敶晨曟栕樄沉煁瘎臣茞莀莐蔯薼螴訦諶軙辰迧鈂陈陳霃鷐麎","ōu qiū":"塸","qiàn jiàn":"塹","zhuān tuán":"塼","shuǎng":"塽慡漺爽縔鏯","shú":"塾婌孰璹秫贖赎","lǒu":"塿嵝嶁甊篓簍","chí":"墀弛持池漦竾筂箎篪茌荎蚳謘貾赿踟迟迡遅遟遲鍉馳驰","shù":"墅庶庻怷恕戍束树樹沭漱潄濖竖竪絉腧荗蒁虪術裋豎述鉥錰鏣霔鶐𬬸","dì zhì":"墆疐","kàn":"墈崁瞰矙磡衎鬫","chěn":"墋夦硶碜磣贂趻踸鍖","zhǐ zhuó":"墌","qiǎng":"墏繈繦羥襁","zēng":"増增憎璔矰磳罾譄鄫鱛䎖","qiáng":"墙墻嫱嬙樯檣漒牆艢蔃蔷蘠","kuài tuí":"墤","tuǎn dǒng":"墥","qiáo què":"墧","zūn dūn":"墫","qiāo áo":"墽","yì tú":"墿","xué bó jué":"壆","lǎn":"壈嬾孄孏懒懶揽擥攬榄欖浨漤灠纜缆罱覧覽览醂顲","huài":"壊壞蘾","rǎng":"壌壤攘爙","làn xiàn":"壏","dǎo":"壔导導岛島嶋嶌嶹捣搗擣槝祷禂禱蹈陦隝隯","ruǐ":"壡桵橤繠蕊蕋蘂蘃","san":"壭","zhuàng":"壮壯壵撞焋状狀","ké qiào":"壳殼","kǔn":"壸壼悃捆梱硱祵稇稛綑裍閫閸阃","mǎng":"壾漭茻莽莾蠎","cún":"壿存","zhǐ zhōng":"夂","gǔ yíng":"夃","jiàng xiáng":"夅降","páng féng fēng":"夆","zhāi":"夈捚摘斋斎榸粂齋","xuàn xiòng":"夐","wài":"外顡","wǎn yuàn wān yuān":"夗","mǎo wǎn":"夘","mèng":"夢夣孟梦癦霥","dà dài":"大","fū fú":"夫姇枎粰","guài":"夬怪恠","yāng":"央姎抰殃泱秧胦鉠鍈雵鴦鸯","hāng bèn":"夯","gǎo":"夰搞杲槀槁檺稁稾稿縞缟菒藁藳","tāo běn":"夲","tóu tou":"头","yǎn tāo":"夵","kuā kuà":"夸誇","jiá jiā gā xiá":"夹","huà":"夻婳嫿嬅崋摦杹枠桦槬樺澅画畫畵繣舙話諙譮话黊","jiā jiá gā xiá":"夾","ēn":"奀恩蒽","dī tì":"奃","yǎn yān":"奄渰","pào":"奅疱皰砲礟礮靤麭","nài":"奈柰渿耐萘褦錼鼐","quān juàn":"奍弮棬","zòu":"奏揍","qì qiè xiè":"契","kāi":"奒开揩鐦锎開","bēn bèn":"奔泍","tào":"套","zàng zhuǎng":"奘","běn":"奙本楍畚翉苯","xùn zhuì":"奞","shē":"奢檨猞畭畲賒賖赊輋𪨶","hǎ pò tǎi":"奤","ào yù":"奥奧澚","yūn":"奫氲氳蒀蒕蝹贇赟𫖳","duǒ chě":"奲","nǚ rǔ":"女","nú":"奴孥笯駑驽","dīng dǐng tiǎn":"奵","tā jiě":"她","nuán":"奻","hǎo hào":"好","fàn":"奿嬎梵汎泛滼瀪犯畈盕笵範范訉販贩軬輽飯飰饭","shuò":"妁搠朔槊烁爍矟蒴鎙鑠铄","fēi pèi":"妃","wàng":"妄忘旺望朢","zhuāng":"妆妝娤庄庒桩梉樁粧糚荘莊装裝","mā":"妈媽","fū yōu":"妋","hài jiè":"妎","dù":"妒妬杜殬渡秺芏荰螙蠧蠹鍍镀靯𬭊","miào":"妙庙庿廟玅竗","fǒu pēi pī":"妚","yuè jué":"妜","niū":"妞","nà nàn":"妠","tuǒ":"妥嫷庹椭楕橢鬌鰖鵎","wàn yuán":"妧","fáng":"妨房肪防魴鲂","nī":"妮","zhóu":"妯碡","zhāo":"妱巶招昭釗鉊鍣钊駋𬬿","nǎi nǐ":"妳","tǒu":"妵敨紏蘣黈","xián xuán xù":"妶","zhí yì":"妷秇","ē":"妸妿婀屙","mèi":"妹媚寐抺旀昧沬煝痗眛睸祙篃蝞袂跊鬽魅","qī qì":"妻","xū xǔ":"姁稰","shān shàn":"姍姗苫釤钐","mán":"姏慲樠蛮蠻謾饅馒鬗鬘鰻鳗","jiě":"姐媎檞毑飷","wěi wēi":"委","pīn":"姘拼礗穦馪驞","huá huó":"姡","jiāo xiáo":"姣","gòu dù":"姤","lǎo mǔ":"姥","nián niàn":"姩","zhěn":"姫屒弫抮昣枕畛疹眕稹縝縥缜聄萙袗裖覙診诊軫轸辴駗鬒","héng":"姮恆恒烆珩胻蘅衡鑅鴴鵆鸻","jūn xún":"姰","kuā hù":"姱","è yà":"姶","xiān shēn":"姺","wá":"娃","ráo rǎo":"娆嬈","shào shāo":"娋","xiē":"娎揳楔歇蝎蠍","wǔ méi mǔ":"娒","chuò lài":"娕","niáng":"娘嬢孃","nà nuó":"娜𦰡","pōu bǐ":"娝","něi suī":"娞","tuì":"娧煺蛻蜕退駾","mǎn":"娨屘満满滿螨蟎襔鏋","wú wù yú":"娪","xī āi":"娭","zhuì shuì":"娷","dōng dòng":"娻","ǎi ái è":"娾","ē ě":"娿","mián":"婂嬵宀杣棉檰櫋眠矈矊矏綿緜绵芇蝒","pǒu péi bù":"婄","biǎo":"婊脿表裱褾諘錶","fù fàn":"婏","wǒ":"婐婑我","ní nǐ":"婗棿","quán juàn":"婘惓","hūn":"婚昏昬棔涽睧睯碈荤葷蔒轋閽阍","qiān jǐn":"婜","wān wà":"婠","lái lài":"婡徕徠","zhōu chōu":"婤","chuò nào":"婥","nüè àn":"婩","hùn kūn":"婫","dàng yáng":"婸","nàn":"婻","ruò chuò":"婼","jiǎ":"婽岬斚斝榎槚檟玾甲胛鉀钾","tōu yú":"婾媮","yù yú":"媀","wéi wěi":"媁","dì tí":"媂珶苐","róu":"媃揉柔渘煣瑈瓇禸粈糅脜腬葇蝚蹂輮鍒鞣騥鰇鶔𫐓","ruǎn nèn":"媆","miáo":"媌嫹描瞄苗鶓鹋","yí pèi":"媐","mián miǎn":"媔","tí shì":"媞惿","duò tuó":"媠沲","ǎo":"媪媼艹芺袄襖镺","chú zòu":"媰","yìng":"媵映暎硬膡鱦","qín shēn":"嫀","jià":"嫁幏架榢稼駕驾","sǎo":"嫂","zhēn zhěn":"嫃","jiē suǒ":"嫅","míng mǐng":"嫇","niǎo":"嫋嬝嬲茑蔦袅裊褭鸟","tāo":"嫍幍弢慆掏搯槄涛滔濤瑫絛縚縧绦詜謟轁鞱韜韬飸饕","biáo":"嫑","piáo piāo":"嫖薸","xuán":"嫙悬懸暶檈漩玄璇璿痃蜁𫠊","màn mān":"嫚","kāng":"嫝嵻康慷槺漮砊穅糠躿鏮鱇𡐓𩾌","hān nǎn":"嫨","nèn":"嫩嫰","zhē":"嫬遮","mā má":"嫲","piè":"嫳","zhǎn":"嫸展搌斩斬琖盏盞輾醆颭飐","xiān yǎn jìn":"嬐","liǎn":"嬚敛斂琏璉羷脸臉蔹蘝蘞裣襝鄻","qióng huán xuān":"嬛","dǒng":"嬞懂箽董蕫諌","cān":"嬠湌爘飡餐驂骖","tiǎo":"嬥宨晀朓窱脁","bí":"嬶荸鼻","liǔ":"嬼柳栁桞桺橮熮珋綹绺罶羀鋶锍","qiān xiān":"孅欦","xié huī":"孈","huān quán":"孉","lí lì":"孋麗","zhú chuò":"孎","kǒng":"孔恐","mā zī":"孖","sūn xùn":"孙孫","bèi bó":"孛誖","yòu niū":"孧","zhuǎn":"孨竱轉","hái":"孩骸","nāo":"孬","chán càn":"孱","bò":"孹檗蘗譒","nái":"孻腉","níng nìng":"宁寍寗寜寧甯","zhái":"宅","tū jiā":"宊","sòng":"宋訟誦讼诵送鎹頌颂餸","ròu":"宍肉譳","zhūn":"宒窀衠諄谆迍","mì fú":"宓","dàng tàn":"宕","wǎn yuān":"宛","chǒng":"宠寵","qún":"宭峮帬羣群裙裠","zǎi":"宰崽","bǎo shí":"宲","jiā jia jie":"家","huāng huǎng":"宺","kuān":"宽寛寬臗鑧髋髖","sù xiǔ xiù":"宿","jié zǎn":"寁","bìng bǐng":"寎","jìn qǐn":"寖","lóu jù":"寠","xiě xiè":"寫","qīn qìn":"寴","cùn":"寸籿","duì":"对対對怼憝懟濧瀩碓祋綐薱譈譵轛队陮","lüè luó":"寽","shè yè yì":"射","jiāng jiàng qiāng":"将","jiāng jiàng":"將浆漿畺","zūn":"尊嶟樽罇遵鐏鱒鳟鶎鷷𨱔","shù zhù":"尌澍","xiǎo":"小晓暁曉皛皢筱筿篠謏𫍲","jié jí":"尐诘鞊","shǎo shào":"少","ěr":"尒尓尔栮毦洱爾珥耳薾衈趰迩邇鉺铒餌饵駬","wāng yóu":"尢","wāng":"尣尩尪尫汪","liào":"尥尦廖撂料炓窷鐐镣𪤗","méng máng lóng páng":"尨","gà":"尬魀","kuì kuǐ":"尯","tuí":"尵弚穨蘈蹪隤頹頺頽颓魋𬯎","yǐn":"尹嶾引朄檃檼櫽淾濥瘾癮粌蘟蚓螾讔赺趛輑鈏靷","chǐ chě":"尺","kāo":"尻髛","jìn jǐn":"尽","wěi yǐ":"尾","niào suī":"尿","céng":"层層嶒驓","diǎo":"屌","píng bǐng bīng":"屏","lòu":"屚漏瘘瘺瘻鏤镂陋","shǔ zhǔ":"属屬","xiè tì":"屟","chè cǎo":"屮","tún zhūn":"屯","nì jǐ":"屰","hóng lóng":"屸","qǐ kǎi":"岂豈","áng":"岇昂昻","gǎng gāng":"岗崗","kě":"岢敤渇渴炣","gǒu":"岣狗玽笱耇耈耉苟豿","tiáo":"岧岹樤祒笤芀萔蓚蓨蜩迢鋚鎥鞗髫鯈鰷鲦齠龆","qū jū":"岨","lǐng":"岭嶺領领","pò":"岶敀洦湐烞珀破砶粕蒪魄","bā kè":"峇","luò":"峈摞洛洜犖珞笿纙荦詻雒駱骆鵅","fù niè":"峊","ěn":"峎","zhì shì":"峙崻","qiǎ":"峠跒酠鞐","qiáo jiào":"峤癄","xié yé":"峫","bū":"峬庯晡誧逋鈽錻钸餔鵏","chóng":"崇崈爞虫蝩蟲褈隀","zú cuì":"崒椊","líng léng":"崚","dòng dōng":"崠","xiáo":"崤洨淆訤誵","pí bǐ":"崥芘","zhǎn chán":"崭嶃嶄","wǎi wēi":"崴","yáng dàng":"崵","shì dié":"崼","yào":"崾曜熎燿矅穾窔筄耀艞药葯薬藥袎覞詏讑靿鷂鹞鼼","kān zhàn":"嵁","hán dǎng":"嵅","qiàn kàn":"嵌","wù máo":"嵍","kě jié":"嵑嶱","wēi wěi":"嵔","kē":"嵙柯棵榼樖牁牱犐珂疴瞌磕礚科稞窠萪薖蚵蝌趷轲醘鈳钶頦顆颗髁","dàng táng":"嵣","róng yíng":"嵤爃","ái kǎi":"嵦","kāo qiāo":"嵪","cuó":"嵯嵳痤矬蒫蔖虘鹺鹾","qiǎn qīn":"嵰","dì dié":"嵽","cēn":"嵾","dǐng":"嵿艼薡鐤頂顶鼎鼑","áo ào":"嶅","pǐ pèi":"嶏","jiào qiáo":"嶠潐","jué guì":"嶡鳜","zhān shàn":"嶦鳣","xiè jiè":"嶰","guī xī juàn":"嶲","rū":"嶿","lì liè":"巁棙爄綟","xī guī juàn":"巂","yíng hōng":"巆","yǐng":"巊廮影摬梬潁瘿癭矨穎郢鐛頴颍颕颖","chǎo":"巐炒煼眧麨","cuán":"巑櫕欑","chuān":"巛川氚瑏穿","jīng xíng":"巠","cháo":"巢巣晁漅潮牊窲罺謿轈鄛鼌","qiǎo":"巧愀髜","gǒng":"巩廾拱拲栱汞珙輁鞏","chà chā chāi cī":"差","xiàng hàng":"巷","shuài":"帅帥蟀","pà":"帊帕怕袙","tǎng nú":"帑","mò wà":"帓","tiē tiě tiè":"帖","zhǒu":"帚晭疛睭箒肘菷鯞","juǎn juàn":"帣","shuì":"帨涗涚睡稅税裞","chóu dào":"帱幬","jiǎn jiān sàn":"帴","shà qiè":"帹","qí jì":"帺荠","shān qiāo shēn":"幓","zhuàng chuáng":"幢","chān chàn":"幨","miè":"幭懱搣滅灭烕礣篾蔑薎蠛衊鑖鱴鴓","gān gàn":"干","bìng bīng":"并幷","jī jǐ":"幾","guǎng ān":"广","guǎng":"広廣犷獷","me":"庅","dùn tún":"庉","bài tīng":"庍","yìng yīng":"应","dǐ de":"底","dù duó":"度","máng méng páng":"庬","bìng píng":"庰","chěng":"庱悜睈逞騁骋","jī cuò":"庴","qǐng":"庼廎檾漀苘請謦请頃顷","guī wěi huì":"廆","jǐn qín":"廑","kuò":"廓扩拡擴濶筈萿葀蛞闊阔霩鞟鞹韕頢鬠","qiáng sè":"廧薔","yǐn yìn":"廴隐隠隱飮飲饮","pò pǎi":"廹迫","nòng lòng":"弄","dì tì tuí":"弟","jué zhāng":"弡","mí mǐ":"弥彌靡","chāo":"弨怊抄欩訬超鈔钞","yi":"弬","shāo":"弰旓烧焼燒筲艄萷蕱輎髾鮹","xuān yuān":"弲","qiáng qiǎng jiàng":"強强","tán dàn":"弹醈","biè":"彆","qiáng jiàng qiǎng":"彊","jì xuě":"彐","tuàn":"彖褖","yuē":"彟曰曱矱","shān xiǎn":"彡","wén":"彣文炆珳瘒繧聞芠蚉蚊螡蟁閺閿闅闦闻阌雯馼駇魰鳼鴍鼤𫘜","péng bāng":"彭","piāo piào":"彯","zhuó bó":"彴","tuǒ yí":"彵","páng fǎng":"彷","wǎng":"彺往徃惘枉棢網网罒罓罔罖菵蛧蝄誷輞辋魍","cú":"徂殂","dài dāi":"待","huái":"徊怀懐懷槐淮耲蘹褢褱踝","wā wàng jiā":"徍","chěng zhèng":"徎","dé děi de":"得","cóng zòng":"從","shì tǐ":"徥","tí chí":"徲鶗鶙","dé":"徳德恴悳惪淂鍀锝","zhǐ zhēng":"徴徵","bié":"徶癿莂蛂襒蹩","chōng zhǒng":"徸","jiǎo jiào":"徼笅筊","lòng lǒng":"徿","qú jù":"忂渠瞿螶","dìng tìng":"忊","gǎi":"忋改","rěn":"忍栠栣秹稔綛荏荵躵","chàn":"忏懴懺硟羼韂顫","tè":"忑慝特蟘鋱铽","tè tēi tuī":"忒","gān hàn":"忓攼","yì qì":"忔","tài shì":"忕","xī liě":"忚","yīng yìng":"応應譍","mǐn wěn mín":"忞忟","sōng zhōng":"忪","yù shū":"忬悆","qí shì":"忯耆","tún zhūn dùn":"忳","qián qín":"忴扲","hún":"忶浑渾餛馄魂鼲","niǔ":"忸扭炄狃紐纽莥鈕钮靵","kuáng wǎng":"忹","kāng hàng":"忼","kài xì":"忾愾","òu":"怄慪","bǎo bào":"怉","mín mén":"怋","zuò zhà":"怍","zěn":"怎","yàng":"怏恙样様樣漾羕詇","kòu jù":"怐","náo niú":"怓","zhēng zhèng":"怔掙钲铮","tiē zhān":"怗","hù gù":"怘","cū jù zū":"怚","sī sāi":"思","yóu chóu":"怞","tū dié":"怢","yōu yào":"怮","xuàn":"怰昡楦泫渲炫琄眩碹絢縼繏绚蔙衒袨贙鉉鏇铉镟颴","xù xuè":"怴","bì pī":"怶","xī shù":"怸","nèn nín":"恁","tiāo yáo":"恌","xī qī xù":"恓","xiào jiǎo":"恔","hū kuā":"恗","nǜ":"恧朒衂衄","hèn":"恨","dòng tōng":"恫","quán zhuān":"恮","è wù ě wū":"恶惡","tòng":"恸慟憅痛衕","yuān juàn":"悁","qiāo qiǎo":"悄","jiè kè":"悈","hào jiào":"悎","huǐ":"悔檓毀毁毇燬譭","mán mèn":"悗鞔","yī yì":"悘衣","quān":"悛箞鐉𨟠","kuī lǐ":"悝","yì niàn":"悥","mèn mēn":"悶","guàn":"悹悺惯慣掼摜樌欟泴涫潅灌爟瓘盥礶祼罆罐貫贯躀遦鏆鑵鱹鸛鹳","kōng kǒng":"悾","lǔn lùn":"惀","guǒ":"惈果椁槨粿綶菓蜾裹褁輠餜馃","yuān wǎn":"惌箢","lán lín":"惏","yù xù":"惐淢","chuò chuì":"惙","hūn mèn":"惛","chǎng tǎng":"惝","suǒ ruǐ":"惢","cǎn":"惨慘憯黪黲䅟","cán":"惭慙慚残殘蚕蝅蠶蠺","dàn dá":"惮憚","rě":"惹","yú tōu":"愉","kài qì":"愒","dàng táng shāng yáng":"愓","chén xìn dān":"愖","kè qià":"愘","nuò":"愞懦懧掿搦榒稬穤糑糥糯諾诺蹃逽鍩锘","gǎn":"感擀敢桿橄澉澸皯秆稈笴芉衦赶趕鱤鳡","còng sōng":"愡","sāi sī sǐ":"愢","gōng gòng hǒng":"愩慐","shuò sù":"愬洬","yáo yào":"愮","huàng":"愰曂榥滉皝皩鎤㿠","zhěng":"愸抍拯整晸","cǎo":"愺艸草騲","xì xié":"慀","cǎo sāo":"慅","xù chù":"慉","qiè qiàn":"慊","cáo cóng":"慒","ào áo":"慠","lián liǎn":"慩梿槤櫣","jìn qín jǐn":"慬","dì chì":"慸","zhí zhé":"慹","lóu lǚ":"慺鷜","còng":"憁謥","zhī zhì":"憄知織织","chēng":"憆摚撐撑晿柽棦橕檉泟浾琤瞠碀緽罉蛏蟶赪赬鏿鐣阷靗頳饓","biē":"憋虌鱉鳖鼈龞","chéng dèng zhèng":"憕","xǐ xī":"憘","duì dùn tūn":"憞","xiāo jiāo":"憢","xián xiàn":"憪","liáo liǎo":"憭燎爎爒","shéng":"憴縄繉繩绳譝","náo nǎo náng":"憹","jǐng jìng":"憼","jǐ jiǎo":"憿","xuān huān":"懁","cǎo sāo sào":"懆","mèn":"懑懣暪焖燜","mèng méng měng":"懜","ài yì nǐ":"懝","méng měng":"懞瞢矒","qí jī jì":"懠","mǒ":"懡","lán xiàn":"懢","yōu yǒu":"懮","liú liǔ":"懰藰","ràng":"懹譲讓让","huān":"懽欢歓歡獾讙貛酄驩鴅鵍","nǎn":"戁揇湳煵腩蝻赧","mí mó":"戂","gàng zhuàng":"戅戆","zhuàng gàng":"戇","xū qu":"戌","xì hū":"戏戯戲","jiá gā":"戛","zéi":"戝蠈賊贼鰂鱡鲗","děng":"戥等","hū xì":"戱","chuō":"戳踔逴","biǎn piān":"扁","shǎng jiōng":"扄","shàn shān":"扇","cái":"才材纔裁財财","zhā zā zhá":"扎","lè lì cái":"扐","bā pá":"扒","dǎ dá":"打","rēng":"扔","fǎn fú":"払","diǎo dí yuē lì":"扚","káng gāng":"扛","yū wū":"扜","yū wū kū":"扝","tuō chǐ yǐ":"扡","gǔ jié xì gē":"扢","dèn":"扥扽","sǎo sào":"扫掃","rǎo":"扰擾隢","xī chā qì":"扱","bān pān":"扳","bā ào":"扷","xī zhé":"扸","zhì sǔn kǎn":"扻","zhǎo":"找沼瑵","kuáng wǎng zài":"抂","hú gǔ":"抇鹄鹘","bǎ bà":"把","dǎn shěn":"抌","nè nì ruì nà":"抐","zhuā":"抓檛簻膼髽","póu":"抔裒","zhé shé zhē":"折","póu pōu fū":"抙捊","pāo":"抛拋脬萢","ǎo ào niù":"抝","lūn lún":"抡掄","qiǎng qiāng chēng":"抢","zhǐ zhǎi":"抧","bù pū":"抪柨","yǎo tāo":"抭","hē hè qiā":"抲","nǐ ní":"抳","pī pēi":"抷","mǒ mò mā":"抹","chōu":"抽犨犫瘳篘","jiā yá":"拁","fú bì":"拂畐鶝","zhǎ":"拃眨砟鮺鲝","dān dàn dǎn":"担","chāi cā":"拆","niān":"拈蔫","lā lá lǎ là":"拉","bàn pàn":"拌","pāi":"拍","līn":"拎","guǎi":"拐枴柺","tuò tà zhí":"拓","ào ǎo niù":"拗","jū gōu":"拘","pīn pàn fān":"拚","bài bái":"拜","bài":"拝敗稗粺薭贁败韛","qiá":"拤","nǐng níng nìng":"拧","zé zhái":"择擇","hén":"拫痕鞎","kuò guā":"括","jié jiá":"拮","nǐn":"拰","shuān":"拴栓閂闩","cún zùn":"拵","zā zǎn":"拶桚","kǎo":"拷攷栲烤考","yí chǐ hài":"拸","cè sè chuò":"拺","zhuài zhuāi yè":"拽","shí shè":"拾","bāi":"挀掰","kuò guāng":"挄","nòng":"挊挵齈","jiào jiāo":"挍敎教","kuà kū":"挎","ná rú":"挐","tiāo tiǎo":"挑","dié shè":"挕","liě":"挘毟","yà yǎ":"挜掗","wō zhuā":"挝","xié jiā":"挟挾","dǎng dàng":"挡擋","zhèng zhēng":"挣正症","āi ái":"挨","tuō shuì":"挩捝","tǐ tì":"挮","suō shā":"挱","sā shā suō":"挲","kēng qiān":"挳摼","bàng péng":"挷","ruó ruá":"挼","jiǎo kù":"捁","wǔ wú":"捂","tǒng":"捅桶筒筩統綂统㛚","huò chì":"捇","tú shū chá":"捈","lǚ luō":"捋","shāo shào":"捎稍","niē":"捏揑","shù sǒng sōu":"捒","yé yú":"捓","jué zhuó":"捔","bù pú zhì":"捗","zùn":"捘銌","lāo":"捞撈粩","sǔn":"损損榫笋筍箰鎨隼","wàn wǎn wān yù":"捥","pěng":"捧淎皏","shě":"捨","fǔ fù bǔ":"捬","dáo":"捯","luò luǒ wǒ":"捰","juǎn quán":"捲","chēn tiǎn":"捵","niǎn niē":"捻","ruó wěi ré":"捼","zuó":"捽昨秨稓筰莋鈼","wò xiá":"捾","qìng qiàn":"掅","póu pǒu":"掊","qiā":"掐葜","pái pǎi":"排","qiān wàn":"掔","yè yē":"掖","niè nǐ yì":"掜","huò xù":"掝","yàn shàn yǎn":"掞","zhěng dìng":"掟","kòng":"控鞚","tuī":"推蓷藬","zōu zhōu chōu":"掫","tiàn":"掭舚","kèn":"掯裉褃","pá":"掱杷潖爬琶筢","guó guāi":"掴","dǎn shàn":"掸撣","chān xiān càn shǎn":"掺","sāo":"掻搔溞繅缫螦騒騷鰠鱢鳋","pèng":"掽椪槰碰踫","zhēng kēng":"揁","jiū yóu":"揂","jiān jiǎn":"揃籛","pì chè":"揊","sāi zǒng cāi":"揌","tí dī dǐ":"提","zǒng sōng":"揔","huáng yóng":"揘","zǎn zuàn":"揝","xū jū":"揟","ké qiā":"揢","chuāi chuǎi chuài tuán zhuī":"揣","dì tì":"揥","lá là":"揦","là":"揧楋溂瓎瘌翋臘蝋蝲蠟辢辣鑞镴鬎鯻𬶟","jiē qì":"揭","chòng dǒng":"揰","dié shé yè":"揲","jiàn qián jiǎn":"揵","yé":"揶爷爺瑘鋣鎁铘","chān":"搀摻攙裧襜覘觇辿鋓","gē gé":"搁擱","lǒu lōu":"搂摟","chōu zǒu":"搊","chuāi":"搋","sūn":"搎槂狲猻荪蓀蕵薞飧飱","róng náng nǎng":"搑","péng bàng":"搒","cuō":"搓瑳磋蹉遳醝","kē è":"搕","nù nuò nòu":"搙","lā xié xiàn":"搚","qiǔ":"搝糗","xiǎn xiān":"搟","jié zhé":"搩","pán bān pó":"搫","bān":"搬攽斑斒班瘢癍肦螁螌褩辬頒颁𨭉","zhì nái":"搱","wā wǎ wà":"搲","huá":"搳撶滑猾蕐螖譁鏵铧驊骅鷨","qiāng qiǎng chēng":"搶","tián shēn":"搷","ná nuò":"搻","èn":"摁","shè niè":"摄攝","bìn":"摈擯殡殯膑臏髌髕髩鬂鬓鬢","shā sà shǎi":"摋","chǎn sùn":"摌","jiū liú liáo jiǎo náo":"摎","féng pěng":"摓","shuāi":"摔","dì tú zhí":"摕","qì jì chá":"摖","sōu sǒng":"摗","liǎn liàn":"摙","gài xì":"摡","hù chū":"摢","tàng":"摥烫燙鐋","nái zhì":"摨","mó mā":"摩","jiāng qiàng":"摪","áo qiáo":"摮","niè chè":"摰","mán màn":"摱","chàn cán":"摲","sè mí sù":"摵","biāo biào":"摽","juē jué":"撅","piē":"撆暼氕瞥","piě piē":"撇","zǎn zān zēn qián":"撍","sā sǎ":"撒","hòng":"撔訌讧闀鬨","héng guàng":"撗","niǎn":"撚撵攆涊焾碾簐蹍蹨躎輦辇","chéng zhěng":"撜","huī wéi":"撝","cāo":"撡操糙","xiāo sōu":"撨","liáo liāo":"撩","cuō zuǒ":"撮","wěi tuǒ":"撱","cuān":"撺攛汆蹿躥鑹镩","qiào yāo jī":"撽","zhuā wō":"撾","lèi léi":"擂","nǎng":"擃攮曩灢","qíng jǐng":"擏","kuǎi":"擓蒯㧟","pǐ bò":"擗","bò bāi":"擘","jù jǐ":"據","mēng":"擝","sǒu sòu":"擞","xǐng":"擤箵醒","cā":"擦","níng nǐng nìng":"擰","zhì jié":"擳","là liè":"擸爉","sòu sǒu":"擻","lì luò yuè":"擽","tī zhāi zhì":"擿","pān":"攀潘眅萠","lèi":"攂泪涙淚禷类纇蘱酹銇錑頛頪類颣","cā sǎ":"攃","jùn pèi":"攈","lì luò":"攊躒","là lài":"攋櫴","lú luó":"攎","zǎn cuán":"攒","xiān jiān":"攕","mí mǐ mó":"攠","zǎn cuán zàn zuān":"攢","zuàn":"攥","lì shài":"攦","lì luǒ":"攭","guǐ guì":"攱","jī qī yǐ":"攲","fàng":"放","wù móu":"敄","chù shōu":"敊","gé guó è":"敋","duó duì":"敓敚","duō què":"敠敪","sàn sǎn":"散","dūn duì":"敦镦","qī yǐ jī":"敧","xiào xué":"敩","shù shǔ shuò":"数數","ái zhú":"敱敳","xiòng xuàn":"敻","zhuó zhú":"斀","yì dù":"斁","lí tái":"斄","fěi fēi":"斐","yǔ zhōng":"斔","dòu dǒu":"斗","wò guǎn":"斡","tǒu tiǎo":"斢","dòu":"斣梪浢痘窦竇脰荳豆逗郖酘閗闘餖饾鬥鬦鬪鬬鬭","yín zhì":"斦","chǎn jiè":"斺","wū yū yú":"於","yóu liú":"斿","páng bàng":"旁","máo mào":"旄","pī bì":"旇","xuán xuàn":"旋","wú mó":"无","zǎo":"早枣栆棗澡璪薻藻蚤","gā":"旮","gàn hàn":"旰","tái yīng":"旲","xū xù":"旴","tūn zhùn":"旽","wù wǔ":"旿","pò pèi":"昢","zòng":"昮猔疭瘲粽糉糭縦","ǎi":"昹毐矮蔼藹譪躷霭靄","huàng huǎng":"晃","xuǎn":"晅癣癬选選","xù kuā":"晇","hǒng":"晎","shài":"晒曬","yūn yùn":"晕煴","shèng chéng":"晟椉盛","jǐng yǐng":"景","shǎn":"晱熌睒覢閃闪陕陝","qǐ dù":"晵","ǎn àn yǎn":"晻","wǎng wàng":"暀","zàn":"暂暫瓉瓒瓚禶襸讃讚賛贊赞蹔鄼錾鏨饡","yùn yūn":"暈","mín mǐn":"暋","dǔ shǔ":"暏","shǔ":"暑曙潻癙糬署薥薯藷蜀蠴襡襩鱪鱰黍鼠鼡","jiǎn lán":"暕","nuǎn":"暖煗餪","bào pù":"暴","xī xǐ":"暿","pù bào":"曝瀑","qū qǔ":"紶","qǔ qū":"曲","gèng gēng":"更","hū hù":"曶雽","zēng céng":"曽橧","céng zēng":"曾竲","cǎn qián jiàn":"朁","qiè hé":"朅","bì pí":"朇禆笓裨","yǒu yòu":"有","bān fén":"朌鳻","fú fù":"服洑","fěi kū":"朏胐","qú xù chǔn":"朐","juān zuī":"朘","huāng máng wáng":"朚","qī jī":"期","tóng chuáng":"朣橦","zhá":"札牐箚蚻譗鍘铡閘闸","zhú shù shú":"朮","shù shú zhú":"术","zhū shú":"朱","pǔ pò pō piáo":"朴","dāo tiáo mù":"朷","guǐ qiú":"朹","xiǔ":"朽滫潃糔","chéng chēng":"朾","zá":"杂沯砸襍雑雜雥韴","yú wū":"杅","gān gǎn":"杆","chā chà":"杈","shān shā":"杉","cūn":"村皴竴膥踆邨","rèn ér":"杒梕","sháo biāo":"杓","dì duò":"杕枤","gū gài":"杚","yí zhì lí duò":"杝","gàng gāng":"杠","tiáo tiāo":"条條","mà mǎ":"杩","sì zhǐ xǐ":"杫","yuán wán":"杬蚖","bèi fèi":"杮","shū duì":"杸","niǔ chǒu":"杻","wò yuè":"枂臒","máo":"枆毛氂渵牦矛罞茅茆蝥蟊軞酕鉾錨锚髦鶜","pī mì":"枈","àng":"枊盎醠","fāng bìng":"枋","hù dǐ":"枑","xín":"枔襑鐔鬵","yāo yǎo":"枖","ě è":"枙","zhī qí":"枝","cōng zōng":"枞樅","xiān zhēn":"枮","tái sì":"枱","gǒu jǔ gōu":"枸","bāo fú":"枹","yì xiè":"枻栧","tuó duò":"柁馱駄驮","yí duò lí":"柂","nǐ chì":"柅","pán bàn":"柈跘","yǎng yàng yāng yīng":"柍","fù fū fǔ":"柎","bǎi bó bò":"柏","mǒu":"某","sháo shào":"柖","zhè":"柘樜浙淛蔗蟅這鷓鹧䗪","yòu yóu":"柚櫾","guì jǔ":"柜","zhà zuò":"柞","dié zhì":"柣眰","zhā zǔ zū":"柤","chá zhā":"查査","āo ào":"柪軪","bā fú pèi bó biē":"柭","duò zuó wù":"柮","bì bié":"柲","zhù chù":"柷","bēi pēi":"柸","shì fèi":"柹","shān zhà shi cè":"栅","lì yuè":"栎櫟","qì qiè":"栔砌","qī xī":"栖蹊","guā kuò":"栝","bīng bēn":"栟","xiào jiào":"校","jiàn zùn":"栫袸","yǒu yù":"栯","hé hú":"核","gēn":"根跟","zhī yì":"栺","gé gē":"格","héng háng":"桁","guàng guāng":"桄","yí tí":"桋荑","sāng":"桑桒槡","jú jié":"桔","yú móu":"桙","ráo náo":"桡橈","guì huì":"桧檜","chén zhèn":"桭","tīng yíng":"桯","bó po":"桲","bèn fàn":"桳","fēng fèng":"桻葑","sù yìn":"梀","tǐng tìng":"梃","xuān juān xié":"梋","tú chá":"梌","āo yòu":"梎","kuǎn":"梡欵款歀","shāo sào":"梢","qín chén cén":"梣","lí sì qǐ":"梩","chān yán":"梴","bīn bīng":"梹槟檳","táo chóu dào":"梼","cōng sōng":"棇","gùn hùn":"棍","dé zhé":"棏","pái bèi pèi":"棑","bàng pǒu bèi bēi":"棓","dì dài tì":"棣","sēn":"森椮槮襂","rěn shěn":"棯","léng lēng líng":"棱","fú sù":"棴","zōu sǒu":"棷","zōu":"棸箃緅諏诹邹郰鄒鄹陬騶驺鯫鲰黀齱齺","zhào zhuō":"棹","chēn shēn":"棽","jiē qiè":"椄","yǐ yī":"椅","chóu zhòu diāo":"椆","qiāng kōng":"椌","zhuī chuí":"椎","bēi pí":"椑","mēn":"椚","quān juàn quán":"椦","duǒ chuán":"椯","wěi huī":"椲","jiǎ jiā":"椵","hán jiān":"椷","shèn zhēn":"椹","yàn yà":"椻","zhā chá":"楂","guō kuǎ":"楇","jí zhì":"楖","kǔ hù":"楛","yóu yǒu":"楢","sǒng cōng":"楤","yuán xuàn":"楥","yǎng yàng yīng":"楧","pián":"楩胼腁賆蹁駢騈骈骿㛹","dié yè":"楪","dùn shǔn":"楯","còu zòu":"楱","dì dǐ shì":"楴","kǎi jiē":"楷","róu ròu":"楺","lè yuè":"楽","wēn yùn":"榅鞰","lǘ":"榈櫚氀膢藘閭闾驢驴","shén":"榊神鉮鰰𬬹","bī pi":"榌","zhǎn niǎn zhèn":"榐","fú fù bó":"榑","jiàn jìn":"榗","bǎng bàng":"榜","shā xiè":"榝樧","nòu":"槈耨鎒鐞","qiǎn lián xiàn":"槏","gàng":"槓焵焹筻鿍","gāo":"槔槹橰櫜睾篙糕羔臯韟餻高髙鷎鷱鼛","diān zhěn zhēn":"槙","kǎn jiàn":"槛","xí dié":"槢","jī guī":"槣","róng yōng":"槦","tuán shuàn quán":"槫","qì sè":"槭","cuī zhǐ":"槯","yǒu chǎo":"槱","màn wàn":"槾","lí chī":"樆","léi lěi":"樏櫑礌","cháo jiǎo chāo":"樔","chēng táng":"樘","jiū liáo":"樛","mó mú":"模","niǎo mù":"樢","héng hèng":"横橫","xuě":"樰膤艝轌雪鱈鳕","fá fèi":"橃","rùn":"橍润潤膶閏閠闰","zhǎn jiǎn":"橏","shùn":"橓瞚瞬舜蕣順顺鬊","tuí dūn":"橔","táng chēng":"橖","sù qiū":"橚","tán diàn":"橝","fén fèn fèi":"橨","rǎn yān":"橪","cū chu":"橻","shū qiāo":"橾","píng bò":"檘","zhái shì tú":"檡","biǎo biāo":"檦","qiān lián":"檶","nǐ mí":"檷","jiàn kǎn":"檻","nòu ruǎn rú":"檽","jī jì":"櫅禨","huǎng guǒ gǔ":"櫎","lǜ chū":"櫖","miè mèi":"櫗","ōu":"櫙欧歐殴毆瓯甌膒藲謳讴鏂鴎鷗鸥","zhù zhuó":"櫡","jué jì":"櫭","huái guī":"櫰","chán zhàn":"欃","wéi zuì":"欈","cáng":"欌鑶","yù yì":"欥","chù qù xì":"欪","kài ài":"欬","yì yīn":"欭","xì kài":"欯","shuò sòu":"欶","ǎi ēi éi ěi èi ê̄ ế ê̌ ề":"欸","qī yī":"欹","chuā xū":"欻","chǐ chuài":"欼","kǎn qiàn":"欿","kǎn kè":"歁","chuǎn chuán":"歂","yīn yān":"歅","jìn qūn":"歏","pēn":"歕","xū chuā":"歘","xī shè":"歙","liǎn hān":"歛","zhì chí":"歭","sè shà":"歰","sǐ":"死","wěn mò":"歾","piǎo":"殍皫瞟醥顠","qíng jìng":"殑","fǒu bó":"殕","zhí shi":"殖","yè yān yàn":"殗","hūn mèi":"殙","chòu":"殠臰遚","kuì huì":"殨溃潰","cuàn":"殩熶爨窜竄篡簒","yīn yān yǐn":"殷","qìng kēng shēng":"殸","yáo xiáo xiào":"殽","gū gǔ":"毂蛄","guàn wān":"毌","dú dài":"毒","xún xùn":"毥","mú":"毪氁","dòu nuò":"毭","sāi suī":"毸","lu":"氇","sào":"氉瘙矂髞","shì zhī":"氏","dī dǐ":"氐","máng méng":"氓","yáng rì":"氜","shuǐ":"水氵氺閖","zhěng chéng zhèng":"氶","tǔn":"氽","fán fàn":"氾","guǐ jiǔ":"氿","bīn pà pā":"汃","zhuó què":"汋","dà tài":"汏","pìn":"汖牝聘","hàn hán":"汗馯","tu":"汢","tāng shāng":"汤湯","zhī jì":"汥","gàn hán cén":"汵","wèn mén":"汶","fāng pāng":"汸","hǔ huǎng":"汻","niú yóu":"汼","hàng":"沆","shěn chén":"沈","dùn zhuàn":"沌","nǜ niǔ":"沑","méi mò":"沒没","tà dá":"沓","mì wù":"沕","hóng pāng":"沗","shā shà":"沙","zhuǐ zǐ":"沝","ōu òu":"沤漚","jǔ jù":"沮","tuō duó":"沰","mǐ lì":"沵","yí chí":"沶","xiè yì":"泄","bó pō":"泊","mì bì":"泌秘","chù shè":"泏","yōu yòu āo":"泑","pēng píng":"泙硑","pào pāo":"泡","ní nì":"泥秜","yuè sà":"泧","jué xuè":"泬疦","lóng shuāng":"泷瀧","luò pō":"泺濼","zé shì":"泽澤","sǎ xǐ":"洒","sè qì zì":"洓","xǐ xiǎn":"洗","kǎo kào":"洘","àn yàn è":"洝","lěi lèi":"洡","qiè jié":"洯","qiǎn jiān":"浅","jì jǐ":"济済濟纪","hǔ xǔ":"浒滸","jùn xùn":"浚濬","yǐng chéng yíng":"浧","liàn lì":"浰","féng hóng":"浲溄","jiǒng jiōng":"浻","suī něi":"浽","yǒng chōng":"涌","tūn yūn":"涒","wō guō":"涡渦","hēng":"涥脝","zhǎng zhàng":"涨漲","shòu tāo":"涭","shuàn":"涮腨","kōng náng":"涳","wò wǎn yuān":"涴","tuō tuò":"涶","wō":"涹猧窝窩莴萵蜗蝸踒","qiè jí":"淁","guǒ guàn":"淉","lín lìn":"淋獜疄","tǎng chǎng":"淌","nào chuò zhuō":"淖","péng píng":"淜","féi":"淝肥腓蜰","pì pèi":"淠","niǎn shěn":"淰","biāo hǔ":"淲","chún zhūn":"淳","hùn hún":"混","qiǎn":"淺繾缱肷膁蜸譴谴遣鑓","wèn mín":"渂","rè ruò luò":"渃","dú dòu":"渎瀆读","jiàn jiān":"渐溅漸濺","miǎn shéng":"渑澠","nuǎn nuán":"渜","qiú wù":"渞","tíng tīng":"渟","dì tí dī":"渧","gǎng jiǎng":"港","hōng qìng":"渹","tuān":"湍煓","huì mǐn xū":"湏","xǔ xù":"湑","pén":"湓瓫盆葐","mǐn hūn":"湣","tuàn nuǎn":"湪","qiū jiǎo":"湫湬","yān yīn":"湮","bàn pán":"湴","zhuāng hún":"湷","yàn guì":"溎","lián liǎn nián xián xiàn":"溓","dá tǎ":"溚鿎","liū liù":"溜澑蹓","lùn":"溣","mǎ":"溤犸獁玛瑪码碼遤鎷馬马鰢鷌","zhēn qín":"溱","nì niào":"溺","chù xù":"滀畜","wěng wēng":"滃","hào xuè":"滈","qì xì xiē":"滊","xíng yíng":"滎","zé hào":"滜","piāo piào piǎo":"漂","cóng sǒng":"漎","féng péng":"漨","luò tà":"漯","pēng bēn":"漰","chóng shuāng":"漴","huǒ kuò huò":"漷","liáo liú":"漻","cuǐ cuī":"漼","cóng zǒng":"潀","cóng zōng":"潈","pì piē":"潎","dàng xiàng":"潒","huáng guāng":"潢","liáo lào lǎo":"潦","cōng zòng":"潨","zhí zhì":"潪","tān shàn":"潬","tú zhā":"潳","sàn sǎ":"潵","hēi":"潶黑黒𬭶","chéng dèng":"澄瀓","cūn cún":"澊","péng pēng":"澎","hòng gǒng":"澒銾","wàn màn":"澫","kuài huì":"澮","guō wō":"濄","pēn fén":"濆","jí shà":"濈","huì huò":"濊","dǐng tìng":"濎","mǐ nǐ":"濔","bì pì":"濞","cuì zuǐ":"濢","hù huò":"濩","ǎi kài kè":"濭","wěi duì":"濻瀢","zàn cuán":"濽灒","yǎng yàng":"瀁","wǎng wāng":"瀇","mò miè":"瀎眜","suǐ":"瀡膸髓","huái wāi":"瀤","zùn jiàn":"瀳","yīng yǐng yìng":"瀴","ráng ràng":"瀼","shuàng":"灀","zhuó jiào zé":"灂","sǎ":"灑訯靸","luán luàn":"灓","dǎng tǎng":"灙","xún quán quàn":"灥","huǒ biāo":"灬","zhà yù":"灹","fén bèn":"炃","jiǒng guì":"炅","pàng fēng":"炐","quē":"炔缺缼蒛","biān":"炞煸甂砭笾箯籩編编蝙邉邊鍽鞭鯾鯿鳊","zhāo zhào":"炤","zhuō chù":"炪","pào páo bāo":"炮","páo fǒu":"炰","shǎn qián shān":"炶","zhà zhá":"炸","jiǎo yào":"烄","quǎn":"烇犬犭畎綣绻虇","yàng yáng":"烊","lào luò":"烙","huí huǐ":"烠","rè":"热熱","fú páo":"烰","xiè chè":"烲焎","yàn shān":"烻","hūn xūn":"焄","kào":"焅犒銬铐靠鮳鯌鲓㸆","juān yè":"焆","jùn qū":"焌","tāo dào":"焘","chǎo jù":"焣","wò ài":"焥","zǒng cōng":"焧","xī yì":"焬","xìn xīn":"焮","chāo zhuō":"焯","xiǒng yīng":"焸焽","kuǐ":"煃跬蹞頍𫠆","huī yùn xūn":"煇","jiǎo qiāo":"煍","qián shǎn shān":"煔","xī yí":"煕","shà shā":"煞","yè zhá":"煠","yáng yàng":"煬","ēn yūn":"煾","yūn yǔn":"熅","hè xiāo":"熇","xióng":"熊熋雄","xūn xùn":"熏爋","gòng":"熕貢贡","liū":"熘","cōng zǒng":"熜","lù āo":"熝","shú shóu":"熟","fēng péng":"熢","cuǐ suī":"熣","tēng":"熥膯鼟","yùn yù":"熨","áo āo":"熬","hàn rǎn":"熯","ōu ǒu":"熰","huáng huǎng":"熿","chǎn dǎn chàn":"燀","jiāo zhuó qiáo jué":"燋","yàn yān":"燕","tài liè":"燤","āo":"爊","yàn xún":"爓","jué jiào":"爝覐覚覺觉","lǎn làn":"爦","zhuǎ zhǎo":"爪","zhǎo zhuǎ":"爫","fù fǔ":"父","diē":"爹褺跌","zāng":"牂羘臧賍賘贓贜赃髒","piàn piān":"片","biān miàn":"牑","bǎng":"牓綁绑","yǒu yōng":"牗","chēng chèng":"牚竀","niú":"牛牜","jiū lè":"牞","mù móu":"牟","māng":"牤","gē qiú":"牫","yòu chōu":"牰","tè zhí":"犆","bēn":"犇錛锛","jiān qián":"犍玪","má":"犘痲蔴蟇麻","máo lí":"犛","bá quǎn":"犮","zhuó bào":"犳","àn hān":"犴","kàng gǎng":"犺","pèi fèi":"犻","fān huān":"犿","kuáng":"狂狅誑诳軖軠鵟𫛭","yí quán chí":"狋","xīng shēng":"狌","tuó yí":"狏","kǔ":"狜苦","huán huān":"狟","hé mò":"狢","tà shì":"狧","máng dòu":"狵","xī shǐ":"狶","suān":"狻痠酸","bài pí":"猈","jiān yàn":"猏豣","yī yǐ":"猗","yá wèi":"猚","cāi":"猜","māo máo":"猫貓","chuàn chuān":"猭","tuān tuàn":"猯貒","yà jiá qiè":"猰","hè xiē gé hài":"猲","biān piàn":"猵獱","bó pò":"猼","háo gāo":"獋","fén fèn":"獖","yào xiāo":"獟","shuò xī":"獡","gé liè xiē":"獦","nòu rú":"獳","náo nǎo yōu":"獶","ráng":"獽瓤禳穣穰蘘躟鬤","náo yōu":"獿","lǜ shuài":"率","wáng wàng":"王","yáng chàng":"玚","mín wén":"玟","bīn fēn":"玢","mén yǔn":"玧","qiāng cāng":"玱瑲篬","án gān":"玵","xuán xián":"玹","cī cǐ":"玼跐","yí tāi":"珆","zǔ jù":"珇","fà":"珐琺蕟髪髮","yín kèn":"珢","huī hún":"珲","xuán qióng":"琁","fú fū":"琈","bǐng pín":"琕","cuì sè":"琗","yù wéi":"琟","tiǎn tiàn":"琠","zhuó zuó":"琢","běng pěi":"琣","guǎn":"琯璭痯筦管舘輨錧館馆鳤","hún huī":"琿","xié jiē":"瑎","chàng dàng yáng":"瑒","tiàn zhèn":"瑱","bīn pián":"瑸璸","tú shū":"瑹","cuǐ":"璀皠趡","zǎo suǒ":"璅","jué qióng":"璚","lú fū":"璷","jì zī":"璾","suí":"瓍綏绥遀随隨髄","mí xǐ":"瓕","qióng wěi wèi":"瓗","huán yè yà":"瓛","bó páo":"瓟","zhí hú":"瓡","piáo":"瓢闝","wǎ wà":"瓦","xiáng hóng":"瓨","wèng":"瓮甕罋蕹齆","shèn shén":"甚","ruí":"甤緌蕤","yòng":"用砽苚蒏醟㶲","shuǎi":"甩","béng":"甭甮","yóu zhá":"甴","diàn tián shèng":"甸","tǐng dīng":"町甼","zāi zī":"甾","bì qí":"畁","dá fú":"畗","cè jì":"畟","zāi zī tián":"畠","zhì chóu shì":"畤","fān pān":"畨番","shē yú":"畬","dāng dàng dǎng":"當","jiāng qiáng":"疆","pǐ yǎ shū":"疋","jié qiè":"疌","yí nǐ":"疑","nè":"疒眲訥讷","gē yì":"疙","nüè yào":"疟瘧","lì lài":"疠癘","yǎ xiā":"疨","xuē":"疶蒆薛辥辪靴鞾","dǎn da":"疸","fá biǎn":"疺","fèi féi":"疿痱","shān diàn":"痁","téng chóng":"痋","tōng tóng":"痌","wěi yòu yù":"痏","tān shǐ":"痑","pū pù":"痡鋪","bēng péng":"痭","má lìn":"痳","tiǎn diàn":"痶","ān yè è":"痷","kē ē":"痾","zhì chì":"瘈","jiǎ xiá xiā":"瘕","lěi huì":"瘣","chài cuó":"瘥","diān chēn":"瘨","da dá":"瘩","biě biē":"瘪","qué":"瘸","dàn dān":"癉","guì wēi":"癐","nòng nóng":"癑","biē biě":"癟","bō bǒ":"癷","bái":"白","jí bī":"皀","de dì dí dī":"的","pā bà":"皅","gāo háo":"皋","gāo yáo":"皐","lì luò bō":"皪","zhā cǔ":"皻","zhāo zhǎn dǎn":"皽","jiān jiàn":"监監鋻间鞬","gài gě hé":"盖","máng wàng":"盳","yuǎn":"盶逺遠","tián xián":"盷","xiāng xiàng":"相","dǔn":"盹趸躉","xì pǎn":"盻","shěng xǐng":"省","yún hùn":"眃","miǎn miàn":"眄","kàn kān":"看","yìng yāng yǎng":"眏","yǎo āo ǎo":"眑","jū xū kōu":"眗","yí chì":"眙","dié tì":"眣","bǐng fǎng":"眪","pàng pán":"眫","mī mí":"眯瞇","xuàn shùn xún":"眴","tiào":"眺粜糶覜趒","zhe zhuó zháo zhāo":"着","qiáo shào xiāo":"睄","cuó zhuài":"睉","gùn":"睔謴","suì zuì":"睟","pì bì":"睥稫辟","yì zé gāo":"睪","xǐng xìng":"睲","guì wèi kuì":"瞆","kòu jì":"瞉","qióng huán":"瞏","mán mén":"瞒瞞","diāo dōu":"瞗","lou lóu lǘ":"瞜","shùn rún":"瞤","liào liǎo":"瞭钌","jiàn xián":"瞯","wǔ mí":"瞴","guì kuì":"瞶","nǐng chēng":"矃","huò yuè":"矆","mēng méng":"矇","kuàng guō":"矌","guàn quán":"矔","mǎn mán":"矕","jīn guān qín":"矜","jīn qín guān":"矝","yù xù jué":"矞","jiǎo jiáo":"矫矯","duǎn":"短","shí dàn":"石","gāng qiāng kòng":"矼","huā xū":"砉","pīn bīn fēn":"砏","yán yàn":"研硏","luǒ kē":"砢","fú fèi":"砩笰","zhǔ zhù":"砫","lá lì lā":"砬","kuāng guāng":"硄","gè luò":"硌","shuò shí":"硕碩","wèi wéi ái":"硙","què kè kù":"硞","mǎng bàng":"硥","luò lòng":"硦","yǒng tóng":"硧","nüè":"硸虐","kēng kěng":"硻","yān yǎn":"硽","zhuì chuí duǒ":"硾","kōng kòng":"硿","zòng cóng":"碂","jiān zhàn":"碊","lù liù":"碌陆","què xī":"碏","lún lǔn lùn":"碖","náo gāng":"碙","jié yà":"碣","wèi wěi":"碨","tí dī":"碮","chá chā":"碴","qiāo què":"碻","sù xiè":"碿","liú liù":"磂遛鎦馏","sī tí":"磃","bàng páng":"磅","huá kě gū":"磆","wěi kuǐ":"磈","xiá qià yà":"磍","lián qiān":"磏","wèi ái gài":"磑","lá lā":"磖","áo qiāo":"磝","pēng pèng":"磞閛","yīn yǐn":"磤","lěi léi":"磥","mó mò":"磨","qì zhú":"磩","láo luò":"磱","pán bō":"磻","jí shé":"磼","hé qiāo qiào":"礉","kè huò":"礊","què hú":"礐","è qì":"礘","cǎ":"礤礸","xián xín":"礥","léi lěi lèi":"礧","yán yǎn":"礹","qí zhǐ":"祇蚔","bēng fāng":"祊","bì mì":"祕","suàn":"祘笇筭算蒜","piào piāo":"票","jì zhài":"祭","shuì lèi":"祱","jìn jīn":"禁","chán shàn":"禅","yáng shāng":"禓","zhī zhǐ tí":"禔","shàn chán":"禪","yú yù ǒu":"禺","zǐ zì":"秄","chá ná":"秅","zhǒng zhòng chóng":"种","hào mào":"秏","kù kū":"秙","zū":"租葅","chèng":"秤穪","huó kuò":"秮秳","chēng chèn chèng":"称稱","shì zhì":"秲銴","fù pū":"秿","xùn zè":"稄","tú shǔ":"稌","zhùn zhǔn":"稕","jī qí":"稘綨觭","léng líng":"稜","zuì zú sū":"稡","xì qiè":"稧郄","zhǒng zhòng":"種","zōng zǒng":"稯","xián jiān liàn":"稴","zī jiū":"稵","jī qǐ":"稽","ròng":"穃","shān cǎn cēn":"穇","mén méi":"穈","jǐ jì":"穖","xiāo rào":"穘","zhuō bó":"穛","tóng zhǒng zhòng":"穜","zuō":"穝","biāo pāo":"穮藨","zhuō jué":"穱","cuán zàn":"穳","kōng kòng kǒng":"空","yū yǔ":"穻","zhǎi":"窄鉙","báo":"窇雹","kū zhú":"窋","jiào liáo liù":"窌","wā guī":"窐","tiǎo yáo":"窕","xūn yìn":"窨","yà yē":"窫","tián diān yǎn":"窴","chāo kē":"窼","kuǎn cuàn":"窽窾","chù qì":"竐","qǔ kǒu":"竘","jìng zhěn":"竧","kǎn kàn":"竷","zhú dǔ":"竺","lè jīn":"竻","zhuì ruì":"笍","háng hàng":"笐","cén jìn hán":"笒","dā xiá nà":"笚","zé zuó":"笮","lóng lǒng":"笼篭籠躘龓","zhù zhú":"筑築","dá dā":"答荅","shāi":"筛篩簁籭","yún jūn":"筠","láng làng":"筤郎阆","zhì zhǐ":"筫","o":"筽","póu bù fú pú":"箁","pái bēi":"箄","gè":"箇虼鉻铬","tái chí":"箈","guǎi dài":"箉","zhào dào":"箌","jīng qìng":"箐","lín lǐn":"箖","jùn qūn":"箘","shī yí":"箷釶","yuē yào chuò":"箹","xiāo shuò qiào":"箾","gōng gǎn lǒng":"篢","páng péng":"篣","zhuó huò":"篧","jiǎn jiān":"篯","dí zhú":"篴","zān cēn cǎn":"篸","zhuàn suǎn zuàn":"篹","piǎo biāo":"篻","guó guì":"簂","cè jí":"簎","mì miè":"簚","shāi sī":"簛","sǔn zhuàn":"簨","gàn gǎn":"簳","bò bǒ":"簸","bó bù":"簿","shi":"籂","zhēn jiān":"籈","zhuàn zuǎn":"籑","fān pān biān":"籓","sǒu shǔ":"籔","zuǎn":"籫繤纂纉纘缵","nǚ":"籹釹钕","shā chǎo":"粆","kāng jīng":"粇","fěn":"粉黺","cū":"粗觕麁麄麤","nián zhān":"粘","cè sè":"粣","zhōu yù":"粥","shēn sǎn":"糁","biān biǎn":"糄萹","miàn":"糆面靣麪麫麵麺","hú hū hù":"糊","gǔ gòu":"糓","mí méi":"糜","sǎn shēn":"糝糣","zāo":"糟蹧遭醩","mì sī":"糸","jiū jiǔ":"糺","xì jì":"系繫","zhēng zhěng":"糽","chà chǎ":"紁衩","yuē yāo":"約约","hóng gōng":"紅红","hé gē":"紇纥","wén wèn":"紋纹","fóu":"紑","jì jié jiè":"紒","pī pí bǐ":"紕纰","jīn jìn":"紟","zhā zā":"紥紮","hā":"紦","fū fù":"紨","chōu chóu":"紬","lèi léi lěi":"累","bō bì":"紴","tiǎn zhěn":"紾","jiōng jiǒng":"絅","jié jiē":"結结节","guà kuā":"絓","bǎi mò":"絔","gēng huán":"絙","jié xié":"絜","quán shuān":"絟","gǎi ǎi":"絠","luò lào":"絡络","bīng bēng pēng":"絣","gěi jǐ":"給给","tóng tōng dòng":"絧","tiào diào dào":"絩","lěi lèi léi":"絫","gāi hài":"絯","chī zhǐ":"絺","wèn miǎn mán wàn":"絻","huán huàn wàn":"綄","qīn xiān":"綅","tì tí":"綈","yán xiàn":"綖","zōng zèng zòng":"綜","chēn lín":"綝","zhǔn zhùn":"綧","qiàn qīng zhēng":"綪","qìng qǐ":"綮","lún guān":"綸纶","chuò chāo":"綽绰","tián tǎn chān":"緂","lǜ lù":"緑绿","ruǎn ruàn":"緛","jí qī":"緝","zhòng chóng":"緟重","miáo máo":"緢","xiè yè":"緤","huǎn":"緩缓㬊","gēng gèng":"緪縆","tōu xū shū":"緰","zōng zòng":"緵繌","yùn gǔn":"緷","guā wō":"緺","yùn yūn wēn":"緼縕","bāng bàng":"縍","gǔ hú":"縎鶻","cī cuò suǒ":"縒","cuī shuāi":"縗","róng rǒng ròng":"縙","zài zēng":"縡","cài":"縩菜蔡","féng fèng":"縫","suō sù":"縮缩","yǎn yǐn":"縯酓","zòng zǒng":"縱纵","zhuàn juàn":"縳","mò mù":"縸莫","piǎo piāo":"縹缥","fán pó":"繁","bēng bèng":"繃","móu miù miào liǎo":"繆","yáo yóu zhòu":"繇","zēng zèng":"繒缯","jú jué":"繘","chuō chuò":"繛","zūn zǔn":"繜","rào":"繞绕遶","chǎn chán":"繟","huì huí":"繢缋藱","qiāo sāo zǎo":"繰","jiǎo zhuó":"繳缴","dàn tán chán":"繵","nǒng":"繷","pú fú":"纀","yào lì":"纅","rǎng xiāng":"纕","lí sǎ xǐ lǐ":"纚","xiān qiàn":"纤","jīng jìng":"经","tí tì":"绨","bēng běng bèng":"绷","zōng zèng":"综","jī qī":"缉","wēn yùn yūn":"缊","fèng féng":"缝","shuāi cuī suī":"缞","miù móu liáo miào mù":"缪","qiāo sāo":"缲","fǒu":"缶缹缻雬鴀","bà ba pí":"罢罷","guà guǎi":"罫","yáng xiáng":"羊羏","měi gāo":"羙","yì xī":"羛","qiǎng qiān":"羟","qiāng kòng":"羫","qián xián yán":"羬","nóu":"羺","hóng gòng":"羾","pī bì pō":"翍","qú yù":"翑","ké":"翗","qiào qiáo":"翘","zhái dí":"翟","dào zhōu":"翢","hóu qú":"翵","shuǎ":"耍","ruǎn nuò":"耎","ér nài":"耏","zhuān duān":"耑","pá bà":"耙","chí sì":"耛","qù chú":"耝","lún lǔn":"耣","jí jiè":"耤","tāng tǎng":"耥","pǎng":"耪覫","zhá zé":"耫","yē yé":"耶","yún yíng":"耺","wà tuǐ zhuó":"聉","ér nǜ":"聏","tiē zhé":"聑","dǐ zhì":"聜","qié":"聺","nǐ jiàn":"聻","lèi lē":"肋","cào":"肏襙鄵鼜","bó dí":"肑","xiào xiāo":"肖","dù dǔ":"肚","chāi":"肞釵钗","hán qín hàn":"肣","pàng pán pàn":"肨胖","zhūn chún":"肫","āng":"肮骯","yù yō":"育","pí bǐ bì":"肶","fèi bì":"胇","bèi bēi":"背","fèi zǐ":"胏","píng pēng":"胓苹","fū fú zhǒu":"胕","shèng shēng":"胜","kuà":"胯跨骻","gǎi hǎi":"胲","gē gé gā":"胳","néng nài":"能","guī kuì":"胿","mài mò":"脉","zāng zàng":"脏","jiǎo jué":"脚角","cuǒ":"脞","de te":"脦","zuī juān":"脧","něi":"脮腇餒馁鮾鯘","pú fǔ":"脯","niào":"脲","shuí":"脽","guò":"腂過鐹","là xī":"腊","yān ā":"腌","gāo gào":"膏","lù biāo":"膔","chuái":"膗","zhuān chuán chún zhuǎn":"膞","chuài":"膪踹","fán pán":"膰","wǔ hū":"膴","shān dàn":"膻","tún":"臀臋蛌豘豚軘霕飩饨魨鲀黗","bì bei":"臂","là gé":"臈","sào sāo":"臊","nào":"臑閙闹鬧","ní luán":"臡","qiān xián":"臤","guàng jiǒng":"臦","guǎng jiǒng":"臩","chòu xiù":"臭","mián biān":"臱","dié zhí":"臷","zhī jìn":"臸","shè shě":"舍","pù":"舖舗","bān bō pán":"般","kuā":"舿","gèn gěn":"艮","sè shǎi":"色","fú bó":"艴","jiāo qiú":"艽","chāi chā":"芆","sháo què":"芍","hù xià":"芐","zì zǐ":"芓","huì hū":"芔","tún chūn":"芚","jiè gài":"芥","xù zhù":"芧","yuán yán":"芫","xīn xìn":"芯","lún huā":"芲","wù hū":"芴","gōu gǒu":"芶","mào máo":"芼","fèi fú":"芾","chán yín":"苂","qiē":"苆","sū sù":"苏","tiáo sháo":"苕","lì jī":"苙","kē hē":"苛","jù qǔ":"苣","ruò rě":"若","zhù níng":"苧","pā bó":"苩","xiú":"苬","zhǎ zuó":"苲","jū chá":"苴","nié":"苶","shēng ruí":"苼","qié jiā":"茄","zǐ cí":"茈","qiàn xī":"茜","chǎi":"茝","fá pèi":"茷","ráo":"荛蕘襓饒饶","yíng xíng":"荥","qián xún":"荨蕁","yìn yīn":"荫","hé hè":"荷","shā suō":"莎","péng fēng":"莑","shēn xīn":"莘","wǎn guān guǎn":"莞","yóu sù":"莤","shāo xiāo":"莦蛸","làng liáng":"莨","piǎo fú":"莩","wèn wǎn miǎn":"莬","shì shí":"莳蒔","tù tú":"莵","xiān liǎn":"莶薟","wǎn yù":"菀","zōu chù":"菆","lù lǜ":"菉","jūn jùn":"菌","niè rěn":"菍","zī zì zāi":"菑","tú tù":"菟","jiē shà":"菨","qiáo zhǎo":"菬","tái zhī chí":"菭","fēi fěi":"菲蜚","qín qīn jīn":"菳","zū jù":"菹蒩","lǐn má":"菻","tián tiàn":"菾","tiē":"萜貼贴","luò là lào luō":"落","zhù zhuó zhe":"著","shèn rèn":"葚","gě gé":"葛","jùn suǒ":"葰","kuì kuài":"蒉","rú ná":"蒘","méng mēng měng":"蒙","yuán huán":"蒝","xú shú":"蒣","xí xì":"蒵","mì míng":"蓂","sōu sǒu":"蓃","gài gě hé hài":"蓋","yǎo zhuó":"蓔","diào tiáo dí":"蓧","xū qiū fū":"蓲","zí jú":"蓻","liǎo lù":"蓼","xu":"蓿","hàn hǎn":"蔊","màn wàn mán":"蔓","pó bò":"蔢","fān fán bō":"蕃","hóng hòng":"蕻","yù ào":"薁隩","xí xiào":"薂","báo bó bò":"薄","cí zī":"薋","wàn luàn":"薍","kǎo hāo":"薧","yuǎn wěi":"薳","zhòu chóu":"薵","wō mái":"薶","xiāo hào":"藃","yù xù xū":"藇","jiè jí":"藉","diào zhuó":"藋","cáng zàng":"藏","lǎ":"藞","chú zhū":"藸","pín píng":"蘋","gān hán":"虷","hóng jiàng":"虹","huī huǐ":"虺","xiā há":"虾","mǎ mà mā":"蚂","fāng bàng":"蚄","bàng bèng":"蚌","jué quē":"蚗","qín qián":"蚙","gōng zhōng":"蚣","fǔ fù":"蚥","dài dé":"蚮","gǒu qú xù":"蚼","bǒ pí":"蚾","shé yí":"蛇","tiě":"蛈鉄銕鐡鐵铁驖","gé luò":"蛒","máng bàng":"蛖","yì xǔ":"蛡","há gé":"蛤","qiè ní":"蛪","é yǐ":"蛾","zhē zhé":"蜇","là zhà":"蜡","suò":"蜶逤","yóu qiú":"蝤","xiā hā":"蝦","xī qī":"螇","bī pí":"螕","nài něng":"螚","hé xiá":"螛","guì huǐ":"螝","mǎ mā mà":"螞","shì zhē":"螫","zhì dié":"螲","jiàn chán":"螹","ma má mò":"蟆","mǎng měng":"蟒","biē bié":"蟞","bēn fèi":"蟦","láo liáo":"蟧","yín xún":"蟫","lí lǐ":"蠡","xuè xiě":"血","xíng háng hàng héng":"行","shuāi cuī":"衰","tuó tuō":"袉","lǐng líng":"袊","bào páo pào":"袌","jù jiē":"袓","hè kè":"袔","yí yì":"袘貤","nà jué":"袦","bèi pī":"被","chǐ nuǒ":"袲","chǐ qǐ duǒ nuǒ":"袳","jiá qiā jié":"袷","bó mò":"袹","guī guà":"袿","liè liě":"裂","chéng chěng":"裎","jiē gé":"裓","dāo chóu":"裯","shang cháng":"裳","yuān gǔn":"裷","yǎn ān":"裺","tì xī":"裼","fù fú":"褔","chǔ zhǔ":"褚","tuì tùn":"褪","lǎi":"襰","yào yāo":"要","qín tán":"覃","jiàn xiàn":"見见","piǎn":"覑諞谝貵𡎚","piē miè":"覕","yíng yǐng":"覮","qù qū":"覰覷觑","jiàn biǎn":"覵","luó luǎn":"覶","zī zuǐ":"觜","huà xiè":"觟","jiě jiè xiè":"解觧","xué hù":"觷","lì lù":"觻","tǎo":"討讨","zhùn":"訰","zī zǐ":"訾","yí dài":"詒诒","xiòng":"詗诇","diào tiǎo":"誂","yí chǐ chì":"誃","lǎng làng":"誏","ēi éi ěi èi xī":"誒诶","shuà":"誜","yǔ yù":"語语雨","shuō shuì yuè":"說说","shuí shéi":"誰谁","qū juè":"誳","chī lài":"誺","nì ná":"誽","diào tiáo":"調","pǐ bēi":"諀","jì jī":"諅","zé zuò zhǎ cuò":"諎","chù jí":"諔","háo xià":"諕","lùn lún":"論论","shì dì":"諟","huà guā":"諣","xǐ shāi āi":"諰","nán nàn":"諵難","miù":"謬谬","zèn":"譖谮","shí zhì":"識识","juàn xuān":"讂","yí tuī":"讉","zhán":"讝","xǔ hǔ":"许","xiáng yáng":"详","tiáo diào zhōu":"调","chén shèn":"谌","mí mèi":"谜","màn mán":"谩","gǔ yù":"谷","huō huò huá":"豁","zhì zhài":"豸","huān huán":"貆","kěn kūn":"貇","mò hé":"貈","mò hé háo":"貉","jù lóu":"貗","zé zhài":"責责","dài tè":"貸","bì bēn":"賁","jiǎ gǔ jià":"賈","xiōng mín":"賯","càng":"賶","zhuàn zuàn":"賺赚","wàn zhuàn":"贃","gàn gòng zhuàng":"贛","yuán yùn":"贠","bēn bì":"贲","jiǎ gǔ":"贾","zǒu":"走赱鯐","dié tú":"趃","jū qiè":"趄","qū cù":"趋趨","jí jié":"趌","guā huó":"趏","què qì jí":"趞","tàng tāng":"趟","chuō zhuó":"趠","qù cù":"趣","yuè tì":"趯","bō bào":"趵","kuà wù":"趶","guì jué":"趹","fāng fàng páng":"趽","páo bà":"跁","qí qǐ":"跂","jiàn chén":"跈","pǎo páo":"跑","diǎn diē tiē":"跕","jū jù qiè":"跙","bǒ":"跛","luò lì":"跞","dài duò duō chí":"跢","zhuǎi":"跩","bèng pián":"跰","tiào táo":"跳","shū chōu":"跾","liàng liáng":"踉","tà tā":"踏","chǎ":"蹅鑔镲","dí zhí":"蹢","dēng dèng":"蹬鐙镫","cèng":"蹭","dūn cún":"蹲","juě jué":"蹶","liāo":"蹽","xiè sǎ":"躠","tǐ":"躰軆骵","yà zhá gá":"轧軋","xìn xiàn":"軐","fàn guǐ":"軓","zhuàn zhuǎn":"転","zhóu zhòu":"軸轴","bú":"轐醭鳪","zhuǎn zhuàn zhuǎi":"转","zǎi zài":"载","niǎn zhǎn":"辗","biān bian":"边","dào biān":"辺","yǐ yí":"迆迤迱","guò guo guō":"过","wàng kuāng":"迋","hái huán":"还","zhè zhèi":"这","yuǎn yuàn":"远","zhì lì":"迣","zhù wǎng":"迬","zhuī duī":"追","shì kuò":"适","tòu":"透","tōng tòng":"通","guàng":"逛","dǎi dài":"逮","suì suí":"遂","tí dì":"遆","yí wèi":"遗","shì dí zhé":"適","cà":"遪","huán hái":"還","lí chí":"邌","kàng háng":"邟","nà nèi nā":"那","xié yá yé yú xú":"邪","gāi hái":"郂","huán xún":"郇","chī xī":"郗","hǎo":"郝","lì zhí":"郦","xiáo ǎo":"郩","dōu dū":"都","liǎo":"曢鄝镽","zàn cuán cuó":"酂酇","dīng dǐng":"酊","cù zuò":"酢","fā pō":"酦","shāi shī":"酾","niàng":"酿醸","qiú chōu":"醔","pō fā":"醗醱","chǎn chěn":"醦","yàn liǎn xiān":"醶","niàng niáng":"釀","lǐ li":"里","lí xǐ xī":"釐","liǎo liào":"釕","dīng dìng":"釘钉","qiǎo jiǎo":"釥","yú huá":"釪","huá wū":"釫","rì rèn jiàn":"釰釼","dì dài":"釱","pī zhāo":"釽","yá yé":"釾","bǎ pá":"鈀钯","tā tuó":"鉈铊","běi":"鉳","bǐng píng":"鉼","hā kē":"鉿铪","chòng":"銃铳","xiǎng jiōng":"銄","yù sì":"銉","xù huì":"銊","rén rěn":"銋","shàn shuò":"銏","chì lì":"銐","xiǎn xǐ":"銑铣","hóu xiàng":"銗","diào tiáo yáo":"銚","xiān kuò tiǎn guā":"銛銽铦","zhé niè":"銸","zhōng yōng":"銿","tōu tù dòu":"鋀","méi méng":"鋂","wàn jiǎn":"鋄鎫","tǐng dìng":"鋌铤","juān jiān cuān":"鋑","sī tuó":"鋖","juān xuān juàn":"鋗","wú huá wū":"鋘","zhuó chuò":"鋜","xíng xìng jīng":"鋞","jū jú":"鋦锔","zuì niè":"鋷","yuān yuǎn wǎn wān":"鋺","gāng gàng":"鋼钢","zhuī":"錐锥騅骓鵻","ā":"錒锕","cuō chā":"鎈","suǒ sè":"鎍","yáo zú":"鎐","yè tà gé":"鎑","qiāng chēng":"鎗","gé lì":"鎘镉鬲","bī pī bì":"鎞","gǎo hào":"鎬","zú chuò":"鏃","xiū xiù":"鏅","shòu sōu":"鏉","dí dī":"鏑镝","qiāo sǎn càn":"鏒","lù áo":"鏕","tāng táng":"鏜","jiàn zàn":"鏩","huì suì ruì":"鏸","qiǎng qiāng":"鏹镪","sǎn xiàn sà":"鏾","jiǎn jiàn":"鐧锏","dāng chēng":"鐺铛","zuān zuàn":"鑽","sà xì":"钑","yào yuè":"钥","tǒu dǒu":"钭","zuàn zuān":"钻","qiān yán":"铅","pí pī":"铍","yáo diào tiáo":"铫","tāng tàng":"铴","pù pū":"铺","tán xiān":"锬","liù liú":"镏","hào gǎo":"镐","táng tāng":"镗","tán chán xín":"镡","huò shǎn":"閄","hàn bì":"閈闬","kāng kàng":"閌闶","xián jiàn jiān jiǎn":"閒","xiā xiǎ":"閕","xiǎ kě":"閜","biàn guān":"閞","hé gé":"閤颌","hòng xiàng":"閧","sē xī":"閪","tíng tǐng":"閮","è yān":"閼阏","hòng juǎn xiàng":"闂","bǎn pàn":"闆","dū shé":"闍阇","què quē":"闕","tāng táng chāng":"闛","kàn hǎn":"闞阚","xì sè tà":"闟","mēn mèn":"闷","quē què":"阙","yán diàn":"阽","ā ē":"阿","bēi pō pí":"陂","yàn yǎn":"隁","yú yáo shù":"隃","lóng lōng":"隆","duì zhuì":"隊","suí duò":"隋","gāi qí ái":"隑","huī duò":"隓隳","wěi kuí":"隗","lì dài":"隸","zhuī cuī wéi":"隹","hè hú":"隺鶮","jùn juàn":"隽雋","nán nàn nuó":"难","què qiāo qiǎo":"雀","guàn huán":"雚","guī xī":"雟","sè xí":"雭","án":"雸","wù méng":"雺","tèng":"霯","lù lòu":"露","mái":"霾","jìng liàng":"靚","gé jí":"革","bǎ":"靶","yāng yàng":"鞅","gé tà sǎ":"鞈","biān yìng":"鞕","qiào shāo":"鞘","juān xuān":"鞙","shàng zhǎng":"鞝","pí bǐng bì bēi":"鞞","la":"鞡","xiè dié":"鞢","ēng":"鞥","móu mù":"鞪","bì bǐng":"鞸","mèi wà":"韎","rǒu":"韖","shè xiè":"韘","yùn wēn":"韫","dùn dú":"頓顿","duǐ":"頧","luō":"頱","bīn pín":"頻","yóng":"顒颙鰫","mān":"顢颟","jǐng gěng":"颈","jié xié jiá":"颉","kē ké":"颏","pín bīn":"频","chàn zhàn":"颤","fēng fěng":"風风","biāo diū":"颩","bá fú":"颰","sāo sōu":"颾","liù liáo":"飂","shí sì yì":"食","yǎng juàn":"飬","zhù tǒu":"飳","yí sì":"飴","zuò zé zhā":"飵","tiè":"飻餮","xiǎng náng":"饟","táng xíng":"饧","gē le":"饹","chā zha":"馇","náng nǎng":"馕","yūn wò":"馧","zhī shì":"馶","xìn jìn":"馸","kuài jué":"駃","zǎng":"駔驵","tái dài":"駘","xún xuān":"駨","liáng láng":"駺","piàn":"騗騙骗魸","dài tái":"骀","sāo sǎo":"骚","gǔ gū":"骨","bèi mó":"骳","xiāo qiāo":"骹","bǎng pǎng":"髈","bó jué":"髉","bì pǒ":"髲","máo méng":"髳","kuò yuè":"髺","bā bà":"魞鲃","jì cǐ":"鮆","bó bà":"鮊","zhǎ zhà":"鮓鲊","chóu dài":"鮘","luò gé":"鮥","guī xié wā kuí":"鮭","xiān xiǎn":"鮮鲜","pū bū":"鯆","yì sī":"鯣","bà bó":"鲌","guī xié":"鲑","sāi xǐ":"鳃","niǎo diǎo":"鳥","diāo zhāo":"鳭","gān hàn yàn":"鳱","fū guī":"鳺","jiān qiān zhān":"鳽","hé jiè":"鶡","piān biǎn":"鶣","chuàn zhì":"鶨","cāng qiāng":"鶬","sǔn xùn":"鶽","biāo páo":"麃","zhù cū":"麆","jūn qún":"麇麕","chi":"麶","mó me":"麼","mó me ma":"麽","mí mǒ":"麿","dàn shèn":"黮","zhěn yān":"黰","dǎn zhǎn":"黵","miǎn mǐn měng":"黾","hōu":"齁","nàng":"齉","qí jì zī zhāi":"齐","yín kěn yǎn":"龂","yín kěn":"龈","gōng wò":"龏","guī jūn qiū":"龜龟","kuí wā":"䖯","lōu":"䁖","ōu qū":"𫭟","lóu lǘ":"𦝼","gǎ gā gá":"嘎","wā guà":"坬","zhǐ dǐ":"茋","gǒng hóng":"硔","yáo xiào":"滧"};
})(typeof globalThis !== "undefined" ? globalThis : this);


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
function mvu2shujukuDecodeB64(b){try{var bin=atob(b);var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder("utf-8").decode(bytes);}catch(e){return decodeURIComponent(escape(atob(b)));}}
function mvu2shujukuExpectedTableNames(tpl){var names=[];if(!tpl||typeof tpl!=="object")return names;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(s&&typeof s==="object"&&typeof s.name==="string"&&names.indexOf(s.name)===-1)names.push(s.name);}return names;}
function mvu2shujukuSheetByName(tpl,name){if(!tpl||typeof tpl!=="object")return null;for(var k in tpl){if(k.indexOf("sheet_")===0&&tpl[k]&&tpl[k].name===name)return tpl[k];}return null;}
function mvu2shujukuHasExtraRows(api,tpl){try{var all=api.exportTableAsJson()||{};for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var ts=tpl[k];if(!ts||typeof ts!=="object"||typeof ts.name!=="string")continue;var rs=null;for(var k2 in all){if(k2.indexOf("sheet_")===0&&all[k2]&&all[k2].name===ts.name){rs=all[k2];break;}}if(!rs)continue;var tRows=Array.isArray(ts.content)?ts.content.length-1:0;var rRows=Array.isArray(rs.content)?rs.content.length-1:0;var rSeed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;if(rRows+rSeed>tRows)return true;}return false;}catch(e){return false;}}
function mvu2shujukuTablesSafeToAnchor(api,tpl){try{var all=api.exportTableAsJson()||{};var names=mvu2shujukuExpectedTableNames(tpl);for(var i=0;i<names.length;i++){var name=names[i];var rs=null;for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&all[k].name===name){rs=all[k];break;}}if(!rs)continue;var rows=(Array.isArray(rs.content)?rs.content.length:0)-1;var seed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;var ts=mvu2shujukuSheetByName(tpl,name);var tRows=ts&&Array.isArray(ts.content)?ts.content.length-1:0;if(rows+seed>tRows)return false;if(rows>0&&ts&&Array.isArray(ts.content)&&ts.content[1]&&Array.isArray(rs.content)&&rs.content[1]){var th=ts.content[0]||[];var r1=rs.content[1]||[];for(var ci=1;ci<th.length;ci++){if(String(ts.content[1][ci]==null?"":ts.content[1][ci])!==String(r1[ci]==null?"":r1[ci]))return false;}}}return true;}catch(e){return false;}}
function mvu2shujukuMissingTableNames(api,names){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=true;}var missing=[];for(var i=0;i<names.length;i++){if(!have[names[i]])missing.push(names[i]);}return missing;}
function mvu2shujukuExpectedColumns(tpl){var map={};if(!tpl||typeof tpl!=="object")return map;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(!s||typeof s!=="object"||typeof s.name!=="string")continue;var hdr=Array.isArray(s.content)&&Array.isArray(s.content[0])?s.content[0]:[];var cols=[];for(var i=1;i<hdr.length;i++){if(cols.indexOf(hdr[i])===-1)cols.push(hdr[i]);}map[s.name]=cols;}return map;}
function mvu2shujukuMissingColumns(api,expected){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=all[k];}var mismatch=[];for(var name in expected){var sheet=have[name];if(!sheet)continue;var hdr=Array.isArray(sheet.content)&&Array.isArray(sheet.content[0])?sheet.content[0]:[];var exp=expected[name];for(var i=0;i<exp.length;i++){if(hdr.indexOf(exp[i])===-1){mismatch.push(name+"(缺列:"+exp[i]+")");break;}}}return mismatch;}
var mvu2shujukuInitSessionHung=false;
function mvu2shujukuWithTimeout(promise,ms,label){var done=false;var tid=null;var timeoutPromise=new Promise(function(resolve){tid=setTimeout(function(){if(!done){done=true;resolve({timeout:true,message:label+" 超时("+(ms/1000)+"s)"});}},ms);});return Promise.race([Promise.resolve(promise).then(function(v){if(!done){done=true;if(tid)clearTimeout(tid);}return v;}),timeoutPromise]);}
async function mvu2shujukuEnsureInit(api,b64,presetName,to){var out={status:"skip",message:"",missing:[]};var t1=(to&&to.importMs)||15000;var t2=(to&&to.initMs)||20000;var tpl=null;try{tpl=JSON.parse(mvu2shujukuDecodeB64(b64));}catch(e){out.status="error";out.message="模板解码失败: "+(e&&e.message?e.message:e);return out;}var names=mvu2shujukuExpectedTableNames(tpl);if(!names.length){out.status="error";out.message="模板中没有 sheet_* 表";return out;}out.missing=mvu2shujukuMissingTableNames(api,names);var colMiss=[];var needsImport=out.missing.length>0;if(!needsImport){colMiss=mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));needsImport=colMiss.length>0;}if(!needsImport){var emptyS=[];try{var all2=api.exportTableAsJson()||{};for(var k2 in all2){if(k2.indexOf("sheet_")!==0)continue;var sh2=all2[k2];if(!sh2||typeof sh2!=="object"||typeof sh2.name!=="string")continue;if(Array.isArray(sh2.content)&&sh2.content.length>1)continue;if(Array.isArray(sh2.seedRows)&&sh2.seedRows.length)continue;var ts=mvu2shujukuSheetByName(tpl,sh2.name);if(!ts||!Array.isArray(ts.content)||ts.content.length!==2)continue;emptyS.push(sh2.name);}}catch(e){}if(emptyS.length){for(var ei=0;ei<emptyS.length;ei++){try{var ts2=mvu2shujukuSheetByName(tpl,emptyS[ei]);var hdr2=ts2.content[0];var row2=ts2.content[1];var obj2={};for(var ci=1;ci<hdr2.length;ci++){obj2[hdr2[ci]]=(row2[ci]!==undefined&&row2[ci]!==null)?row2[ci]:"";}await Promise.resolve(api.insertRow(emptyS[ei],obj2));}catch(e){}}out.status="skip";out.message="已为仅表头的单例/JSON表补初始行："+emptyS.join("、");return out;}out.status="skip";out.message="已有全部表格且结构匹配，跳过开局建表";return out;}var steps=[];if(typeof api.importTemplateFromData==="function"){try{var r1=await mvu2shujukuWithTimeout(api.importTemplateFromData(tpl,{scope:"chat",presetName:presetName||""}),t1,"importTemplateFromData");steps.push(r1&&r1.timeout?r1.message:(r1&&r1.success===false?("importTemplateFromData: "+(r1.message||"失败")):"importTemplateFromData: 完成"));}catch(e){steps.push("importTemplateFromData异常: "+(e&&e.message?e.message:e));}}if(typeof api.initGameSession==="function"&&!mvu2shujukuInitSessionHung){try{var r2=await mvu2shujukuWithTimeout(api.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:presetName||""}),t2,"initGameSession");if(r2&&r2.timeout){mvu2shujukuInitSessionHung=true;steps.push("initGameSession: 超时，已跳过后续重试（表已由 importTemplateFromData 创建则无碍）");}else if(r2&&r2.success===false)steps.push("initGameSession: "+(r2.message||"失败"));else steps.push("initGameSession: 完成"+(r2&&r2.runtimeReady===false?"（运行时未就绪）":""));}catch(e){steps.push("initGameSession异常: "+(e&&e.message?e.message:e));}}else if(typeof api.initGameSession!=="function"){steps.push("initGameSession: 不可用（仅 importTemplateFromData）");}out.missing=mvu2shujukuMissingTableNames(api,names);colMiss=out.missing.length?[]:mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));out.status=(out.missing.length||colMiss.length)?"partial":"ok";out.message=steps.join("；")+"；剩余缺表："+(out.missing.length?out.missing.join("、"):"无")+(colMiss.length?"；结构不匹配："+colMiss.join("、"):"");return out;}

    const DB_TEMPLATE_KEY = '__ACU_TEMPLATE_DATA__';
    const autoInitState = { running: false, done: '', inited: false, retries: 0, anchorChat: '', anchorTries: 0, apiRetries: 0 };
    let autoInitNoEntryRetries = 0;

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
        // 仅开局阶段允许重置重建：表数据只是模板行被改动（没有额外新增行，例如开局捏人写入），
        // 重置+重放本次写入是无损的（前端 replaceMvuData 带完整快照）；进入正常对话后绝不重置。
        if (isOpeningPhase() && !mvu2shujukuHasExtraRows(api, tplCached) && !mvu2shujukuInitSessionHung && typeof api.initGameSession === 'function') {
            console.log('[mvu2shujuku][debug][锚点] ' + reason + '：表无额外行（仅模板行被改动），重置重建锚点并重放本次写入…');
            try {
                const r2 = await mvu2shujukuWithTimeout(
                    api.initGameSession({}, { injectTemplate: true, loadPreset: false, templateData: tplCached, templatePresetName: String((currentCharacter() && currentCharacter().name) || '') + '模板' }),
                    20000,
                    'initGameSession(无额外行锚点)'
                );
                const ok2 = !(r2 && r2.success === false) && !(r2 && r2.timeout);
                console.log('[mvu2shujuku][debug][锚点] ' + reason + '：无额外行重建=' + (r2 && r2.timeout ? '超时' : (r2 && r2.success === false ? (r2.message || '失败') : '完成')) + ' | 锚点=' + hasFullShujukuCheckpoint());
                return ok2 && hasFullShujukuCheckpoint();
            } catch (e) {
                console.warn('[mvu2shujuku][debug][锚点] ' + reason + '：无额外行重建异常:', e);
                return false;
            }
        }
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
        if (hasFullShujukuCheckpoint()) return true;
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

    function autoInitChatId() {
        try {
            const context = getContextSafe();
            return String(context.chatId || context.chat_id || context.chatFile || context.chatFileName || 'unknown');
        } catch (e) { return 'unknown'; }
    }

    // 对应 MVU 的 init 时机：进入聊天/收到首条消息时，若卡内有模板且表格缺失则自动建表。
    // 只处理本转换器产出的卡（世界书含 __ACU_TEMPLATE_DATA__），其余卡一律不动。
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
        // 锚点检查：表可能已存在但聊天缺 full checkpoint（开场白切换/首楼
        // 重写会丢锚点），此时继续写库会留下无锚点 artifacts，触发插件 V2 boundary_after_data_mismatch；
        // 用卡内模板重建 initGameSession 把锚点补上（全新聊天由下方 ensureInit 建立，不重复）；
        // 每次进入聊天都会复查，最多重试 3 次，避免 initGameSession 挂起时风暴。
        if (autoInitState.anchorChat !== key) {
            autoInitState.anchorChat = key;
            autoInitState.anchorTries = 0;
        }
        if (autoInitState.anchorTries < 3) {
            try {
                const tplCached = cachedTemplateForCurrentCard();
                const hadCheckpoint = hasFullShujukuCheckpoint();
                console.log('[mvu2shujuku][debug][流程] 开局锚点检查：chat=' + key + ' hasCheckpoint=' + hadCheckpoint + ' tries=' + autoInitState.anchorTries + ' hung=' + mvu2shujukuInitSessionHung);
                if (tplCached && !hadCheckpoint) {
                    autoInitState.anchorTries += 1;
                    await anchorCheckpointIfMissing(api, tplCached, '开局');
                }
            } catch (e) {
                autoInitState.anchorTries += 1;
                console.warn('[mvu2shujuku][debug] 数据库锚点重建异常:', e);
            }
        }
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
                    activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
                    hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                });
                es.on(et.MESSAGE_RECEIVED, () => {
                    hostWindow.setTimeout(autoInitDatabase, 600);
                    // 复刻 MVU：AI 回复后追加状态栏占位符，前端注入正则才能命中每条消息
                    ensureWindowStatusPlaceholder();
                });
                // 开场白切换/首楼换 swipe 会丢掉插件的 full checkpoint：必须立即重建锚点，
                // 否则捏人 UI 的写库会产生无锚点 artifacts，触发插件 V2 boundary_after_data_mismatch。
                // CHAT_CHANGED 只在换聊天时触发，swipe 切换不会触发，所以要单独监听。
                for (const evName of [et.MESSAGE_SWIPED, et.MESSAGE_UPDATED, et.MESSAGE_EDITED]) {
                    if (evName && typeof evName === 'string') {
                        es.on(evName, () => hostWindow.setTimeout(autoInitDatabase, 300));
                    }
                }
                if (et.GENERATION_ENDED) {
                    es.on(et.GENERATION_ENDED, () => {
                        ensureWindowStatusPlaceholder();
                        hostWindow.setTimeout(autoInitDatabase, 100);
                    });
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
        if (cb && Array.isArray(cb.entries) && cb.entries.length) return character;
        console.log('[mvu2shujuku] 角色列表对象缺世界书，尝试 /api/characters/get 取完整卡。avatar=', character.avatar, 'name=', character && character.name);
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
                    const n = await window.MVU2SHUJUKU_CORE.writeStatDiffToDb(api, activeLayout, prev, target);
                    if (n > 0) console.log('[mvu2shujuku][debug] Mvu 合并写入完成：差异 ' + n + ' 条');
                    if (!hasFullShujukuCheckpoint()) {
                        console.warn('[mvu2shujuku][debug][流程] 写库完成后聊天仍无 full checkpoint！若插件随后自动填表提交，可能出现 V2 boundary_after_data_mismatch。');
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

    // 扩展侧提供 window.getAllVariables：用卡内布局 + 插件表格实时重建 stat_data（惰性，零冗余）
    function installWindowGetAllVariables() {
        const core = window.MVU2SHUJUKU_CORE;
        if (typeof window.getAllVariables === 'function') return;
        if (!core || typeof core.statDataFromTables !== 'function') return;
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
        console.log('[mvu2shujuku][debug] 扩展侧已定义 window.getAllVariables（读插件表格重建 stat_data）');
    }

    // 表格更新广播：与 MVU 原版一致，数据库一有变动就广播 VARIABLE_UPDATE_ENDED，
    // 携带更新后的完整变量（before 在无基线时传空，前端结算逻辑会安全跳过）
    function dispatchVariableUpdateEnded(after, before) {
        try {
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
    function applyWindowMvuShim() {
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.writeStatDiffToDb !== 'function') return;
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
                if (oldM && typeof oldM === 'object' && oldM !== windowMvuFake) {
                    const SKIP = { getMvuData: 1, replaceMvuData: 1, setMvuVariable: 1, getMvuVariable: 1, getRecordFromMvuData: 1, parseMessage: 1, reloadInitVar: 1, getCurrentMvuData: 1, replaceCurrentMvuData: 1, isDuringExtraAnalysis: 1, events: 1 };
                    for (const pk in oldM) {
                        if (!Object.prototype.hasOwnProperty.call(oldM, pk)) continue;
                        if (SKIP[pk]) continue;
                        if (windowMvuFake[pk] === undefined) windowMvuFake[pk] = oldM[pk];
                    }
                }
                w.Mvu = windowMvuFake;
            } catch (e) {}
        }
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
            '        <button id="mvu2shujuku-convert-file" class="menu_button" disabled title="先在上方选择“本地文件”来源">转换所选文件</button>',
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
            if (btnCurrent) btnCurrent.style.display = isChar ? '' : 'none';
            if (btnFile) btnFile.style.display = isChar ? 'none' : '';
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
        installWindowGetAllVariables();
        installWindowMvuShim();
        // 表格更新回调：插件就绪后自动重试注册
        if (!installTableUpdateHook()) {
            hostWindow.setTimeout(function retryHook() {
                if (!installTableUpdateHook()) hostWindow.setTimeout(retryHook, 2000);
            }, 2000);
        }
        const ejs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
        console.log(
            '[mvu2shujuku][debug] 加载时 EjsTemplate=' + !!ejs +
            ' | defines=' + !!(ejs && ejs.defines) +
            ' | 已注册 mvu2shujukuGetAllVariables=' + typeof (ejs && ejs.defines && ejs.defines.mvu2shujukuGetAllVariables)
        );
        bindAutoInit(context);
        hostWindow.setTimeout(autoInitDatabase, 1500);
        activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
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

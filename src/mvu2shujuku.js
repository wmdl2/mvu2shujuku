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

    const VERSION = '0.3.18';

    let sharedTableCodec = null;
    function getTableCodecFactory() {
        if (typeof root.__MVU2SHUJUKU_TABLE_CODEC_FACTORY__ === 'function') return root.__MVU2SHUJUKU_TABLE_CODEC_FACTORY__;
        if (typeof require === 'function') return require('./table-codec.js');
        throw new Error('表格编解码模块未加载，请使用构建后的 index.js');
    }
    let sharedInputParser = null;
    function getInputParserFactory() {
        if (typeof root.__MVU2SHUJUKU_INPUT_PARSER_FACTORY__ === 'function') return root.__MVU2SHUJUKU_INPUT_PARSER_FACTORY__;
        if (typeof require === 'function') return require('./input-parser.js');
        throw new Error('角色卡输入解析模块未加载，请使用构建后的 index.js');
    }
    function getInputParser() {
        if (!sharedInputParser) sharedInputParser = getInputParserFactory()({ clone: deepClone });
        return sharedInputParser;
    }
    let sharedSchemaLayout = null;
    function getRuntimeSessionFactory() {
        if (typeof root.__MVU2SHUJUKU_RUNTIME_SESSION_FACTORY__ === 'function') return root.__MVU2SHUJUKU_RUNTIME_SESSION_FACTORY__;
        if (typeof require === 'function') return require('./runtime-session.js');
        throw new Error('运行会话模块未加载，请使用构建后的 index.js');
    }
    function getStAdapterFactory() {
        if (typeof root.__MVU2SHUJUKU_ST_ADAPTER_FACTORY__ === 'function') return root.__MVU2SHUJUKU_ST_ADAPTER_FACTORY__;
        if (typeof require === 'function') return require('./st-adapter.js');
        throw new Error('酒馆适配模块未加载，请使用构建后的 index.js');
    }
    function getSettingsView() {
        if (typeof root.__MVU2SHUJUKU_SETTINGS_VIEW__ === 'function') return root.__MVU2SHUJUKU_SETTINGS_VIEW__;
        if (typeof require === 'function') return require('./settings-view.js');
        throw new Error('设置视图模块未加载，请使用构建后的 index.js');
    }
    function getSchemaLayoutFactory() {
        if (typeof root.__MVU2SHUJUKU_SCHEMA_LAYOUT_FACTORY__ === 'function') return root.__MVU2SHUJUKU_SCHEMA_LAYOUT_FACTORY__;
        if (typeof require === 'function') return require('./schema-layout.js');
        throw new Error('结构推导模块未加载，请使用构建后的 index.js');
    }
    function getSchemaLayout() {
        if (!sharedSchemaLayout) sharedSchemaLayout = getSchemaLayoutFactory()({
            getMvuYamlLibs, splitJsTopLevelArgs, parseInitVar, analyzeMvuInitMetadata, isPlainObject, toIdent, pinyinOf,
        });
        return sharedSchemaLayout;
    }
    let sharedEjsTransform = null;
    function getEjsTransformFactory() {
        if (typeof root.__MVU2SHUJUKU_EJS_TRANSFORM_FACTORY__ === 'function') return root.__MVU2SHUJUKU_EJS_TRANSFORM_FACTORY__;
        if (typeof require === 'function') return require('./ejs-transform.js');
        throw new Error('EJS 转换模块未加载，请使用构建后的 index.js');
    }
    function getEjsTransform() {
        if (!sharedEjsTransform) sharedEjsTransform = getEjsTransformFactory()();
        return sharedEjsTransform;
    }
    function findJsCallEnd(...args) { return getEjsTransform().findJsCallEnd(...args); }
    function splitJsTopLevelArgs(...args) { return getEjsTransform().splitJsTopLevelArgs(...args); }
    function rewriteStatDataCalls(...args) { return getEjsTransform().rewriteStatDataCalls(...args); }
    function ejsScriptBlocks(...args) { return getEjsTransform().ejsScriptBlocks(...args); }
    function maskJsStringsAndComments(...args) { return getEjsTransform().maskJsStringsAndComments(...args); }
    function ejsLexicalDeclarationNames(...args) { return getEjsTransform().ejsLexicalDeclarationNames(...args); }
    function ejsFallbackVarNames(...args) { return getEjsTransform().ejsFallbackVarNames(...args); }
    function isolateCrossEntryEjsFallbacks(...args) { return getEjsTransform().isolateCrossEntryEjsFallbacks(...args); }
    function unresolvedEjsDataReads(...args) { return getEjsTransform().unresolvedEjsDataReads(...args); }
    function parseStaticStatAccessor(...args) { return getEjsTransform().parseStaticStatAccessor(...args); }
    function dbConditionForStaticPath(...args) { return getEjsTransform().dbConditionForStaticPath(...args); }
    function translateSimpleEjsConditions(...args) { return getEjsTransform().translateSimpleEjsConditions(...args); }
    function rewriteEjsConditions(...args) { return getEjsTransform().rewriteEjsConditions(...args); }
    function getTableCodec() {
        if (!sharedTableCodec) sharedTableCodec = getTableCodecFactory()(source => {
            const libs = getMvuYamlLibs();
            return libs && typeof libs.jsonrepair === 'function' ? libs.jsonrepair(source) : null;
        });
        return sharedTableCodec;
    }
    let sharedTableWriter = null;
    function getBridgeLifecycleFactory() {
        if (typeof root.__MVU2SHUJUKU_BRIDGE_LIFECYCLE_FACTORY__ === 'function') return root.__MVU2SHUJUKU_BRIDGE_LIFECYCLE_FACTORY__;
        if (typeof require === 'function') return require('./bridge-lifecycle.js');
        throw new Error('桥生命周期模块未加载，请使用构建后的 index.js');
    }
    function getTableWriterFactory() {
        if (typeof root.__MVU2SHUJUKU_TABLE_WRITER_FACTORY__ === 'function') return root.__MVU2SHUJUKU_TABLE_WRITER_FACTORY__;
        if (typeof require === 'function') return require('./table-writer.js');
        throw new Error('表格写入模块未加载，请使用构建后的 index.js');
    }
    function getTableWriter() {
        if (!sharedTableWriter) sharedTableWriter = getTableWriterFactory()({
            parseJson: safeParseJson, debugOn: mvu2shujukuDebugOn, debug: dbg, warn: dbgWarn,
            readCachedTemplate: () => {
                const holder = typeof window !== 'undefined' ? window : root;
                return holder && holder.__mvu2shujukuTemplateCache;
            },
        });
        return sharedTableWriter;
    }

    // debug 开关：默认关闭。UI 设置面板勾选后写入 window.__mvu2shujukuDebug，
    // 两个执行作用域（转换器核心 / 扩展 UI）的 dbg/dbgWarn 都读这个全局标记。
    function mvu2shujukuDebugOn() {
        try {
            const w = (typeof window !== 'undefined' ? window : root);
            return !!(w && w.__mvu2shujukuDebug);
        } catch (e) { return false; }
    }
    function dbg() {
        if (!mvu2shujukuDebugOn()) return;
        try { console.log.apply(console, ['[mvu2shujuku][debug]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }
    function dbgWarn() {
        if (!mvu2shujukuDebugOn()) return;
        try { console.warn.apply(console, ['[mvu2shujuku][debug]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }

    /* ================================================================
     * 开局建表核心流程（对应 MVU 的 init 时机 → SP·数据库 的初始化）
     *
     * MVU 在聊天开始（首条消息存在）时用 [InitVar] 初始化变量；
     * 转换后由 SP·数据库 的 initGameSession 在同样时机建表并写入初始行。
     * 本片段是纯 ES5 字符串，同时内嵌进 卡内数据桥脚本 与 扩展本体，
     * 保证两处行为一致；规则只来自插件 API（importTemplateFromData /
     * initGameSession / exportTableAsJson），不含任何特定角色卡内容。
     * ================================================================ */
    function getSpAdapterFactory() {
        if (typeof root.__MVU2SHUJUKU_SP_ADAPTER_FACTORY__ === 'function') return root.__MVU2SHUJUKU_SP_ADAPTER_FACTORY__;
        if (typeof require === 'function') return require('./sp-adapter.js');
        throw new Error('SP 适配模块未加载，请使用构建后的 index.js');
    }

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

    // 与 MVU 源码同款解析库（yaml@2.8 / json5@2.2 / jsonrepair@3.13）：
    // Node 端 require src/vendor/mvu-yaml-libs.js；浏览器端由构建脚本内联成 root.__MVU2SHUJUKU_YAML_LIBS__。
    function getMvuYamlLibs() {
        if (root.__MVU2SHUJUKU_YAML_LIBS__) return root.__MVU2SHUJUKU_YAML_LIBS__;
        try {
            if (typeof require === 'function') {
                root.__MVU2SHUJUKU_YAML_LIBS__ = require('./vendor/mvu-yaml-libs.js');
                return root.__MVU2SHUJUKU_YAML_LIBS__;
            }
        } catch (e) { /* 浏览器端由扩展构建时内联 */ }
        throw new Error('缺少 MVU 解析库（src/vendor/mvu-yaml-libs.js 未内联/未安装）');
    }

    // 对齐 MVU/TH {{format_message_variable::路径}} 的展示语义：
    // 标量直接输出，对象/数组输出 YAML，以 $ 开头的字段不向 AI 展示。
    function formatMessageVariableValue(value) {
        if (value === undefined) return '';
        if (value === null) return 'null';
        if (typeof value !== 'object') return String(value);
        const seen = new WeakSet();
        const clean = (input) => {
            if (input === null || typeof input !== 'object') return input;
            if (seen.has(input)) return null;
            seen.add(input);
            if (Array.isArray(input)) return input.map(clean);
            const out = {};
            for (const [key, child] of Object.entries(input)) {
                if (String(key).startsWith('$')) continue;
                out[key] = clean(child);
            }
            return out;
        };
        const cleaned = clean(value);
        try {
            return String(getMvuYamlLibs().YAML.stringify(cleaned)).replace(/\n$/, '');
        } catch (e) {
            // JSON 是 YAML 1.2 的合法子集，仅在极端缺库环境下兜底。
            try { return JSON.stringify(cleaned, null, 2); } catch (e2) { return ''; }
        }
    }

    // JSON 容错解析：AI/前端常写尾逗号、单引号、注释等非严格 JSON（尤其 JSON 表内容列、
    // _扩展数据 溢出列）。严格 JSON.parse 失败会静默丢整组数据——表格里能看到原始 JSON
    // 文本，读回 stat_data 却是空对象，前端面板自然不显示。用 jsonrepair 兜底修复。
    function safeParseJson(v) {
        return getTableCodec().parseObject(v);
    }

    // jsonrepair 源码（用于把容错解析内联进卡内桥）：Node 端读 vendor 文件，浏览器端由构建内联。
    function getJsonrepairSource() {
        if (root.__MVU2SHUJUKU_JSONREPAIR_SRC__) return root.__MVU2SHUJUKU_JSONREPAIR_SRC__;
        try {
            if (typeof require === 'function' && typeof __dirname !== 'undefined') {
                const fs = require('fs');
                const path = require('path');
                root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = fs.readFileSync(path.join(__dirname, 'vendor', 'jsonrepair-lite.js'), 'utf8');
                return root.__MVU2SHUJUKU_JSONREPAIR_SRC__;
            }
        } catch (e) { /* 浏览器端由扩展构建时内联 */ }
        return '';
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

    /**
     * 从 ST 刷新后的角色列表精确定位刚创建的转换卡。
     * lazyLoadCharacters 开启时列表不含 mvu2shujuku marker，需由
     * loadFullCharacter 按候选卡头像取完整卡再校验 convertedAt。
     */
    async function findConvertedCharacterIndex(characters, expected, loadFullCharacter) {
        const list = Array.isArray(characters) ? characters : [];
        const target = expected && typeof expected === 'object' ? expected : {};
        const displayName = String(target.displayName || '');
        const avatar = String(target.avatar || '');
        const convertedAt = String(target.convertedAt || '');
        if (!displayName || !convertedAt) return -1;
        for (let i = list.length - 1; i >= 0; i--) {
            const character = list[i];
            if (!character) continue;
            const characterAvatar = String(character.avatar || (character.data && character.data.avatar) || '');
            if (avatar && characterAvatar !== avatar) continue;
            let data = character.data || character;
            if (String((data && data.name) || character.name || '') !== displayName) continue;
            let marker = data && data.extensions && data.extensions.mvu2shujuku;
            if ((!marker || String(marker.convertedAt || '') !== convertedAt) && typeof loadFullCharacter === 'function') {
                try {
                    const full = await loadFullCharacter(character);
                    const fullData = full && (full.data || full);
                    if (String((fullData && fullData.name) || '') !== displayName) continue;
                    data = fullData;
                    marker = data && data.extensions && data.extensions.mvu2shujuku;
                } catch (e) {
                    continue;
                }
            }
            if (!marker || String(marker.converter || '') !== 'mvu2shujuku') continue;
            if (String(marker.convertedAt || '') !== convertedAt) continue;
            return i;
        }
        return -1;
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
        // 无引号键：支持纯中文、纯英文、以及中英混合键（如 事件ID / 母亲撞见次数）
        s = s.replace(/([{,]\s*)([\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fff\w$]*)\s*:/g, '$1"$2":');
        return s;
    }

    /* ================================================================
     * initvar 解析（与 MVU 源码 util/common.ts parseString 完全一致）：
     *   非 { / [ 开头 → YAML.parseDocument(content, { merge:true }).toJS()
     *   { / [ 开头或 YAML 失败 → JSON5 → JSON(jsonrepair) → YAML 兜底
     * 使用内联的同款库（yaml@2.8 / json5@2.2 / jsonrepair@3.13），
     * 支持注释、行内对象、中英混合键、merge keys、成对数组等全部官方写法。
     * ================================================================ */
    // 容错作者写错的 `key:{{user}}` / `key:<USER>`（冒号后没空格）：YAML 会把整行
    // 当成列名而不是“键: 宏值”，导致宏进入固定列名、自动初始化被“固定列名不支持宏”拦掉。
    // 这里只在宏值前补一个空格，不影响正常 YAML/JSON 写法。
    function normalizeNoSpaceMacroValues(text) {
        return String(text || '').replace(
            /^([ \t]*)([\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fff\w$]*):(\{\{[\s\S]*?\}\}|<[A-Za-z][^>\n]*>)/gm,
            '$1$2: "$3"'
        );
    }

    function parseInitVar(content) {
        const text = String(content || '').replace(/^\uFEFF/, '');
        const jsonFirst = /^[[{]/s.test(text.trim());
        const normalized = jsonFirst ? text : normalizeNoSpaceMacroValues(text);
        const trimmed = normalized.trim();
        if (!trimmed) return {};
        const libs = getMvuYamlLibs();
        const parseYaml = () => libs.YAML.parseDocument(trimmed, { merge: true }).toJS();
        try {
            if (jsonFirst) throw new Error('json-first');
            return parseYaml();
        } catch (yamlErr) {
            try {
                return libs.JSON5.parse(trimmed);
            } catch (json5Err) {
                try {
                    return JSON.parse(libs.jsonrepair(trimmed));
                } catch (jsonErr) {
                    try {
                        if (!jsonFirst) throw new Error('not-json-first');
                        return parseYaml();
                    } catch (yamlErr2) {
                        // 与官方一致：解析失败抛错（由调用方捕获并在转换报告里提示）
                        const msg = `initvar 解析失败（不是合法 YAML/JSON5/JSON）: ${String(trimmed).slice(0, 120)}`;
                        const e = new Error(msg);
                        e.cause = { yaml: yamlErr && yamlErr.message, json5: json5Err && json5Err.message, json: jsonErr && jsonErr.message };
                        throw e;
                    }
                }
            }
        }
    }

    // MVU 官方 schema.ts 的初始化语义：$meta / $arrayMeta / 魔法字符串只用于
    // 生成 Schema，随后必须从 stat_data 中清除。转换器没有持久化 MVU schema 树，
    // 因此在建表前同时收集这些结构提示，再返回与官方 cleanUpMetadata 等价的净数据。
    // metadata 的 key 是逻辑路径（点分隔），供动态字典、template、required 和
    // recursiveExtensible 的通用转换使用；绝不能把这些保留键建成业务列或表。
    const MVU_EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';

    function analyzeMvuInitMetadata(input) {
        const metadata = new Map();
        const dynamicPaths = new Set();
        const dynamicPathSamples = new Map();
        const clone = (v) => {
            if (Array.isArray(v)) return v.map(clone);
            if (v && typeof v === 'object') {
                const out = {};
                for (const [k, x] of Object.entries(v)) out[k] = clone(x);
                return out;
            }
            return v;
        };
        const cleanTemplate = (v) => walk(clone(v), [], false, true);
        const walk = (value, path, inheritedRecursive, templateMode) => {
            const pathKey = path.join('.');
            if (Array.isArray(value)) {
                let meta = null;
                const cleaned = [];
                for (const item of value) {
                    if (item === MVU_EXTENSIBLE_MARKER) {
                        meta = { ...(meta || {}), extensible: true };
                        continue;
                    }
                    if (item && typeof item === 'object' && !Array.isArray(item) &&
                        item.$arrayMeta === true && Object.prototype.hasOwnProperty.call(item, '$meta')) {
                        meta = { ...(meta || {}), ...(item.$meta && typeof item.$meta === 'object' ? clone(item.$meta) : {}) };
                        continue;
                    }
                    cleaned.push(walk(item, path, inheritedRecursive, templateMode));
                }
                if (!templateMode && (meta || inheritedRecursive)) {
                    const rec = {
                        kind: 'array',
                        extensible: !!(inheritedRecursive || (meta && meta.extensible === true)),
                        // 官方 schema.ts 的数组元元素只读取 extensible/template；
                        // recursiveExtensible 仅由父对象传入（初始数组元元素中的同名键不生效）。
                        recursiveExtensible: !!inheritedRecursive,
                        required: [],
                        template: meta && Object.prototype.hasOwnProperty.call(meta, 'template') ? cleanTemplate(meta.template) : undefined,
                    };
                    metadata.set(pathKey, rec);
                }
                return cleaned;
            }
            if (!value || typeof value !== 'object') return value;
            const rawMeta = value.$meta && typeof value.$meta === 'object' && !Array.isArray(value.$meta)
                ? clone(value.$meta) : {};
            // 严格跟随官方 generateSchema 的实际 OR 规则：父级 recursiveExtensible
            // 会让所有后代对象保持开放；子对象写 extensible:false 并不会覆盖父级递归开放。
            const recursiveExtensible = !!(inheritedRecursive || rawMeta.recursiveExtensible === true);
            const extensible = !!(recursiveExtensible || rawMeta.extensible === true);
            const required = Array.isArray(rawMeta.required) ? rawMeta.required.map(String) : [];
            const hasTemplate = Object.prototype.hasOwnProperty.call(rawMeta, 'template');
            if (!templateMode && (Object.keys(rawMeta).length || inheritedRecursive)) {
                metadata.set(pathKey, {
                    kind: 'object', extensible, recursiveExtensible, required,
                    template: hasTemplate ? cleanTemplate(rawMeta.template) : undefined,
                    strictTemplate: rawMeta.strictTemplate,
                    concatTemplateArray: rawMeta.concatTemplateArray,
                    strictSet: rawMeta.strictSet,
                });
            }
            // 官方 template 描述的是当前容器中新条目的默认结构；没有 required
            // 的开放对象也是动态键容器。含 required 的开放对象则是“固定必需字段 +
            // 可扩展字段”，保留为固定对象并让未知字段进入 _扩展数据。
            if (!templateMode && path.length && (hasTemplate || (extensible && required.length === 0))) {
                dynamicPaths.add(pathKey);
                if (hasTemplate) {
                    const sampleValue = cleanTemplate(rawMeta.template);
                    dynamicPathSamples.set(pathKey, { __MVU_TEMPLATE_SAMPLE__: sampleValue });
                }
            }
            const out = {};
            for (const [key, child] of Object.entries(value)) {
                if (key === '$meta' || key === '$arrayMeta') continue;
                out[key] = walk(child, path.concat(key), recursiveExtensible, templateMode);
            }
            return out;
        };
        return { data: walk(clone(input), [], false, false), metadata, dynamicPaths, dynamicPathSamples };
    }

    // 初始数据的宏替换：字符串值始终走 SillyTavern 原生 substituteParams；
    // 键名只在布局明确标记的“动态行字典”路径上替换，避免 <user> 等宏
    // 意外改变组名/固定字段名。替换后键冲突会直接报错，不静默覆盖数据。
    function resolveInitDataMacros(value, substituteParams, dynamicKeyPaths = []) {
        if (typeof substituteParams !== 'function') throw new Error('SillyTavern substituteParams 不可用');
        const patterns = (Array.isArray(dynamicKeyPaths) ? dynamicKeyPaths : [])
            .filter(Array.isArray).map(p => p.map(x => String(x)));
        const isDynamicKeyObject = (path) => patterns.some(p => p.length === path.length && p.every((v, i) => v === '*' || v === String(path[i])));
        const walk = (node, path) => {
            if (typeof node === 'string') return String(substituteParams(node));
            if (Array.isArray(node)) return node.map((v, i) => walk(v, path.concat(String(i))));
            if (!node || typeof node !== 'object') return node;
            const out = {};
            const resolveKeys = isDynamicKeyObject(path);
            for (const rawKey of Object.keys(node)) {
                const key = resolveKeys ? String(substituteParams(rawKey)) : rawKey;
                if (Object.prototype.hasOwnProperty.call(out, key)) {
                    throw new Error(`宏替换后键名冲突：${path.concat(key).join('.')}`);
                }
                out[key] = walk(node[rawKey], path.concat(key));
            }
            return out;
        };
        return walk(value, []);
    }

    // 解析 [value, desc] 叶子：返回 { value, desc }
    const inputParser = getInputParser();
    const { miniPngBuffer, parseCardPng, writeCardPng, parseCard, toBase64, btoaSafe, atobSafe } = inputParser;
    function leafInfo(...args) { return getSchemaLayout().leafInfo(...args); }
    function maskYamlBlockScalarBodies(...args) { return getSchemaLayout().maskYamlBlockScalarBodies(...args); }
    function yamlStripQuotes(...args) { return getSchemaLayout().yamlStripQuotes(...args); }
    function parseInlineEnumValues(...args) { return getSchemaLayout().parseInlineEnumValues(...args); }
    function yamlCheckItems(...args) { return getSchemaLayout().yamlCheckItems(...args); }
    function yamlExpandTemplateKeys(...args) { return getSchemaLayout().yamlExpandTemplateKeys(...args); }
    function expandYamlTemplateFieldKey(...args) { return getSchemaLayout().expandYamlTemplateFieldKey(...args); }
    function protectYamlTemplateScalarValues(...args) { return getSchemaLayout().protectYamlTemplateScalarValues(...args); }
    function yamlCollectCheckRanges(...args) { return getSchemaLayout().yamlCollectCheckRanges(...args); }
    function collectRulesFromYaml(...args) { return getSchemaLayout().collectRulesFromYaml(...args); }
    function yamlParseRange(...args) { return getSchemaLayout().yamlParseRange(...args); }
    function isMvuRulePathKey(...args) { return getSchemaLayout().isMvuRulePathKey(...args); }
    function registerYamlWildcard(...args) { return getSchemaLayout().registerYamlWildcard(...args); }
    function registerWildcardTypeShape(...args) { return getSchemaLayout().registerWildcardTypeShape(...args); }
    function registerYamlField(...args) { return getSchemaLayout().registerYamlField(...args); }
    function parseMvuShapes(...args) { return getSchemaLayout().parseMvuShapes(...args); }
    function parseRegisteredZodSchema(...args) { return getSchemaLayout().parseRegisteredZodSchema(...args); }
    function mergeZodSchemaNodes(...args) { return getSchemaLayout().mergeZodSchemaNodes(...args); }
    function countZodSchemaFlag(...args) { return getSchemaLayout().countZodSchemaFlag(...args); }
    function mergeRegisteredZodIntoShapeInfo(...args) { return getSchemaLayout().mergeRegisteredZodIntoShapeInfo(...args); }
    function applyRegisteredZodDefaults(...args) { return getSchemaLayout().applyRegisteredZodDefaults(...args); }
    function scanGreetingShapeVariation(...args) { return getSchemaLayout().scanGreetingShapeVariation(...args); }
    function extractListItems(...args) { return getSchemaLayout().extractListItems(...args); }
    function stripRuleQuotes(...args) { return getSchemaLayout().stripRuleQuotes(...args); }
    function scanDynamicKeyNamesFromRules(...args) { return getSchemaLayout().scanDynamicKeyNamesFromRules(...args); }
    function parseZodStyleRules(...args) { return getSchemaLayout().parseZodStyleRules(...args); }
    function isSchemaFieldName(...args) { return getSchemaLayout().isSchemaFieldName(...args); }
    function mergeShapeMetadata(...args) { return getSchemaLayout().mergeShapeMetadata(...args); }
    function parseTypeSchema(...args) { return getSchemaLayout().parseTypeSchema(...args); }
    function parseShapeString(...args) { return getSchemaLayout().parseShapeString(...args); }
    function extractYamlBlockScalar(...args) { return getSchemaLayout().extractYamlBlockScalar(...args); }
    function cardTextBlobs(...args) { return getSchemaLayout().cardTextBlobs(...args); }
    function scanStatusUsage(...args) { return getSchemaLayout().scanStatusUsage(...args); }
    function isPairLeaf(...args) { return getSchemaLayout().isPairLeaf(...args); }
    function isLeaf(...args) { return getSchemaLayout().isLeaf(...args); }
    function collectColumns(...args) { return getSchemaLayout().collectColumns(...args); }
    function inferType(...args) { return getSchemaLayout().inferType(...args); }
    function jsonColumnFromObject(...args) { return getSchemaLayout().jsonColumnFromObject(...args); }
    function schemaTypeLabel(...args) { return getSchemaLayout().schemaTypeLabel(...args); }
    function schemaExample(...args) { return getSchemaLayout().schemaExample(...args); }
    function describeObjectSchema(...args) { return getSchemaLayout().describeObjectSchema(...args); }
    function fixedObjectFromValue(...args) { return getSchemaLayout().fixedObjectFromValue(...args); }
    function fixedObjectSchema(...args) { return getSchemaLayout().fixedObjectSchema(...args); }
    function flattenFixedObjectColumns(...args) { return getSchemaLayout().flattenFixedObjectColumns(...args); }
    function buildSchema(...args) { return getSchemaLayout().buildSchema(...args); }
    function rowFirstValue(...args) { return getSchemaLayout().rowFirstValue(...args); }
    function attachFieldRules(...args) { return getSchemaLayout().attachFieldRules(...args); }
    function sanitizeMacroColumnZh(...args) { return getSchemaLayout().sanitizeMacroColumnZh(...args); }
    function disambiguateColumnSlugs(...args) { return getSchemaLayout().disambiguateColumnSlugs(...args); }

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

    function buildDdl(group, opts = {}) {
        // 用户可关掉 DDL 里的 CHECK（数值范围/枚举/json_valid），只保留列类型与默认值。
        const includeCheck = opts.includeCheck !== false;
        const L = [`CREATE TABLE ${group.ident} ( -- ${group.tableName}`];
        L.push(`  row_id INTEGER PRIMARY KEY, -- 行号`);
        const cols = group.columns || [];
        const compositeKeyCols = group.kind === 'nestedRows'
            ? [...(group.ancestorKeyCols || []).map(a => a.col), group.keyCol]
                .map(name => cols.find(c => c.zh === name)).filter(Boolean)
            : [];
        for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const isKey = i === 0 && group.kind === 'rows';
            let def = `  ${c.ident} ${c.type}`;
            const range = c.range || null;
            const extras = Array.isArray(group.extraAllowed && group.extraAllowed[c.ident]) ? group.extraAllowed[c.ident] : [];
            let dv = c.value;
            // 默认值若越界也加入放行列表（不修改初始值）；非数字哨兵（如“无”）同样放行
            if (range) {
                if (typeof dv === 'number' && (dv < range[0] || dv > range[1]) && !extras.includes(dv)) extras.push(dv);
                if (typeof dv === 'string') {
                    const nv = Number(dv);
                    const numericInRange = dv.trim() !== '' && Number.isFinite(nv) && nv >= range[0] && nv <= range[1];
                    if (!numericInRange) {
                        const allowedVal = dv.trim() !== '' && Number.isFinite(nv) ? nv : dv;
                        if (!extras.includes(allowedVal)) extras.push(allowedVal);
                    }
                }
            }
            if (c.type === 'INTEGER' || c.type === 'REAL') {
                let defaultExpr = 0;
                if (typeof dv === 'boolean') {
                    defaultExpr = dv ? 1 : 0;
                } else if (typeof dv === 'number' && Number.isFinite(dv)) {
                    defaultExpr = dv;
                } else if (typeof dv === 'string' && dv.trim() !== '') {
                    const nv = Number(dv);
                    defaultExpr = Number.isFinite(nv) ? nv : `'${sqlQuote(dv)}'`;
                } else if (range) {
                    // 空/缺省值不能用 0 做默认，否则 CHECK(1~100) 会在 INSERT 省略该列时失败；
                    // 改为合法区间下限作为安全默认。
                    defaultExpr = range[0];
                }
                def += ` NOT NULL DEFAULT ${defaultExpr}`;
                if (includeCheck && group.scalarType === 'number') def += ` CHECK(typeof(${c.ident}) IN ('integer', 'real'))`;
                if (isKey) def += ' UNIQUE';
                if (range && includeCheck) {
                    def += ` CHECK(${c.ident} BETWEEN ${range[0]} AND ${range[1]}`;
                    if (extras.length) {
                        const allowed = extras.map(v => typeof v === 'number' ? v : `'${sqlQuote(v)}'`);
                        def += ` OR ${c.ident} IN (${allowed.join(', ')})`;
                    }
                    def += ')';
                }
            } else {
                let dvs = dv === undefined || dv === null ? '' : String(dv);
                if (c.isObject && dvs === '') dvs = c.jsonKind === 'array' ? '[]' : '{}';
                def += ` NOT NULL DEFAULT '${sqlQuote(dvs)}'`;
                if (isKey) def += ' UNIQUE';
                // 整组 JSON 表的内容列：SQLite 模式下用 json_valid CHECK 保证整列 JSON 合法
                // （updateCell/insertRow 的 SQL 由 SQLite 执行时会真正校验；native 模式不生效，见报告）
                if (includeCheck && group.kind === 'json' && c.zh === '内容') {
                    def += ` CHECK(json_valid(${c.ident}))`;
                } else if (includeCheck && c.isObject && c.zh !== '_扩展数据') {
                    const jsonKind = c.jsonKind === 'array' ? 'array' : 'object';
                    // json_valid 只能拦住非 JSON；`"阁主"` 仍是合法 JSON。普通
                    // 对象/数组列还必须校验顶层类型，防止标量写进对象列。
                    def += ` CHECK(json_valid(${c.ident}) AND json_type(${c.ident}) = '${jsonKind}')`;
                }
                // 枚举 CHECK：把默认值和越界初始值一并放行，避免初始行/默认值被拒绝
                if (includeCheck && c.enum && c.enum.length <= 8 && c.enum.every(v => !/['"]/.test(v))) {
                    const allowed = [...c.enum];
                    if (dvs !== '' && !allowed.includes(dvs)) allowed.push(dvs);
                    for (const ex of extras) if (!allowed.includes(ex)) allowed.push(ex);
                    def += ` CHECK(${c.ident} IN (${allowed.map(v => `'${sqlQuote(v)}'`).join(', ')}))`;
                }
            }
            // 插件校验要求 DDL 列注释与 content 表头逐字一致，描述只写进 note，不拼进注释；
            // 末列不加逗号，否则 sql.js 拒绝建表（SQLite 运行时回退原生模式）。
            def += (i < cols.length - 1 || compositeKeyCols.length ? ',' : '') + ` -- ${c.zh}`;
            L.push(def);
        }
        if (compositeKeyCols.length) L.push(`  UNIQUE (${compositeKeyCols.map(c => c.ident).join(', ')})`);
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
        if (group.kind === 'array' || group.kind === 'pathArray' || group.kind === 'nestedArray') {
            return '数组表：每行一个数组元素，行号即数组顺序；按行新增、移除或更新元素。';
        }
        if (group.kind === 'nestedRows') {
            const ancestors = (group.ancestorKeyCols && group.ancestorKeyCols.length)
                ? group.ancestorKeyCols : [{ col: group.parentKeyCol, parentTable: group.parentTable, parentKeyCol: group.keyCol }];
            if (ancestors.length === 1) {
                const a = ancestors[0];
                const entity = a.entity || group.relationEntity || String(a.col || '').replace(/_键名$/, '') || '关联记录';
                return `关系表：每行记录「${a.parentTable || group.parentTable}」中某条${entity}记录的一项${group.childKey || group.name}数据；「${a.col}」取自「${a.parentTable || group.parentTable}.${a.parentKeyCol || group.keyCol}」，并与「${group.keyCol}」共同定位该记录。`;
            }
            const keys = [...ancestors.map(a => `「${a.col}」`), `「${group.keyCol}」`].join('、');
            return `关系表：每行记录一项${group.childKey || group.name}数据；${keys}组成完整关系键，共同定位所属记录。`;
        }
        return `行表，以「${group.keyCol}」为唯一标识；同名记录只存在一行，已有记录按需更新，新记录按需新增。`;
    }

    function buildNote(group) {
        const L = [];
        if (group.scalarType === 'number') {
            const rules = [...(group.groupChecks || []), ...(group.wildcardRules || []).flatMap(r => r.checks || [])];
            L.push('数值表（row_id=1，全表固定一行）：「内容」直接保存一个数字，可含小数；禁止写入对象、数组、布尔值或带引号的 JSON 字符串。禁止新增/删除行。');
            if (rules.length) {
                L.push('【更新规则】', ...rules.map(rule => '- ' + sanitizeCheckRule(rule, { group })).filter(s => s !== '- '));
                L.push('只在本轮发生相应变化时更新数值；未发生变化则保持原值。');
            } else L.push('本数值由脚本/前端维护，AI 不应直接修改本表。');
            return L.join('\n');
        }
        const aiCols = group.kind === 'json' ? [] : group.columns.filter(c => c.zh !== '_扩展数据' && !String(c.zh).startsWith('_'));
        // 所有下划线前缀列都是只读状态；内部溢出列 _扩展数据虽不进列定义/写入示例，
        // 但 AI 仍能在真实表头/DDL 里看到，因此同样要触发现有只读提示。
        const userReadonlyCols = (group.columns || []).filter(c => String(c.zh).startsWith('_'));
        const hasUserReadonly = userReadonlyCols.length > 0;
        const allReadonly = hasUserReadonly && aiCols.length === 0;
        if (group.kind === 'json') {
            const wr = group.wildcardRules || [];
            const gc = group.groupChecks || [];
            if (wr.length || gc.length) {
                // 规则声明了 AI 可写路径（如 户.<门牌>.妻.好感值）：JSON 表不再一刀切只读，
                // 而是列出可写路径与约束，AI 读取现有 JSON 仅改对应路径后整体写回「内容」列。
                L.push('整组 JSON 存储表（row_id=1，全表固定一行）：本表以 JSON 保存动态结构。AI 可更新「内容」列——读取当前 JSON，只改变【可写路径与约束】中列出的路径，其余字段保持原样，再把整个 JSON 写回；禁止新增/删除行。');
                L.push('【可写路径与约束】');
                for (const r of wr) {
                    const parts = [];
                    if (r.range) parts.push(`数值范围 ${r.range[0]}~${r.range[1]}`);
                    parts.push(...(r.checks || []).map(rule => sanitizeCheckRule(rule, { group, jsonContainer: true })).filter(Boolean));
                    if (parts.length) L.push(`- ${r.path}（${parts.join('；')}）`);
                }
                for (const rule of gc.map(rule => sanitizeCheckRule(rule, { group, jsonContainer: true })).filter(Boolean)) L.push(`- ${rule}`);
                L.push('【更新守卫】');
                // 不给 AI 加“<> 是什么”的说明：MVU 原版就是把规则原文交给 AI 理解，
                // 且不是所有卡都用 <>（也有纯点分路径）。规则原文已在上方【可写路径与约束】保留。
                // 守卫统一放宽：只限制“未声明路径”，不堵死“规则声明可 insert/初始化/新增”
                // 的路径（否则空 JSON 表永远无法初始化，如大荒 宗门表）。不做关键词检测。
                L.push('- 只更新【可写路径与约束】中列出的路径；未列出的字段一律只读（它们仍存在于同一 JSON 中，由脚本/系统维护，AI 不得改动）。规则要求 insert/初始化/新增 的路径允许创建对应字段、对象或记录；严禁新增未声明的字段、对象或记录');
                L.push('- 只更新本轮剧情中明确出现并被影响到的对象；其余对象的数据保持原样');
                L.push('- 写回时必须完整保留 JSON 中其余全部字段；数值字段保持数字类型、字符串字段保持字符串类型');
            } else {
                L.push(`整组 JSON 存储表（row_id=1，全表固定一行）。本表整组数据由脚本/前端读写，AI 不应直接修改本表，也不要新增或删除行。`);
            }
        } else if (group.kind === 'singleton') {
            // 单例表不重复描述（“全表固定一条记录”等），直接给出开局记录说明；
            // 全只读单例（全部为 _ 字段）不写“只允许 UPDATE”，避免与“AI 无需填表”冲突
            if (aiCols.length) {
                L.push(`本表唯一记录已由开局模板初始化（row_id=1）；填表时禁止 INSERT / DELETE，只允许按需 UPDATE。`);
            } else {
                // 纯容器单例（如 行囊 只有子表 背包、自身无 AI 字段）：提示数据在子表，
                // 避免“AI 无需填表”让人以为整组数据都不存在。
                const childNames = (group.childTables || []).map(ct => ct.tableName || (ct.key + '表'));
                L.push(childNames.length
                    ? `本表为容器（row_id=1 占位），数据在子表「${childNames.join('、')}」中；本表自身无 AI 可填字段，全部字段由脚本/系统维护，AI 无需填表。`
                    : `本表唯一记录已由开局模板初始化（row_id=1）；全部字段由脚本/系统维护，AI 无需填表。`);
            }
        } else {
            // 与插件默认模板一致：note 不重复表名（插件会在表头显示表名），直接给表类型说明
            L.push(describeGroup(group));
        }
        // JSON 表整组由脚本/前端管理：完全不展示列定义与约束；其余表隐藏内部列（_扩展数据）
        // 下划线开头字段 = 脚本维护的只读状态：不进填表规则（AI 仍能在数据表里看到值，
        // 但没有更新规则），只在表级用一行说明约束，避免逐列占提示词。
        if (hasUserReadonly && !allReadonly) {
            // MVU 规范：下划线开头字段（如 _xxx）是脚本维护的只读状态，AI 禁止更新
            // 注意：只声明“不列入填表字段/严禁更新”，不要声称“更新会被回滚”——
            // 转换器没有回滚机制（下划线字段只是不进填表规则，AI 若硬写 SQL 不会被回滚）。
            L.push('下划线开头字段（如 _xxx）为脚本/系统维护的只读状态，不列入填表字段：AI 只能读取、严禁更新。');
        }
        if (aiCols.length) {
            L.push('【列定义】');
            // 对齐默认模板：列定义只列中文名 + 标识符；字段说明与约束放【强制约束】
            aiCols.forEach((c, i) => L.push(`- 列${i + 1}: ${c.zh} ${c.ident}`));
            L.push('【强制约束】');
            if (group.kind === 'nestedRows') {
                const entity = group.relationEntity || String(group.parentKeyCol || '').replace(/_键名$/, '') || '关联记录';
                L.push(`- 维护本表时，同时遵循对应${entity}记录中与「${group.childKey || group.name}」相关的整体规则`);
            }
            const columnRuleView = (c) => {
                const parts = [];
                if (c.range) parts.push(`数值范围 ${c.range[0]}~${c.range[1]}`);
                if (c.enum) parts.push(`可选值：${c.enum.join(' / ')}`);
                if (c.format) parts.push(`格式要求：${String(c.format).replace(/\n/g, ' ')}`);
                if (c.isObject) parts.push('对象以 JSON 存储，读取时还原');
                const checks = (c.check || []).map(rule => sanitizeCheckRule(rule, { group, column: c })).filter(Boolean);
                return { parts, checks };
            };
            const compactTemplateLabel = (cols) => {
                const names = cols.map(c => String(c.zh || ''));
                if (names.length < 2 || names.some(x => !x)) return '';
                const chars = names.map(x => Array.from(x));
                let prefix = 0;
                while (chars.every(x => prefix < x.length && x[prefix] === chars[0][prefix])) prefix++;
                let suffix = 0;
                while (chars.every(x => suffix < x.length - prefix && x[x.length - 1 - suffix] === chars[0][chars[0].length - 1 - suffix])) suffix++;
                const choices = chars.map(x => x.slice(prefix, x.length - suffix).join(''));
                // 至少共享前缀或后缀，才能证明这是一组可读的模板列；
                // 不把仅仅恰好有相同枚举/check 的无关列硬拼成 ${A|B}。
                if ((!prefix && !suffix) || choices.some(x => !x) || new Set(choices).size !== choices.length) return '';
                return chars[0].slice(0, prefix).join('') + '${' + choices.join('|') + '}' + (suffix ? chars[0].slice(-suffix).join('') : '');
            };
            // 模板键会展开为真实列以便绑定 DDL，但提示词不必复制同一套
            // 规则。仅在同表多列的范围/枚举/格式/check 完全一致时折叠；
            // 各列自己的 [值,描述] 仍分别展示。
            const ruleViews = new Map(aiCols.map(c => [c, columnRuleView(c)]));
            const sameRuleSets = new Map();
            for (const c of aiCols) {
                const view = ruleViews.get(c);
                if (!view.parts.length && !view.checks.length) continue;
                const sig = JSON.stringify([view.parts, view.checks]);
                if (!sameRuleSets.has(sig)) sameRuleSets.set(sig, []);
                sameRuleSets.get(sig).push(c);
            }
            const groupedRuleOwner = new Map();
            for (const cols of sameRuleSets.values()) {
                const label = compactTemplateLabel(cols);
                if (!label) continue;
                groupedRuleOwner.set(cols[0], { label, cols });
                for (let i = 1; i < cols.length; i++) groupedRuleOwner.set(cols[i], null);
            }
            const emitColumnRules = (label, items) => {
                const rules = items.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
                if (!rules.length) return;
                if (rules.length === 1) {
                    L.push(`- ${label}：${rules[0]}`);
                    return;
                }
                L.push(`- ${label}：`);
                for (const rule of rules) L.push(`  - ${rule}`);
            };
            for (const c of aiCols) {
                const view = ruleViews.get(c);
                const grouped = groupedRuleOwner.get(c);
                // 真实字段说明（如 [值,说明] 的更新条件）；通用描述（唯一标识/键名/JSON 提示）不重复
                let desc = c.desc ? String(c.desc).replace(/\n/g, ' ').trim() : '';
                // 关系列的关联含义已经在表级说明中完整表达，不再作为“强制约束”重复一遍。
                if (group.kind === 'nestedRows' && (c.zh === group.keyCol || (group.ancestorKeyCols || []).some(a => a.col === c.zh) || c.zh === group.parentKeyCol)) desc = '';
                const generic = desc === '唯一标识' || desc === '对象（JSON 存储，读取时还原）';
                if (grouped) {
                    emitColumnRules(grouped.label, [...view.parts, ...view.checks, (!generic ? desc : '')]);
                } else if (grouped !== null) {
                    emitColumnRules(c.zh, [...view.parts, ...view.checks, (!generic ? desc : '')]);
                }
            }
            // 子表/动态字典的组级规则（如 世界.动向 的“最多维持2个大事件”）：以表级约束列出
            // 注意：这些行已位于本表自己的 note 内，不再重复表名前缀（避免“道侣表：性别：…”式噪音）
            for (const rule of (group.groupChecks || []).map(rule => sanitizeCheckRule(rule, { group })).filter(Boolean)) L.push(`- ${rule}`);
            // 通配路径规则（如 人物.角色名.亲密）：动态键无法静态展开，作为表格级提示保留，
            // AI 对照快照中的具体键套用（范围/条件仍可见）
            for (const wr of (group.wildcardRules || [])) {
                // 关系表的字段路径规则已在对应列下展示；这里只展示止于整个集合的规则。
                if (wr._relationFieldRule) continue;
                // 已安全展开成固定列的通配字段，其规则已经列在该列下；不要再以
                // MVU 原路径重复一份，否则既浪费提示词，又会让旧 Patch 术语漏过列级清洗。
                const wrParts = String(wr.path || '').split('.').filter(Boolean);
                const wrTail = wrParts[wrParts.length - 1];
                // 只对“${动态行键}.固定字段”这种已直接落列的两段路径去重；
                // 更深层通配路径仍包含动态容器语义，不能因末段恰好同名就丢掉。
                if (wrParts.length === 2 && wrTail && aiCols.some(c => String(c.zh) === wrTail)) continue;
                const parts = [];
                if (wr.range) parts.push(`数值范围 ${wr.range[0]}~${wr.range[1]}`);
                if (wr.format) parts.push(`格式：${wr.format}`);
                parts.push(...(wr.checks || []).map(rule => sanitizeCheckRule(rule, { group })).filter(Boolean));
                if (parts.length) L.push(`- ${wr.path}（${parts.join('；')}）`);
            }
            (group.reminders || []).forEach(r => L.push(`- 每次回复必须维护：${r}`));
        }
        if (allReadonly && group.kind !== 'json') {
            L.push('本表全部字段均为脚本/系统维护的只读状态：AI 无需填表，仅供读取。');
        }
        if (group.kind !== 'json' && aiCols.length) {
            // 通用约束：以正文和规则为共同依据——既防虚构数据，也不与
            // “每次回复必须更新/replace 整个对象”这类每轮强制规则冲突。
            L.push('更新以正文和规则为依据，不得为凑表而虚构数据。');
        }
        return L.join('\n');
    }

    function buildInitNode(group) {
        if (group.scalarType === 'number') return '开局已初始化唯一数值记录（row_id=1）；不得再次初始化或新增/删除行，后续更新遵循 note。';
        if (group.kind === 'json') {
            return ((group.wildcardRules || []).length || (group.groupChecks || []).length)
                ? `开局模板已初始化整组数据（row_id=1）；自动填表阶段仅按 note 中「可写路径与约束」更新「内容」列，其余由脚本/前端维护。`
                : `开局模板已初始化整组数据（row_id=1）；此后整组 JSON 由脚本/前端写入，自动填表阶段禁止修改本表。`;
        }
        if (group.kind === 'singleton') {
            const aiCols = (group.columns || []).filter(c => c.zh !== '_扩展数据' && !String(c.zh).startsWith('_'));
            return aiCols.length
                ? `开局模板已初始化唯一记录（row_id=1）；自动填表阶段禁止再次初始化，只允许按需 UPDATE。`
                : `开局模板已初始化唯一记录（row_id=1）；全部字段由脚本/系统维护，自动填表阶段不修改本表。`;
        }
        if (group.kind === 'array' || group.kind === 'pathArray' || group.kind === 'nestedArray') {
            return group.rows.length
                ? `开局模板已初始化 ${group.rows.length} 个元素；此后按剧情和规则新增、移除或更新对应元素。`
                : '开局为空表；出现符合本表定义的新元素时，新增一行完整记录。';
        }
        if (group.rows.length) {
            // 不写死具体记录名：多开场白按分支注入初始值（applyActiveGreetingInitvar），
            // 实际初始记录随所选分支变化，把首个分支的名字写进提示词会在切分支后误导 AI。
            return `开局模板已初始化 ${group.rows.length} 条记录；出现符合本表定义且尚不存在的新记录时，新增一行完整记录。`;
        }
        return '开局为空表；出现符合本表定义的新记录时，新增一行完整记录。';
    }

    // SQL 示例取值：优先真实初始行值 → 其次 DDL 默认值（INTEGER 未给默认按 0，对象列按 '{}'）
    // → 最后“列中文名示例”兜底（主要覆盖无默认值的 TEXT 列）。
    function exampleCellValue(col, rowValue) {
        if (rowValue !== undefined && rowValue !== null && String(rowValue) !== '') {
            const isNum = col && col.type === 'INTEGER' && typeof rowValue === 'number';
            return isNum ? String(rowValue) : `'${sqlQuote(String(rowValue))}'`;
        }
        if (col) {
            const dv = col.value === undefined || col.value === null ? '' : col.value;
            if (col.type === 'INTEGER') {
                const num = dv === '' ? 0 : Number(dv);
                return String(Number.isFinite(num) ? num : 0);
            }
            if (String(dv) !== '') return `'${sqlQuote(String(dv))}'`;
            if (col.isObject) {
                const example = col.objectSchema ? JSON.stringify(schemaExample(col.objectSchema)) : (col.jsonKind === 'array' ? '[]' : '{}');
                return `'${sqlQuote(example)}'`;
            }
        }
        return col && col.zh ? `'${sqlQuote(col.zh)}示例'` : '';
    }

    // UPDATE 示例取值：不能拿当前值/默认值当示例值，否则会读成“把它更新成原值”的指令
    // （如 SET 当前时间 = '未知'，而当前时间本来就是 '未知'）。TEXT 一律用 '新值' 占位；
    // INTEGER 给 DDL 默认数字（0 或初始值）。示例统一不带“示例值仅为格式演示”后缀，
    // 与插件内置模板风格一致；占位语义由“SQL示例”标签与 note 的“不得虚构数据”约束兜底。
    function exampleUpdateValue(col) {
        if (col && col.type === 'INTEGER') {
            const dv = col.value === undefined || col.value === null ? '' : col.value;
            const num = dv === '' ? 0 : Number(dv);
            return String(Number.isFinite(num) ? num : 0);
        }
        return "'新值'";
    }

    // 卡内 check 规则是写给 MVU JSON Patch 机制看的，转换后需要洗掉机制性残留，
    // 只保留业务规则，避免与数据库填表通道（DSL/SQL）打架：
    //  1. 括号机制注释（op: delta/replace、勿用delta）整段删除
    //  2. 纯机制句（【防崩警告】…严禁 replace/delta、严禁对整个对象使用 replace/delta）整句删除
    //  3. “必须分N条指令更新：一条replaceA，另一条replaceB” → “A；B”（保留业务语义）
    //  4. “如 /组/字段/子字段” 这类路径写法 → 点分路径（机制句删掉后罕见，兜底处理）
    function sanitizeCheckRule(line, context) {
        let s = String(line || '').trim();
        if (!s) return s;
        const ctx = context || {};
        const col = ctx.column || null;
        const jsonArray = !!(ctx.jsonContainer || (col && col.isObject && col.jsonKind === 'array'));
        // 先把 JSON Patch 的“怎么发指令”还原为业务/存储语义。不能机械地把
        // add/remove 替换成 INSERT/DELETE：JSON 数组列在两种数据库模式下都仍是
        // 一个单元格，增删元素实际需要更新并完整写回该列，而不是增删表格行。
        if (jsonArray) {
            s = s.replace(/更改(.+?)内容时[，,]?\s*(?:必须)?(?:使用|用|采用)\s*["'“”]?replace["'“”]?\s*(?:操作|指令)?将整个数组重新输出更新/gi,
                '更改$1内容时，必须完整写回更新后的数组，并保留未改动的元素');
            s = s.replace(/清除(.+?)时[，,]?\s*(?:必须)?(?:使用|用|采用)\s*["'“”]?remove["'“”]?\s*(?:操作|指令)?并指定精确索引(?:（[^）]*）|\([^)]*\))?[。；;]?\s*需先读取数组内容确认索引[，,]?避免误删[。]?/gi,
                '移除$1中的记录前，必须先读取现有数组并确认目标元素；更新后完整写回数组并保留其他记录，避免误删');
        }
        // 动态对象在 MVU 中修改一个 value 时，部分规则会要求
        // remove 旧键 + insert 新键；拆成数据库行后可直接更新该记录的值。
        // 只改写完整的结构化措辞，避免误伤普通英文说明中的同名单词。
        s = s.replace(/通过\s*remove\s*旧键\s*\+\s*insert\s*新键\s*修改对应([^，,。；;]+?)的\s*value\s*描述/gi,
            '直接更新对应$1记录的描述');
        const opVerb = { add: '新增对应内容', replace: '更新对应内容', remove: '移除对应内容' };
        s = s.replace(/(?:使用|用|采用)\s*["'“”]?(add|replace|remove)["'“”]?\s*(?:操作|指令)/gi,
            (m, op) => opVerb[String(op).toLowerCase()] || '执行对应变更');
        s = s.replace(/(?:并)?指定精确索引/gi, '并准确定位目标元素');
        s = s.replace(/(?:（|\()[^）)]*\/[\u3400-\u9fffA-Za-z0-9_$-]+(?:\/[\u3400-\u9fffA-Za-z0-9_$-]+)+[^）)]*(?:）|\))/g, '');
        // 1) 括号机制注释（中文括号与英文括号都处理）
        s = s.replace(/（[^）]*?(?:op\s*[:：]|delta|replace|指令)[^）]*?）/gi, '')
             .replace(/\([^)]*?(?:op\s*[:：]|delta|replace)[^)]*?\)/gi, '');
        // 2) 纯机制句：整句删除
        if (/^【[^】]*(?:警告|防崩|注意)[^】]*】/.test(s) && /(?:replace|delta|指令|op\s*[:：]|json\s*patch|patch)/i.test(s)) return '';
        if (/^(?:严禁|不要|避免|请勿|勿)/.test(s) && /(?:replace|delta|指令|op\s*[:：]|json\s*patch|patch)/i.test(s)) return '';
        // 3) “必须分N条指令更新：一条replaceA，另一条replaceB” → 保留前半句 + “A；B”
        const dm = s.match(/([\s\S]*?)分\s*(?:\d+|[一二三四五六七八九十两])\s*条指令更新[：:]\s*一条(?:replace\s*)?([^，,。]+?)，另一条(?:replace\s*)?([^，,。]+?)(?:（[^）]*）)?\s*$/);
        if (dm) {
            const prefix = String(dm[1] || '').trim().replace(/[，,。;；\s]+$/, '').replace(/必须$/, '');
            const a = String(dm[2]).trim();
            const b = String(dm[3]).trim();
            s = (prefix ? prefix : '') + a + '；' + b;
        }
        // 4) “如 /组/字段/子字段” 路径写法 → 点分路径
        s = s.replace(/(?:如|为|到|写)\s*\/[\u4e00-\u9fff$]+(?:\/[\u4e00-\u9fff$]+)+/g, (m) => m.replace(/\//g, '.'));
        return s.trim();
    }

    function buildNodeProse(group, kind) {
        if (group.scalarType === 'number') {
            if (kind !== 'update') return '禁止。';
            if (!(group.groupChecks || []).length && !(group.wildcardRules || []).length) return '本数值由脚本/前端维护，AI 不应直接修改。';
            const col = group.columns[0];
            return `根据 note 中的更新规则修改数值，只允许 UPDATE，禁止 INSERT / DELETE。\nSQL示例: UPDATE ${group.ident} SET ${col.ident} = ${col.value} WHERE row_id=1;`;
        }
        if (group.kind === 'json') {
            if (kind === 'update') {
                if ((group.wildcardRules || []).length || (group.groupChecks || []).length) {
                    const col = (group.columns || []).find(c => c.zh === '内容') || { ident: 'neirong', zh: '内容' };
                    return `只允许 UPDATE（整组 JSON 固定 row_id=1，禁止 INSERT / DELETE）；正文明确造成字段变化时，按 note 中【可写路径与约束】只改实际存在的可写字段（未列出字段一律只读）、其余字段原样保留后整体写回。\nSQL示例: UPDATE ${group.ident} SET ${col.ident} = '{"可写键名":"新值"}' WHERE row_id=1;`;
                }
                return '整组 JSON 由脚本/前端整体写入，AI 不应直接修改本表。';
            }
            return '禁止。';
        }
        if (group.kind === 'singleton') {
            if (kind === 'update') {
                // 用首个可写业务列给出具体示例（有初始值用真实值，否则“列名示例”）；
                // 全只读单例（全部为 _ 字段）不生成可执行的 UPDATE 示例，避免教 AI 写只读字段
                const col = (group.columns || []).find(c => c.zh !== '_扩展数据' && !String(c.zh).startsWith('_'));
                if (!col) return '本表全部字段均为脚本/系统维护的只读状态，AI 不应修改本表。';
                const ident = col.ident;
                const val = exampleUpdateValue(col);
                return `只允许 UPDATE（单例固定 row_id=1，禁止 INSERT / DELETE）；根据正文、设定与本表规则，已有字段的值发生变化时更新。\nSQL示例: UPDATE ${group.ident} SET ${ident} = ${val} WHERE row_id=1;`;
            }
            return '禁止。';
        }
        if (group.kind === 'array' || group.kind === 'pathArray' || group.kind === 'nestedArray') {
            // 数组表与插件按行 DSL 对齐：每行一个数组元素，支持按行增删改；
            // 不再写“整体替换”（插件没有整表替换指令，且与禁止增删自相矛盾）
            const col = (group.columns || []).find(c => c.zh === '内容') || (group.columns && group.columns[0]) || { ident: 'neirong', zh: '内容' };
            const parent = group.kind === 'nestedArray' ? (group.columns || []).find(c => c.zh === group.parentKeyCol) : null;
            if (kind === 'update') {
                return `根据正文、设定与本表规则，已有数组元素的内容发生变化时更新该行。\nSQL示例: UPDATE ${group.ident} SET ${col.ident} = '新内容' WHERE row_id = 1;`;
            }
            if (kind === 'insert') {
                return parent
                    ? `根据正文、设定与本表规则，对应${group.relationEntity || '关联'}记录的数组出现本表尚未记录的新元素时添加；「${group.parentKeyCol}」必须取自「${group.parentTable}.${group.keyCol || '键名'}」。\nSQL示例: INSERT INTO ${group.ident} (${parent.ident}, ${col.ident}) VALUES ('${group.relationEntity || '关联'}键名', '新元素');`
                    : `根据正文、设定与本表规则，数组出现本表尚未记录的新元素时添加（行号自动分配，行序即数组顺序）。\nSQL示例: INSERT INTO ${group.ident} (${col.ident}) VALUES ('新元素');`;
            }
            return `根据正文、设定与本表规则，已有数组元素不再属于当前数组时删除对应行。\nSQL示例: DELETE FROM ${group.ident} WHERE row_id = 1;`;
        }
        if (group.kind === 'nestedRows') {
            const ancestorDefs = (group.ancestorKeyCols && group.ancestorKeyCols.length)
                ? group.ancestorKeyCols : [{ col: group.parentKeyCol, entity: group.relationEntity, parentTable: group.parentTable, parentKeyCol: group.keyCol }];
            const parents = ancestorDefs.map(a => group.columns.find(c => c.zh === a.col)).filter(Boolean);
            const key = group.columns.find(c => c.zh === group.keyCol) || group.columns[1];
            const ancestorNames = new Set(ancestorDefs.map(a => a.col));
            const valueCols = group.columns.filter(c => !ancestorNames.has(c.zh) && c.zh !== group.keyCol && c.zh !== '_扩展数据' && !String(c.zh).startsWith('_'));
            const value = valueCols[0];
            const entity = group.relationEntity || String(group.parentKeyCol || '').replace(/_键名$/, '') || '关联';
            const whereParts = parents.map((p, i) => `${p.ident} = '${ancestorDefs[i].entity || String(ancestorDefs[i].col).replace(/_键名$/, '')}键名'`);
            whereParts.push(`${key.ident} = '键名'`);
            const where = whereParts.join(' AND ');
            const keyNames = [...ancestorDefs.map(a => `「${a.col}」`), `「${group.keyCol}」`].join('、');
            if (kind === 'update') {
                return value
                    ? `根据正文、设定与本表规则，对应${entity}记录中已有${group.childKey || group.name}数据的字段值发生变化时更新；WHERE 必须同时带${keyNames}。\nSQL示例: UPDATE ${group.ident} SET ${value.ident} = ${exampleUpdateValue(value)} WHERE ${where};`
                    : '本表无 AI 可更新的业务列。';
            }
            if (kind === 'insert') {
                const cols = [...parents, key, ...valueCols];
                const vals = [
                    ...parents.map((p, i) => `'${ancestorDefs[i].entity || String(ancestorDefs[i].col).replace(/_键名$/, '')}键名'`),
                    "'键名'", ...valueCols.map(c => exampleCellValue(c, c.value) || "'值'"),
                ];
                return `根据正文、设定与本表规则，对应${entity}记录中出现本表尚未记录的新${group.childKey || group.name}时添加；必须填写完整关系键 ${keyNames}。\nSQL示例: INSERT INTO ${group.ident} (${cols.map(c => c.ident).join(', ')}) VALUES (${vals.join(', ')});`;
            }
            return `根据正文、设定与本表规则，对应${entity}记录中已有${group.childKey || group.name}不再属于其「${group.childKey || group.name}」数据时删除；WHERE 必须同时带${keyNames}。\nSQL示例: DELETE FROM ${group.ident} WHERE ${where};`;
        }
        const keyIdent = group.columns[0] ? group.columns[0].ident : 'key';
        // 示例优先取卡内真实初始数据；没有初始值则用 DDL 默认值；TEXT 无默认值才退回“列名示例”
        const sampleRow = group.rows && group.rows[0] ? group.rows[0] : null;
        const sampleValue = (idx, fallback) => {
            const col = group.columns[idx - 1];
            const rowV = sampleRow ? sampleRow[idx] : undefined;
            const v = exampleCellValue(col, rowV);
            return v !== '' ? v : fallback;
        };
        const keyValue = (sampleRow && sampleRow[1] !== undefined && String(sampleRow[1]) !== '')
            ? `'${sqlQuote(sampleRow[1])}'`
            : "'键名'";
        // 示例列排除内部溢出列（_扩展数据）与下划线只读字段：AI 不应直接修改
        const exampleCols = group.columns.filter(c => c.zh !== '_扩展数据' && !String(c.zh).startsWith('_'));
        const allIdents = exampleCols.map(c => c.ident);
        const firstNonKey = allIdents[1] || '字段';
        if (kind === 'update') {
            const updCol = exampleCols[1] || exampleCols[0];
            const updVal = updCol ? exampleUpdateValue(updCol) : "'新值'";
            return `根据正文、设定与本表规则，已有记录的字段值发生变化时更新。\nSQL示例: UPDATE ${group.ident} SET ${firstNonKey} = ${updVal} WHERE ${keyIdent} = ${keyValue};`;
        }
        if (kind === 'insert') {
            // 完整列示例：全部列都列出，列数与 VALUES 一一对应；
            // 不写 row_id——新版数据库（SQLite 模式）内置自增，省略即可，AI 无需手算。
            const cols = allIdents;
            const vals = exampleCols.map((c, i) => {
                if (i === 0) return keyValue;
                const colIdx = group.columns.indexOf(c);
                return sampleValue(colIdx + 1, `'值${i}'`);
            });
            return `根据正文、设定与本表规则，出现本表尚未记录的新${group.keyCol}时添加完整记录。\nSQL示例: INSERT INTO ${group.ident} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
        }
        return `根据正文、设定与本表规则，已有记录所对应的对象不再属于本表记录范围时删除。\nSQL示例: DELETE FROM ${group.ident} WHERE ${keyIdent} = ${keyValue};`;
    }

    /**
     * schema → 完整模板对象
     * mode: 'both' | 'native' | 'sqlite'
     */
    function generateTemplate(schema, opts = {}) {
        const mode = opts.mode || 'both';
        const includeCheck = opts.ddlIncludeCheck !== false;
        const report = opts.report || createReport();
        const template = {
            mate: {
                type: 'chatSheets',
                // 对齐 SP·数据库 插件的默认 mate：插件在 initGameSession/迁移时会把
                // globalInjectionConfig（默认世界书注入位置）写回模板，并升到 version 2。
                // 若转换模板保持 v1+空配置，保存的预设库与聊天作用域/迁移结果会只在 mate 上
                // 不一致，插件面板显示“当前生效模板与预设库内容不同”。生成时直接带上同一配置。
                version: 2,
                updateConfigUiSentinel: -1,
                globalInjectionConfig: {
                    readableEntryPlacement: { position: 'before_character_definition', depth: 2, order: 99981 },
                    wrapperPlacement: { position: 'before_character_definition', depth: 2, order: 99980 },
                },
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
                    if (c.range && typeof v === 'string') {
                        const nv = Number(v);
                        const numericInRange = v.trim() !== '' && Number.isFinite(nv) && nv >= c.range[0] && nv <= c.range[1];
                        if (!numericInRange) {
                            const allowedVal = v.trim() !== '' && Number.isFinite(nv) ? nv : v;
                            if (!extraAllowed[c.ident].includes(allowedVal)) extraAllowed[c.ident].push(allowedVal);
                        }
                    }
                    if (c.enum && c.enum.length && typeof v === 'string' && !c.enum.includes(v)) {
                        if (!extraAllowed[c.ident].includes(v)) extraAllowed[c.ident].push(v);
                    }
                }
            }
            g.extraAllowed = extraAllowed;
            // 归一化行号 1..N（初始值原样保留）
            const content = [['row_id', ...g.columns.map(c => c.zh)]];
            // 插件 SyncBridge 的 escapeValue 只放行 null/数字，其余值必须能 .replace()：
            // 布尔（false）会直接 TypeError（实测 val.replace is not a function），
            // 因此内容单元格统一归一化——布尔 → 1/0，null/undefined → ''，其余转字符串。
            const normalizeCell = (v, c) => {
                if (c && c.isObject && (v === null || v === undefined || v === '')) return c.jsonKind === 'array' ? '[]' : '{}';
                if (v === null || v === undefined) return '';
                if (typeof v === 'boolean') return v ? 1 : 0;
                if (typeof v === 'number') return v;
                return String(v);
            };
            g.rows.forEach((r, ri) => {
                const row = [ri + 1];
                for (let ci = 0; ci < g.columns.length; ci++) {
                    row.push(normalizeCell(r[ci + 1], g.columns[ci]));
                }
                content.push(row);
            });
            if (includeCheck) {
                for (const c of g.columns) {
                    if (extraAllowed[c.ident] && extraAllowed[c.ident].length) {
                        report.note(`「${g.tableName}」列「${c.zh}」初始值 ${extraAllowed[c.ident].map(v => JSON.stringify(v)).join('、')} 超出规则范围，CHECK 约束已放行这些初始值（数值/枚举规则仍写入 note）。`);
                    }
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
                    ddl: buildDdl(g, { includeCheck }),
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

    // SP·数据库会把 sourceData 中的提示词直接拼进 AI prompt，不再经过
    // SillyTavern 世界书的 WORLD_INFO 正则与 substituteParams。转换时先复刻其中
    // 可静态确定的正则替换，再把只读酒馆宏改成 EJS 惰性调用，保留其运行时语义。
    const TABLE_PROMPT_FIELDS = ['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode'];
    const SAFE_PROMPT_MACROS = new Set([
        'user', 'char', 'bot', 'group', 'charifnotgroup',
        'getvar', 'getglobalvar', 'random', 'pick', 'dice', 'roll',
    ]);

    function compileStaticWorldInfoRegex(input) {
        const source = String(input || '');
        if (!source) return null;
        try {
            // 与 SillyTavern regexFromString() 保持一致：/pattern/flags 与裸 pattern
            // 都接受；无效 flags 时退回把整个字符串当 pattern。
            const m = source.match(/(\/?)(.+)\1([a-z]*)/i);
            if (!m) return new RegExp(source);
            if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return new RegExp(source);
            return new RegExp(m[2], m[3]);
        } catch (e) {
            return null;
        }
    }

    function promptMacroEjs(body) {
        return '<%- mvu2shujukuResolveMacro(' + JSON.stringify(String(body || '')) + ') %>';
    }

    function formatMessageVariableEjs(path) {
        return '<%- mvu2shujukuFormatMessageVariable(' + JSON.stringify(String(path || '').trim()) + ') %>';
    }

    function rewriteFormatMessageVariableMacros(text, report, sourceLabel) {
        let count = 0;
        const rewritten = String(text == null ? '' : text).replace(
            /\{\{\s*format_message_variable\s*::([\s\S]*?)\}\}/gi,
            (whole, path) => {
                if (!String(path || '').trim()) return whole;
                count += 1;
                return formatMessageVariableEjs(path);
            }
        );
        if (count && report) report.auto(`${sourceLabel || '提示文本'}中的 ${count} 处 format_message_variable 已改为数据库变量的运行时 YAML 展示。`);
        return rewritten;
    }

    function expandWorldInfoReplacement(replacement, args) {
        const groups = args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object'
            ? args[args.length - 1]
            : null;
        return String(replacement == null ? '' : replacement)
            .replace(/\{\{match\}\}/gi, '$0')
            .replace(/\$(\d+)|\$<([^>]+)>/g, (whole, num, groupName) => {
                if (num !== undefined) return args[Number(num)] == null ? '' : String(args[Number(num)]);
                return groups && groups[groupName] != null ? String(groups[groupName]) : '';
            });
    }

    function rewriteRuntimePromptMacros(text, report, sourceLabel) {
        let changed = 0;
        let unsafe = 0;
        const formatted = rewriteFormatMessageVariableMacros(text, report, sourceLabel);
        const rewritten = formatted
            .replace(/\{\{([\s\S]*?)\}\}/g, (whole, body) => {
                const name = String(body || '').trim().split(/:{1,2}/, 1)[0].trim().toLowerCase();
                if (!SAFE_PROMPT_MACROS.has(name)) {
                    unsafe += 1;
                    return whole;
                }
                changed += 1;
                return promptMacroEjs(body);
            })
            .replace(/<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi, (whole, name) => {
                changed += 1;
                return promptMacroEjs(String(name).toLowerCase());
            });
        if (changed && report) report.auto(`${sourceLabel}中的 ${changed} 处只读酒馆宏已改为生成请求时动态解析。`);
        if (unsafe && report) report.manual(`${sourceLabel}仍含 ${unsafe} 处可能产生副作用或无法确认语义的酒馆宏，已保留原文，请人工核对。`);
        return rewritten;
    }

    function migrateTemplatePromptRuntime(template, regexScripts, report) {
        const scripts = (Array.isArray(regexScripts) ? regexScripts : []).filter((r) => {
            if (!r || r.promptOnly !== true || !Array.isArray(r.placement)) return false;
            return r.placement.map(Number).includes(5); // regex_placement.WORLD_INFO
        });
        const usable = [];
        for (const r of scripts) {
            const name = String(r.scriptName || r.id || '未命名正则');
            const dynamicFind = Number(r.substituteRegex || 0) !== 0 || /\{\{|<(?:USER|BOT|CHAR|GROUP)>/i.test(String(r.findRegex || ''));
            if (dynamicFind) {
                if (report) report.manual(`WORLD_INFO 正则「${name}」的查找式依赖运行时宏，无法在转换时确定，未迁移到表格提示词。`);
                continue;
            }
            if (Array.isArray(r.trimStrings) && r.trimStrings.length) {
                if (report) report.manual(`WORLD_INFO 正则「${name}」使用 trimStrings，未静态迁移到表格提示词，以免改变捕获组语义。`);
                continue;
            }
            const regex = compileStaticWorldInfoRegex(r.findRegex);
            if (!regex) {
                if (report) report.warn(`WORLD_INFO 正则「${name}」无法编译，未迁移到表格提示词。`, 'regex');
                continue;
            }
            usable.push({ r, regex, name, initiallyEnabled: !r.disabled });
        }
        let regexChanges = 0;
        for (const key of Object.keys(template || {})) {
            const sheet = template[key];
            if (!sheet || !sheet.sourceData) continue;
            for (const field of TABLE_PROMPT_FIELDS) {
                if (typeof sheet.sourceData[field] !== 'string') continue;
                let value = sheet.sourceData[field];
                for (const item of usable) {
                    const next = value.replace(item.regex, (...args) => {
                        const matched = String(args[0] == null ? '' : args[0]);
                        const replacement = expandWorldInfoReplacement(item.r.replaceString, args);
                        return '<%- mvu2shujukuApplyWorldInfoRegex(' +
                            JSON.stringify(item.name) + ',' + JSON.stringify(toBase64(matched)) + ',' +
                            JSON.stringify(toBase64(replacement)) + ',' + (item.initiallyEnabled ? 'true' : 'false') + ') %>';
                    });
                    if (next !== value) regexChanges += 1;
                    value = next;
                }
                sheet.sourceData[field] = rewriteRuntimePromptMacros(value, report, `表「${sheet.name || key}」${field}`);
            }
        }
        if (regexChanges && report) report.auto(`已将 WORLD_INFO 提示链中的静态查找正则迁移到数据库表格提示词（命中 ${regexChanges} 个字段）；运行时仍读取原正则的启用状态并解析 replacement 宏，原正则继续保留供其他世界书内容使用。`);
        return template;
    }

    /* ================================================================
     * Schema → 数据桥布局（buildLayout）
     * 用于：
     *  1. 生成卡内 getAllVariables() shim（DB 表格 → stat_data 嵌套形状）
     *  2. 生成 Mvu.replaceMvuData 反向写入（diff → updateCell/insertRow/deleteRow）
     *  3. EJS 条件重写时的路径 → 表/行/列 映射
     * ================================================================ */

    function columnLayoutType(...args) { return getSchemaLayout().columnLayoutType(...args); }
    function buildLayout(...args) { return getSchemaLayout().buildLayout(...args); }
    function buildLayoutJson(...args) { return getSchemaLayout().buildLayoutJson(...args); }
    function resolveLayoutMacros(...args) { return getSchemaLayout().resolveLayoutMacros(...args); }
    function statDataFromTables(layoutEntries, tables) {
        return getTableCodec().statDataFromTables(layoutEntries, tables);
    }

    /**
     * 把 stat_data 的差异写回数据库表格（Mvu.replaceMvuData 等价物）。
     * api: AutoCardUpdaterAPI；layoutEntries: buildLayoutJson 输出；prev/next: stat_data 前后快照。
     * 与卡内数据桥 writeDiffToDb 同逻辑，供扩展在桥不运行时提供写库能力。
     */
    // 上次写库是否出现失败的 CRUD（updateCell/insertRow 返回 false/-1）：
    // 供扩展合并层判断是否需要延迟重试（首楼替换/插件回放会清空运行时导致写入落空，
    // 等运行时稳定后重跑一次即可；直接补行会在原行恢复时造成重复行）。
    async function writeStatDiffToDb(api, layoutEntries, prevStat, nextStat, persistedTables) {
        return getTableWriter().writeStatDiffToDb(api, layoutEntries, prevStat, nextStat, persistedTables);
    }

    /**
     * 生成数据桥脚本
     * opts: { mode, template, templateB64, installMvuShim, appendPlaceholder, bridgeScriptName }
     */
    function getCardBridgeInstaller() {
        if (typeof root.__MVU2SHUJUKU_CARD_BRIDGE_INSTALLER__ === 'function') return root.__MVU2SHUJUKU_CARD_BRIDGE_INSTALLER__;
        if (typeof require === 'function') return require('./card-bridge.js');
        throw new Error('卡级注册模块未加载，请使用构建后的 index.js');
    }
    function generateBridgeScript(schema, template, opts = {}) {
        const payload = {
            bridgeVersion: opts.version || VERSION,
            cardName: opts.bridgeCardName || '', cardAvatar: opts.bridgeCardAvatar || '',
            convertedAt: opts.bridgeConvertedAt || '',
            layout: JSON.parse(buildLayoutJson(buildLayout(schema))),
            templateBase64: opts.templateB64 || toBase64(JSON.stringify(template)),
            installMvuShim: opts.installMvuShim !== false,
            statusPlaceholderNeeded: !!opts.statusPlaceholderNeeded,
        };
        return '(' + getCardBridgeInstaller().toString() + ')(' + JSON.stringify(payload) + ', window);';
    }

    /* ================================================================
     * 卡片转换（transformCard / convert）
     * ================================================================ */

    // 仅当正则明确解析 MVU 专属语法时才移除；显示用正则（data_block/状态栏等）原样保留
    // 消息前端用 /<%|%>/ 检测模板标签时，EJS 会把它误编译成单个 |。
    // 仅处理 script 内这类确定的检测字面量；JS 正则和字符串中的字符语义不变。
    // 同时支持酒馆渲染阶段的 HTML 实体形式，不触碰正常 EJS 表达式。
    function protectFrontendEjsLiterals(text) {
        return String(text || '').replace(
            /(<script\b[^>]*>|&lt;script\b(?:(?!&gt;)[\s\S])*?&gt;)([\s\S]*?)(<\/script\s*>|&lt;\/script\s*&gt;)/gi,
            (whole, open, body, close) => open + body.replace(/\/(?:<|&lt;)%\|%(?:>|&gt;)\//g, '/\\x3c%|%\\x3e/') + close
        );
    }

    function isMvuRegex(r) {
        // 只删除整个替换体就是旧变量快照输出的规则。匹配目标、名称、
        // 显示前端中的变量宏/更新块/API 都不能证明整条正则是 MVU 引擎。
        const replacement = String(r.replaceString || '').trim();
        return /^(?:\{\{format_message_variable(?:::[^{}]*)?\}\}|<status_current_variables?>\s*\{\{(?:format_message_variable|get_message_variable)::[^{}]+\}\}\s*<\/status_current_variables?>)$/i.test(replacement);
    }

    function isPureMvuRuleDocument(content) {
        if (/<%|&lt;%/i.test(content)) return false;
        try {
            const clean = String(content).replace(/<!--[\s\S]*?-->/g, '');
            const doc = getMvuYamlLibs().YAML.parseDocument(protectYamlTemplateScalarValues(clean), { merge: true });
            if (doc.errors && doc.errors.length) return false;
            const value = doc.toJS();
            if (!isPlainObject(value)) return false;
            const keys = Object.keys(value);
            const wrapper = keys.find(k => k === '变量更新规则' || k === 'variables_update_rules');
            if (wrapper) return keys.length === 1 && isPlainObject(value[wrapper]);
            return keys.length > 0 && keys.every(k => isPlainObject(value[k])) && /(?:^|\n)[ \t]+(?:type|range|check|format)\s*:/m.test(clean);
        } catch (e) { return false; }
    }

    // 这类正则不负责运行 MVU，只在显示/提示词阶段把原始更新块隐藏或折叠起来。
    // 转换后的桥仍需从原始楼层读取 <initvar>/<UpdateVariable>，所以既不能删原始块，
    // 也不能删掉负责遮蔽/折叠它们的显示层清理正则。
    // 两种安全形态：
    //   1. 空替换：把原始更新块从显示中移除；
    //   2. 折叠替换：用 <details>/<summary> 等静态 HTML 包住匹配到的更新块（$1/$2），
    //      不含脚本、MVU API、变量宏或事件逻辑，只影响显示。
    function isMvuBlockCleanupRegex(r) {
        const find = String(r && r.findRegex || '');
        const replacement = String(r && r.replaceString || '');
        const targetsUpdateBlock = /update(?:variable)?|json_?patch|status_current_variables?/i.test(find);
        if (!targetsUpdateBlock) return false;
        if (replacement === '') return true;
        return /<(?:details|summary|div|span|section)[\s>]/i.test(replacement) &&
            /\$\d/.test(replacement) &&
            !/<script|javascript:|Mvu\s*\.|format_message_variable|status_current_variables|get_message_variable|eventOn|eventSource|=>|function\s*\(/i.test(replacement);
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

    // 这不是 JS 执行器。它只接受转换器已经能静态解析的窄声明子集，借此判断脚本
    // 是否可整体删除。任何额外语句（包括 setInterval、DOM、事件、未知函数调用）都会
    // 留在 remaining 中，从而保守保留原脚本。
    function isPureRegisteredSchemaScript(content, registerName) {
        const identifier = /^[A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*$/;
        const bindings = new Set(['z']);
        let registrations = 0;
        const schemaMethods = new Set(('object record array string number boolean bigint date symbol undefined null void any unknown never literal enum nativeEnum union discriminatedUnion intersection tuple map set promise instanceof optional nullable nullish default prefault catch describe meta min max int positive nonnegative negative nonpositive finite safe multipleOf length nonempty trim toLowerCase toUpperCase email url uuid cuid cuid2 ulid regex datetime time duration ip cidr includes startsWith endsWith base64 base64url jwt nanoid check extend safeExtend merge pick omit partial deepPartial required passthrough strip strict catchall readonly brand pipe transform refine superRefine preprocess lazy').split(' '));
        const callbackMethods = new Set(['transform', 'refine', 'superRefine', 'preprocess', 'lazy', 'default', 'prefault', 'catch', 'check']);
        const balanced = (text, open) => {
            const code = maskJsStringsAndComments(text);
            const pairs = { '(': ')', '[': ']', '{': '}' }, stack = [];
            for (let i = open; i < code.length; i++) {
                if (pairs[code[i]]) stack.push(pairs[code[i]]);
                else if (/[)\]}]/.test(code[i])) {
                    if (stack.pop() !== code[i]) return -1;
                    if (!stack.length) return i;
                }
            }
            return -1;
        };
        const callback = text => /^(?:async\s+)?(?:[A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*|\([^)]*\))\s*=>/.test(text) || /^(?:async\s+)?function\s*\(/.test(text);
        const safeExpression = (raw, depth = 0, allowCallback = false) => {
            if (depth > 40) return false;
            let text = String(raw || '').trim();
            while (text[0] === '(' && balanced(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
            if (!text) return false;
            // 回调只作为声明式 Schema 的参数；其函数体原本由 Zod 执行，不能把
            // 同样的箭头语法用于证明立即调用/顶层业务函数是可删除的。
            if (allowCallback && callback(text)) {
                if (/^(?:async\s+)?function\s*\(/.test(text)) {
                    const code = maskJsStringsAndComments(text);
                    const body = code.indexOf('{');
                    return body >= 0 && balanced(text, body) === text.length - 1;
                }
                return true;
            }
            try { getMvuYamlLibs().JSON5.parse(text); return true; } catch (e) {}
            if (/^(?:undefined|Infinity|NaN)$/.test(text)) return true;
            const code = maskJsStringsAndComments(text);
            if (/^\/(?![/*])/.test(text) && !code.trim()) return true;
            if ((text[0] === '[' || text[0] === '{') && balanced(text, 0) === text.length - 1) {
                return splitJsTopLevelArgs(text.slice(1, -1)).every(part => {
                    if (part.startsWith('...')) return safeExpression(part.slice(3), depth + 1);
                    if (text[0] === '[') return safeExpression(part, depth + 1);
                    const masked = maskJsStringsAndComments(part);
                    let level = 0, colon = -1;
                    for (let i = 0; i < masked.length; i++) {
                        if ('([{'.includes(masked[i])) level++;
                        else if (')]}'.includes(masked[i])) level--;
                        else if (masked[i] === ':' && level === 0) { colon = i; break; }
                    }
                    if (colon < 0) return identifier.test(part) && bindings.has(part);
                    const key = part.slice(0, colon).trim();
                    if (!identifier.test(key) && !/^(['"])[\s\S]*\1$/.test(key)) return false;
                    return safeExpression(part.slice(colon + 1), depth + 1);
                });
            }
            const root = text.match(/^([A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*)/);
            if (!root || !bindings.has(root[1])) return false;
            let at = root[0].length;
            while (at < text.length) {
                const member = text.slice(at).match(/^\s*\.\s*([A-Za-z_$][\w$]*)\s*/);
                if (!member) return false;
                const name = member[1]; at += member[0].length;
                if (text[at] !== '(') {
                    if (!['z', 'coerce', 'shape', 'element'].includes(name)) return false;
                    continue;
                }
                if (!schemaMethods.has(name)) return false;
                const end = balanced(text, at);
                if (end < 0) return false;
                if (!splitJsTopLevelArgs(text.slice(at + 1, end)).every(arg => safeExpression(arg, depth + 1, callbackMethods.has(name)))) return false;
                at = end + 1;
            }
            return true;
        };
        const statements = text => {
            const code = maskJsStringsAndComments(text), result = [];
            let start = 0, depth = 0;
            for (let i = 0; i < code.length; i++) {
                if ('([{'.includes(code[i])) depth++;
                else if (')]}'.includes(code[i])) depth--;
                if (depth < 0) return null;
                const newStatement = code[i] === '\n' && /^\s*(?:import\b|export\b|const\b|let\b|var\b|\$\s*\(|jQuery\s*\(|registerMvuSchema\s*\()/.test(code.slice(i + 1));
                if (depth === 0 && (code[i] === ';' || newStatement)) {
                    result.push(text.slice(start, i)); start = i + 1;
                }
            }
            if (depth !== 0) return null;
            result.push(text.slice(start));
            return result;
        };
        const acceptStatements = (source, depth = 0) => {
            if (depth > 10) return false;
            const items = statements(source);
            if (!items) return false;
            for (let text of items) {
                text = text.trim();
                if (!maskJsStringsAndComments(text).trim()) continue;
                // 去掉边缘注释，保留引号与字符串内容供声明语法检查。
                text = text.replace(/^(?:\s*\/\*[\s\S]*?\*\/|\s*\/\/[^\n]*\n)+/, '').trim();
                const imp = text.match(/^import\s*\{([^}]+)\}\s*from\s*(['"])[^'"\n]+\2\s*$/);
                if (imp) {
                    for (const item of imp[1].split(',')) {
                        const names = item.trim().split(/\s+as\s+/);
                        if (!['registerMvuSchema', 'z'].includes(names[0])) return false;
                        if (names[0] === 'z') bindings.add(names[1] || names[0]);
                    }
                    continue;
                }
                if (/^export\s*\{[^}]*\}\s*$/.test(text)) continue;
                text = text.replace(/^export\s+(?=(?:const|let|var)\b)/, '');
                const decl = text.match(/^(?:const|let|var)\s+([\s\S]+)$/);
                if (decl) {
                    for (const part of splitJsTopLevelArgs(decl[1])) {
                        const assignment = part.match(/^([A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*)\s*=([\s\S]+)$/);
                        if (!assignment || !safeExpression(assignment[2])) return false;
                        bindings.add(assignment[1]);
                    }
                    continue;
                }
                const call = text.match(/^([A-Za-z_$][\w$]*)\s*\(/);
                if (!call) return false;
                const open = text.indexOf('('), end = balanced(text, open);
                if (end !== text.length - 1) return false;
                const args = splitJsTopLevelArgs(text.slice(open + 1, end));
                if (call[1] === registerName) {
                    if (args.length !== 1 || !safeExpression(args[0])) return false;
                    registrations++; continue;
                }
                if (!['$', 'jQuery'].includes(call[1]) || args.length !== 1) return false;
                const ready = args[0].match(/^(?:async\s+)?\(\s*\)\s*=>\s*([\s\S]+)$/);
                if (!ready) return false;
                let body = ready[1].trim();
                if (body[0] === '{' && balanced(body, 0) === body.length - 1) body = body.slice(1, -1);
                if (!acceptStatements(body, depth + 1)) return false;
            }
            return true;
        };
        return acceptStatements(String(content || '')) && registrations > 0;
    }

    // 只识别“应被数据库桥替代的 MVU 引擎/Schema 启动脚本”。调用 Mvu.* 的普通
    // 游戏逻辑是接口消费者，必须保留；兼容层存在并不等于能重新生成被删除的业务代码。
    // 对混合脚本采取保守策略：无法确认是纯框架脚本时保留，避免误删用户功能。
    function isMvuEngineScriptContent(content, scriptName) {
        const s = String(content || '');
        if (!s.trim()) return false;
        const importRe = /(?:^|\n)\s*(?:import\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]\s*;?|(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?)/gmi;
        let hasKnownEngineImport = false;
        let hasSchemaOnlyImport = false;
        let withoutImports = s.replace(importRe, (whole, spec1, spec2) => {
            const spec = String(spec1 || spec2 || '');
            // 仅匹配已知的引擎发布物。不能因为 URL/仓库名里出现 mvu 就删除：很多
            // 配置助手、前端和用户业务模块也会在名字里带 mvu。
            const knownEngine =
                /(?:^|\/)MagicalAstrogy\/MagVarUpdate(?:@[^/]*)?\/(?:artifact|dist)\/[^?#]*(?:bundle|index)[^/?#]*\.js(?:[?#]|$)/i.test(spec) ||
                /(?:^|\/)NLKASHEI\/MVU-offline(?:@[^/]*)?\/[^?#]*mvu[_-]?bundle[^/?#]*\.js(?:[?#]|$)/i.test(spec);
            if (knownEngine) {
                hasKnownEngineImport = true;
                return '\n';
            }
            // 纯 Schema 启动器会在兼容层已接管落库后再注册一套旧 Zod
            // 生命周期，并增加后续外部脚本的启动链。只在“脚本名明确是
            // MVU Zod/Schema + URL 明确为 data/variable schema + 整个脚本仅 import”
            // 三个条件同时满足时移除；其它外部 import 仍保守保留。
            const schemaNamed = /(?:mvu[^\n]*zod|zod[^\n]*mvu|mvu[^\n]*schema|schema[^\n]*mvu)/i.test(String(scriptName || ''));
            const schemaUrl = /(?:^|[/_.-])(?:data|variable|mvu)[_-]?schema(?:[/_.-]|$)/i.test(spec);
            if (schemaNamed && schemaUrl) {
                hasSchemaOnlyImport = true;
                return '\n';
            }
            return whole;
        });
        // 单行/纯 import 的官方引擎、离线镜像：确定可删。
        if ((hasKnownEngineImport || hasSchemaOnlyImport) && !withoutImports.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|[;\s]/g, '')) return true;
        // registerMvuSchema 本身不能证明整段脚本是纯声明：其后可以接定时器、DOM、
        // 事件或任意业务代码。只有整个脚本能被限定为 import + z 声明 + 注册调用时
        // 才删除；不能证明的内容一律保留。
        const schemaRegisterAlias = (() => {
            const aliased = s.match(/\bregisterMvuSchema\s+as\s+([A-Za-z_$][\w$]*)/);
            if (aliased) return aliased[1];
            return /\bregisterMvuSchema\b/.test(s) ? 'registerMvuSchema' : '';
        })();
        if (schemaRegisterAlias && isPureRegisteredSchemaScript(s, schemaRegisterAlias)) return true;
        // 未知内联 bundle 即使很大也可能混有业务，无法证明来源时保留并报告。
        return false;
    }

    // 纯外部 Schema 启动器必须与旧 MVU 引擎一起移除，避免它继续按旧 Zod
    // 拦截数据库桥命令；但导入模块正文不在角色卡内，转换器无法静态迁移其
    // 独有字段/约束。单独识别这一情形，以便删除时给出明确的人工核对项。
    function isUninspectableExternalSchemaImport(content, scriptName) {
        const s = String(content || '');
        const schemaNamed = /(?:mvu[^\n]*zod|zod[^\n]*mvu|mvu[^\n]*schema|schema[^\n]*mvu)/i.test(String(scriptName || ''));
        if (!schemaNamed) return false;
        let found = false;
        const importRe = /(?:^|\n)\s*(?:import\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]\s*;?|(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?)/gmi;
        const withoutImports = s.replace(importRe, (whole, spec1, spec2) => {
            const spec = String(spec1 || spec2 || '');
            if (/(?:^|[/_.-])(?:data|variable|mvu)[_-]?schema(?:[/_.-]|$)/i.test(spec)) {
                found = true;
                return '\n';
            }
            return whole;
        });
        return found && !withoutImports.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|[;\s]/g, '');
    }

    // 整页注入模式：replaceString 用 $('body').load(...) 把整个前端页面塞进 body。
    // 以 body 内的 DOM 标记判断应用是否实际存在。消息重渲染清空 body 后标记也会消失，
    // 下次正则执行可自动重挂载；loading 标记只防止同一次渲染并发加载。
    function guardBodyLoadFrontend(text) {
        const t = String(text || '');
        const re = /((?:window\.)?(?:jQuery|\$)\s*\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*)((?:"[^"]*"|'[^']*'))(\s*\))/g;
        const replace = (_whole, loadPrefix, urlLiteral) => {
            // 部分旧前端只在首次 mount 时读取变量，不监听 VARIABLE_UPDATE_ENDED。
            // 保存原 body.load 为可手动调用的加载器；不再对每次表格写入自动重载整页，
            // 避免丢失页面局部状态、额外请求以及旧页面 mount 副作用造成的写入循环。
            return `(()=>{var _w=window;var _load=function(){if(_w.__mvu2shujukuFrontendLoading)return;_w.__mvu2shujukuFrontendLoading=true;${loadPrefix}${urlLiteral},function(_r,_s){_w.__mvu2shujukuFrontendLoading=false;if(_s!=="error"){try{$("body").append("<i id=\\"mvu2shujuku-frontend-mounted\\" hidden></i>");}catch(e){};try{_w.__mvu2shujukuFrontendLoaded=true;}catch(e){};try{if(_w.parent)_w.parent.__mvu2shujukuFrontendLoaded=true;}catch(e){};try{if(_w.top)_w.top.__mvu2shujukuFrontendLoaded=true;}catch(e){}}});};_w.__mvu2shujukuReloadFrontend=_load;if(!document.getElementById("mvu2shujuku-frontend-mounted"))_load();})()`;
        };
        return {
            text: t.replace(re, replace),
            count: (t.match(re) || []).length,
        };
    }

    // 内联 module 前端常在首次 mount 时同步读取一次 message stat_data，随后不监听
    // VARIABLE_INITIALIZED。数据库扩展/桥对 iframe 的 getVariables 接管是异步的；模块
    // 若先执行，就会把空对象固化进 Vue/React store。仅对明确直接读取 message 作用域的
    // 内联 module 加短时门禁，等待本转换器 shim 出现后再运行原模块；不解析业务路径。
    function guardInlineMessageFrontendDataReady(text) {
        const t = String(text || '');
        if (!/<script\b(?=[^>]*\btype\s*=\s*['"]module['"])[^>]*>/i.test(t)) return { text: t, count: 0 };
        if (!/getVariables\s*\(\s*\{[^}]*\btype\s*:\s*['"]message['"]/i.test(t)) return { text: t, count: 0 };
        if (t.includes('__mvu2shujukuAwaitMessageVariables')) return { text: t, count: 0 };
        const prelude = `\nawait new Promise(function(resolve){var started=Date.now();function check(){try{var fn=globalThis.getVariables;if(typeof fn==='function'&&(fn.__mvu2shujuku||fn.__mvu2shujukuBridge))return resolve();}catch(e){}if(Date.now()-started>=12000)return resolve();setTimeout(check,25);}check();});/*__mvu2shujukuAwaitMessageVariables*/\n`;
        let count = 0;
        const out = t.replace(/<script\b(?=[^>]*\btype\s*=\s*['"]module['"])[^>]*>/i, m => {
            count++;
            return m + prelude;
        });
        return { text: out, count };
    }

    // 旧式状态栏常在 DOMContentLoaded 中只执行一次
    //   const messages = await getChatMessages(getCurrentMessageId())
    // 随后直读 message.data.stat_data/display_data。新 iframe 可能比扩展的
    // getChatMessages 投影 shim 更早执行；第一次空读后又没有事件重试。
    // 只对“已在 async 上下文中 await getChatMessages，且正文明确读 MVU
    // message data”的脚本插入门禁；普通消息前端不介入。
    function guardInlineChatMessageFrontendDataReady(text) {
        const t = String(text || '');
        if (!/\bawait\s+getChatMessages\s*\(/.test(t)) return { text: t, count: 0 };
        if (!/(?:\.data|\[['"]data['"]\])[\s\S]{0,240}(?:stat_data|display_data)|(?:stat_data|display_data)[\s\S]{0,240}(?:\.data|\[['"]data['"]\])/.test(t)) return { text: t, count: 0 };
        if (t.includes('__mvu2shujukuAwaitChatMessages')) return { text: t, count: 0 };
        let count = 0;
        const out = t.replace(/((?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)await\s+getChatMessages\s*\(/, (_m, decl, offset) => {
            count++;
            const enclosing = [...t.slice(0, offset).matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
            const refreshHook = enclosing
                ? `try{globalThis.__mvu2shujukuRefreshInlineFrontend=function(){return ${enclosing[1]}();};}catch(e){}\n`
                : '';
            const prelude = refreshHook + `await new Promise(function(resolve){var started=Date.now();function check(){try{var fn=globalThis.getChatMessages;if(typeof fn==='function'&&(fn.__mvu2shujuku||fn.__mvu2shujukuBridge))return resolve();}catch(e){}if(Date.now()-started>=12000)return resolve();setTimeout(check,25);}check();});/*__mvu2shujukuAwaitChatMessages*/\n`;
            return prelude + decl + 'await getChatMessages(';
        });
        return { text: out, count };
    }

    // 标记卡内真正的数据前端，供运行时刷新时选择安全入口。只识别含脚本且
    // 明确读取 MVU/数据库数据的 HTML；普通展示 HTML 保持完全不变。
    function markCardFrontendMode(text) {
        const t = String(text || '');
        if (!/<script\b/i.test(t)) return { text: t, mode: '', count: 0 };
        const eventRegistration = /(?:eventOn|addEventListener)\s*\(\s*(?:(?:window\s*\.\s*)?Mvu\s*\.\s*events\s*\.\s*VARIABLE_UPDATE_ENDED|["']mag_variable_update_ended["'])/i.test(t);
        const directRegistration = /__mvu2shujukuReloadFrontend|__mvu2shujukuRefreshInlineFrontend/.test(t);
        if (!/(?:getVariables|getAllVariables|getChatMessages|Mvu\s*\.\s*getMvuData|\bstat_data\b|\bdisplay_data\b)/i.test(t) && !eventRegistration && !directRegistration) {
            return { text: t, mode: '', count: 0 };
        }
        let mode = 'reload';
        if (directRegistration) mode = 'direct';
        else if (eventRegistration) mode = 'event';
        else if (/data-mvu-refresh|(?:title|aria-label)\s*=\s*["'](?:刷新数据|Refresh data)["']/.test(t)) mode = 'control';
        const attr = 'data-mvu2shujuku-frontend="' + mode + '"';
        let out = t;
        if (/<html\b/i.test(out)) out = out.replace(/<html\b([^>]*)>/i, (m, a) => /data-mvu2shujuku-frontend\s*=/.test(a) ? m : '<html' + a + ' ' + attr + '>');
        else if (/<body\b/i.test(out)) out = out.replace(/<body\b([^>]*)>/i, (m, a) => /data-mvu2shujuku-frontend\s*=/.test(a) ? m : '<body' + a + ' ' + attr + '>');
        else if (!/__mvu2shujukuFrontendMode/.test(out)) {
            out = out.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, m => m + '\\n' +
                'globalThis.__mvu2shujukuFrontendMode="' + mode + '";');
        }
        return { text: out, mode, count: out === t ? 0 : 1 };
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
    // 旧 MVU 卡可开启“同步到聊天变量”，业务脚本因而会用裸顶层路径读取
    // getVariables({type:'chat'})，再 replaceVariables(...,{type:'chat'}) 写回。
    // 数据库转换卡不应把整个 chat 作用域全局改绑；这里只改写能静态证明为一次
    // “读取已知 stat_data 顶层组 → 修改 → 原变量写回”的局部事务。
    function rewriteLegacyMvuChatMirrorScript(source, groupNames) {
        let text = String(source || '');
        const groups = (Array.isArray(groupNames) ? groupNames : []).map(String).filter(Boolean);
        if (!groups.length || !/getVariables\s*\(\s*\{\s*type\s*:\s*['"]chat['"]\s*\}\s*\)/.test(text)) return { text, count: 0 };
        const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const groupPathRe = new RegExp("['\"](?:" + groups.map(escapeRe).join('|') + ")(?:\\.|['\"])");
        const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*getVariables\s*\(\s*\{\s*type\s*:\s*['"]chat['"]\s*\}\s*\)/g;
        const edits = [];
        let m;
        while ((m = assignRe.exec(text))) {
            const varName = m[1];
            const varEsc = escapeRe(varName);
            const tail = text.slice(m.index, Math.min(text.length, m.index + 5000));
            const replaceRe = new RegExp('replaceVariables\\s*\\(\\s*' + varEsc + '\\s*,\\s*\\{\\s*type\\s*:\\s*[\'\"]chat[\'\"]\\s*\\}\\s*\\)');
            const replaceM = replaceRe.exec(tail);
            if (!replaceM) continue;
            const transaction = tail.slice(0, replaceM.index + replaceM[0].length);
            const context = text.slice(Math.max(0, m.index - 3000), m.index + replaceM.index + replaceM[0].length);
            const usesVar = new RegExp('_.(?:get|set|has|unset)\\s*\\(\\s*' + varEsc + '\\s*,').test(transaction);
            if (!usesVar || !groupPathRe.test(context)) continue;
            const callOffset = m[0].indexOf('getVariables');
            edits.push({ start: m.index + callOffset, end: m.index + m[0].length, value: 'Mvu.getMvuData({type:"message",message_id:"latest"}).stat_data' });
            edits.push({ start: m.index + replaceM.index, end: m.index + replaceM.index + replaceM[0].length, value: `Mvu.replaceMvuData({stat_data:${varName}})` });
        }
        if (!edits.length) return { text, count: 0 };
        edits.sort((a, b) => b.start - a.start);
        for (const e of edits) text = text.slice(0, e.start) + e.value + text.slice(e.end);
        return { text, count: edits.length / 2 };
    }

    function transformCard(card, opts = {}) {
        const report = opts.report || createReport();
        const mode = opts.mode || 'both';
        const nameSuffix = opts.nameSuffix !== undefined ? opts.nameSuffix : '_数据库';
        const data = card.data || card;
        const cb = data.character_book || {};
        const entries = Array.isArray(cb.entries) ? cb.entries : [];

        // 1. initvar。MVU 语义（源码 initCheck/loadInitVarData）：
        //    - 世界书 comment 含 [InitVar] 的条目是“基础初始化”（合并多个条目）；
        //    - 首条消息（swipe）里的 <initvar> 块按分支独立覆盖，以块内容为基准，
        //      分支之间绝不合并；有块时忽略世界书 [InitVar]。
        //    部分卡把 initvar 写在“别的世界书”条目末尾的 <initvar> 标签里
        //    （如 [scenario_builtin] 多个开局：残明余烬 1.8.1 街头魂穿/云际寺夺银/
        //    凤阳惊变，前端把选中开局写进首楼后由 MVU 读取）——这些条目与问候语一样
        //    是分支初始状态，参与结构推导与动态键识别（运行时仍按首楼 <initvar> 注入）。
        const initEntries = entries.filter(e => /\[initvar\]/i.test(String(e.comment || '')));
        // 其他世界书条目内容里的 <initvar> 块（排除 [InitVar] 条目本身）
        const branchEntrySources = entries.filter(e =>
            !/\[initvar\]/i.test(String(e.comment || '')) && /<initvar>/i.test(String(e.content || ''))
        );
        let initvar = {};
        let greetingBlockCount = 0;
        let firstBranchDesc = '';
        // 全部分支的解析结果：问候语分支 + 世界书条目分支（供动态键差异识别）
        const branchParsed = [];
        const pushBranch = (text, desc) => {
            const m = String(text).match(/<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/i);
            if (!m) return;
            try {
                const parsed = parseInitVar(m[1]);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    branchParsed.push(parsed);
                    greetingBlockCount++;
                    if (!firstBranchDesc) firstBranchDesc = desc;
                }
            } catch (e) {}
        };
        if (initEntries.length) {
            for (const initEntry of initEntries) {
                let content = String(initEntry.content || '');
                // MVU 的包裹剥离顺序：<initvar> XML 包裹 → ``` 代码块包裹
                const wrapped = content.match(/^\s*<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>\s*$/i);
                if (wrapped) content = wrapped[1];
                const codeblock = content.match(/^\s*```[^\n]*\n?([\s\S]*?)\n?\s*```\s*$/);
                if (codeblock) content = codeblock[1];
                let parsed;
                try {
                    parsed = parseInitVar(content);
                } catch (parseErr) {
                    report.warn(`[InitVar] 条目解析失败，已跳过该条目：${parseErr && parseErr.message ? parseErr.message : parseErr}`, 'schema');
                    continue;
                }
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    initvar = deepMerge(initvar, parsed);
                } else {
                    report.warn(`[InitVar] 条目解析结果不是对象，已跳过该条目`, 'schema');
                }
            }
            if (Object.keys(initvar).length) {
                report.note(`已解析 ${initEntries.length} 个 [initvar] 条目（合并）：顶层组 ${Object.keys(initvar).join('、')}。`);
            } else {
                report.warn('世界书 [InitVar] 条目存在但解析后为空（占位/已迁移），尝试从分支 <initvar> 推导结构。', 'schema');
            }
        }
        // 分支层来源：问候语（first_mes / alternate_greetings）优先，其次其他世界书条目
        const greetingSources = [data.first_mes, ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])];
        for (const g of greetingSources) pushBranch(g, '问候语');
        for (const be of branchEntrySources) {
            pushBranch(String(be.content || ''), `世界书条目「${String(be.comment || (be.id != null ? be.id : '未命名'))}」`);
        }
        if (!Object.keys(initvar).length && branchParsed.length) {
            initvar = branchParsed[0];
            report.note(
                `角色卡世界书 [InitVar] 为空，已改用分支 <initvar> 推导结构：共 ${branchParsed.length} 个分支` +
                (firstBranchDesc ? `，首个来自 ${firstBranchDesc}` : '') +
                `；以首个分支为基准（MVU 按分支替换、不合并），各分支初始化值在开局时按所选分支注入。`
            );
        }
        if (Object.keys(initvar).length === 0) {
            const msg =
                `未找到可用的 [InitVar] 或分支 <initvar>，无法识别为 MVU 变量卡。` +
                `（当前角色卡：${data.name || '未知'}；世界书条目数=${entries.length}；` +
                `first_mes/额外问候语中 <initvar> 块数=${greetingBlockCount}；` +
                `其他世界书条目含 <initvar> 块数=${branchEntrySources.length}。）` +
                `MVU 变量卡必须在世界书条目 comment 中含 [InitVar]（可禁用状态），` +
                `在问候语中用 <initvar> 声明初始结构，或把 initvar 写在其他世界书条目（如 [scenario_builtin]）的 <initvar> 标签中。` +
                (entries.length === 0 ? `若角色列表里的对象不包含世界书数据，请改用「选择文件」导入卡文件后转换。` : `若 [InitVar] 写在全局世界书/联动世界书中，请将其并入卡内后重试。`) +
                `已中止转换，卡未被修改。`;
            console.error('[mvu2shujuku] ' + msg);
            const e = new Error(msg);
            e.code = 'NOT_MVU_CARD';
            throw e;
        }

        // 与 MVU initCheck 完全一致：先从原始 InitVar 读取 $meta 生成结构规则，
        // 再从实际 stat_data 清除全部元数据。分支 <initvar> 也执行同一处理，避免
        // 分支差异扫描把 $meta.required/template 当成业务键。
        const initMetadata = analyzeMvuInitMetadata(initvar);
        initvar = initMetadata.data;
        const branchMetadataAnalyses = [];
        for (const branch of branchParsed) {
            const analyzed = analyzeMvuInitMetadata(branch);
            branchMetadataAnalyses.push(analyzed);
        }

        const usage = scanStatusUsage(card, Object.keys(initvar));
        report.note(`状态栏/脚本字段扫描：${Object.keys(usage).map(g => `${g}(${usage[g].length})`).join('、') || '无'}。`);

        const shapeInfo = parseMvuShapes(card, report);
        // Zod prefault/default 是缺值时的声明式初始值。这里只补静态字面量，不执行
        // 函数或 transform；已有 InitVar 值始终优先，符合 Zod 对已提供输入的处理。
        if (shapeInfo.zodSchemaRoot) {
            const filled = applyRegisteredZodDefaults(initvar, shapeInfo.zodSchemaRoot);
            if (filled) report.note(`已按酒馆助手 Zod Schema 的 prefault/default 补齐 ${filled} 个缺省初始值。`);
        }
        shapeInfo.mvuMetadata = initMetadata.metadata;
        for (const path of initMetadata.dynamicPaths) shapeInfo.dynamicPaths.add(path);
        for (const [path, sample] of initMetadata.dynamicPathSamples) {
            if (!shapeInfo.dynamicPathSamples) shapeInfo.dynamicPathSamples = new Map();
            shapeInfo.dynamicPathSamples.set(path, sample);
        }
        for (const analyzed of branchMetadataAnalyses) {
            for (const path of analyzed.dynamicPaths) shapeInfo.dynamicPaths.add(path);
            for (const [path, sample] of analyzed.dynamicPathSamples) {
                if (!shapeInfo.dynamicPathSamples) shapeInfo.dynamicPathSamples = new Map();
                if (!shapeInfo.dynamicPathSamples.has(path)) shapeInfo.dynamicPathSamples.set(path, sample);
            }
        }
        // 多分支兜底：即使 [mvu_update] 未声明动态键，也按各分支 <initvar> 的键集差异
        // 识别动态键字典（如 世界系统.修仙秘闻），避免固定列在按分支注入时丢数据。
        try {
            const gv = scanGreetingShapeVariation(data, branchEntrySources.map(e => String(e.content || '')));
            for (const dp of gv.dynamicPaths) shapeInfo.dynamicPaths.add(dp);
            for (const dg of gv.dynamicGroups) shapeInfo.dynamicGroups.add(dg);
            shapeInfo.dynamicPathSamples = shapeInfo.dynamicPathSamples || new Map();
            for (const [path, sample] of (gv.samples || new Map())) {
                if (!shapeInfo.dynamicPathSamples.has(path)) shapeInfo.dynamicPathSamples.set(path, sample);
            }
            if (shapeInfo.dynamicPaths.size || Object.keys(shapeInfo.dynamicDicts || {}).length) {
                const dynDescs = [];
                for (const g of Object.keys(shapeInfo.dynamicDicts || {})) {
                    for (const f of Object.keys(shapeInfo.dynamicDicts[g])) dynDescs.push(`${g}.${f}`);
                }
                for (const p of shapeInfo.dynamicPaths) if (!dynDescs.includes(p)) dynDescs.push(p);
                report.note(`已识别动态键字典（条目键为运行期内容，按子行表转换）：${dynDescs.join('、')}。`);
            }
        } catch (e) {}
        // InitVar 的显式 $meta 比规则文本/分支启发式更权威。多分支按官方 schema
        // 继承的“开放取并集”处理：任一分支显式开放/template 就必须保留动态表；
        // 只有所有声明都属于固定对象时，才撤销启发式误判。
        const metadataByPath = new Map();
        for (const analyzed of [initMetadata, ...branchMetadataAnalyses]) {
            for (const [path, meta] of analyzed.metadata) {
                if (!metadataByPath.has(path)) metadataByPath.set(path, []);
                metadataByPath.get(path).push(meta);
            }
        }
        for (const [path, metas] of metadataByPath) {
            if (!path || !metas.length || metas.some(meta => !meta || meta.kind !== 'object')) continue;
            const anyDynamic = metas.some(meta => meta.template !== undefined || (meta.extensible === true && (!Array.isArray(meta.required) || meta.required.length === 0)));
            if (!anyDynamic) {
                shapeInfo.dynamicPaths.delete(path);
                if (path.indexOf('.') === -1) shapeInfo.dynamicGroups.delete(path);
                const parts = path.split('.');
                if (parts.length === 2 && shapeInfo.dynamicDicts[parts[0]]) {
                    delete shapeInfo.dynamicDicts[parts[0]][parts[1]];
                }
            }
        }
        // 正则回退解析压缩/嵌套 type 时，可能把“子条目字段”同时提升为父组字段。
        // 若父组并不存在该字段，而某个已确认的直接动态子容器声明了同名动态字段，
        // 则以更具体的子容器归属为准，避免同时生成 G.F 与 G.C.*.F 两套表。
        for (const [group, declared] of Object.entries(shapeInfo.dynamicDicts || {})) {
            const groupData = initvar[group];
            if (!isPlainObject(groupData)) continue;
            for (const field of Object.keys(declared || {})) {
                if (Object.prototype.hasOwnProperty.call(groupData, field)) continue;
                const ownedByChild = Object.keys(groupData).some(child => {
                    if (!shapeInfo.dynamicPaths.has([group, child].join('.'))) return false;
                    const childSchemas = shapeInfo.objectSchemas[child] || {};
                    return !!(childSchemas[field] && childSchemas[field].kind === 'object' && childSchemas[field].dynamic);
                });
                if (ownedByChild) delete declared[field];
            }
        }
        if (Object.keys(shapeInfo.shapes).length) {
            report.note(`已从 [mvu_update]/Zod 结构声明解析列：${Object.keys(shapeInfo.shapes).map(g => `${g}(${shapeInfo.shapes[g].length})`).join('、')}。`);
        }
        if (shapeInfo.wildcardFields && shapeInfo.wildcardFields.size) {
            report.warn(
                `检测到通配路径规则（如 ${[...shapeInfo.wildcardFields].slice(0, 5).join('、')}${shapeInfo.wildcardFields.size > 5 ? ' 等' : ''}）：动态键（门牌/角色名等）无法展开为列，规则已按表级「可写路径与约束」保留进提示词，具体键值以运行时快照为准，请人工核对。`,
                'schema'
            );
        }
        const schema = buildSchema(initvar, usage, report, shapeInfo);
        const layout = buildLayout(schema);
        const template = opts.template || generateTemplate(schema, { mode, report, ddlIncludeCheck: opts.ddlIncludeCheck });
        const sourceRegexScripts = (data.extensions && Array.isArray(data.extensions.regex_scripts))
            ? data.extensions.regex_scripts
            : [];
        migrateTemplatePromptRuntime(template, sourceRegexScripts, report);

        // 2. 检测卡内是否依赖 MVU API
        // 静态扫描只能看到卡内文本；tavern_helper 里 `import 'https://…'` 的外部脚本
        // （CDN 拉取的游戏逻辑）在卡内只有一行 import，看不到实际调用。
        // 这类卡默认也装 MVU 兼容层，避免“看不见就不装”导致外部脚本调 Mvu.* 时落空。
        const blobs = cardTextBlobs(card);
        const usesMvu = blobs.some(b => /Mvu\s*\./i.test(b.text));
        const hasExternalImport = blobs.some(b => (
            /(?:^|[^.\w])import\s*(?:\(\s*)?['"](?:https?:)?\/\//i.test(b.text) ||
            /import\s*\(\s*['"]https?:\/\//i.test(b.text)
        ));
        const installMvuShim = opts.installMvuShim !== undefined ? !!opts.installMvuShim : (usesMvu || hasExternalImport);
        if (hasExternalImport && !usesMvu) {
            report.note('检测到外部 import 脚本（卡内只有 import 行，静态扫描无法确认是否调用 MVU API），默认安装 MVU 兼容层兜底。');
        }
        // 转换时即确定是否依赖 <StatusPlaceHolderImpl/>（前端注入正则），写死进桥，
        // 避免运行时读取懒加载角色对象导致检测失败
        const statusPlaceholderNeeded = ((data.extensions && data.extensions.regex_scripts) || [])
            .some(r => String(r.findRegex || '').indexOf('StatusPlaceHolderImpl') !== -1);

        const convertedAt = new Date().toISOString();
        const bridgeOptions = {
            mode,
            template,
            installMvuShim,
            appendPlaceholder: opts.appendPlaceholder !== false,
            statusPlaceholderNeeded,
            bridgeScriptName: opts.bridgeScriptName || `${data.name || '角色'}·数据库数据桥`,
            bridgeCardName: String(data.name || ''),
            bridgeConvertedAt: convertedAt,
            bridgeCardAvatar: String((data && data.avatar) || (card && card.avatar) || ''),
            jsonrepairInline: getJsonrepairSource(),
        };
        const bridgeScript = generateBridgeScript(schema, template, bridgeOptions);

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
            // MVU 写入/输出管道特征，用于区分“该删的管道”与“误标成
            // [mvu_update] 的剧情/机制文本”。format_message_variable、
            // get_message_variable、getvar(stat_data...) 都只是读取变量，常被业务规则
            // 用作条件或插值；仅凭读取痕迹绝不能整条删除。
            const explicitUpdateEntry = /\[mvu[ _-]?update\]|\[mvuupdate\]/i.test(comment);
            const entryTitle = comment.replace(/\[mvu[ _-]?update\]|\[mvuupdate\]/ig, '').trim();
            // 一部分 Zod 卡没有 [mvu_update] 前缀，只用中文专名区分规则与
            // 输出协议。必须同时校验 comment 和正文结构，避免仅因普通剧情提到
            // “变量更新规则”就删除整个条目。
            const dedicatedRuleEntry = /^(?:变量(?:更新)?规则|变量规则)(?:\s*[_-]?(?:zod|mvu)(?:版)?)?$/i.test(entryTitle);
            const dedicatedProtocolEntry = /^变量(?:处理|更新|输出)(?:指令集|指令|协议)(?:\s*[_-]?(?:zod|mvu)(?:版)?)?$/i.test(entryTitle);
            const dedicatedOutputEntry = /^(?:variables?|output_format)(?:\s*\([^)]*\))?$/i.test(entryTitle) ||
                /^(?:变量列表|变量(?:更新|输出)格式(?:强调)?|变量输出规则)(?:\s*\([^)]*\))?$/i.test(entryTitle) || dedicatedProtocolEntry;
            const ruleDocumentContent = /(?:^|\n)\s*(?:变量更新规则|variables_update_rules)\s*:|(?:^|\n)[ \t]+(?:type|range|check|format)\s*:/mi.test(content);
            const outputProtocolContent = /<status_current_variables?|get_message_variable\s*::\s*stat_data|<UpdateVariable|<JSONPatch|json\s*patch|每轮[^\n]{0,40}(?:必须)?输出|^\s*格式:\s*_\.set\s*\(/i.test(content);
            const pureStatusOutput = /^\s*<status_current_variables?>[\s\S]*<\/status_current_variables?>\s*$/i.test(content) &&
                /get_message_variable|stat_data/i.test(content);
            // 某些卡用单个箭头/图标作为变量管线的起止占位。只识别这种
            // 纯符号 marker；不再用“少于 60 字”猜测，避免删掉 lastUserMessage 等短上下文。
            const purePipelineMarker = explicitUpdateEntry && /变量|更新|输出/i.test(comment) &&
                /^\s*[🔻🔺▼▲↓↑⬇⬆⏬⏫─━—_=*#.:;\-]+\s*$/u.test(content);
            const isMvuUpdate = !isPlot && (
                (explicitUpdateEntry && (!String(content).trim() || purePipelineMarker)) ||
                ((dedicatedRuleEntry || explicitUpdateEntry) && ruleDocumentContent && isPureMvuRuleDocument(content)) ||
                // 输出文档必须是完整专名；有 EJS 的混合业务不能凭名称删除。
                (dedicatedOutputEntry && outputProtocolContent && !/<%|&lt;%/i.test(content)) ||
                // 教程中 comment 可任意命名；整个正文只有变量快照标签时仍是纯输出管线。
                pureStatusOutput);
            if (isInit || isMvuUpdate) {
                report.note(`已删除 MVU 世界书条目「${comment}」（${isInit ? '初始变量' : '更新规则'}已迁移为数据库模板/规则）。`);
                continue;
            }
            if ((dedicatedRuleEntry || explicitUpdateEntry) && ruleDocumentContent) {
                report.warn(`规则条目「${comment}」无法确认为完整静态规则文档，已保留原条目；已提取的规则可能不完整，请核对后决定是否停用原条目。`, 'schema');
            }
            if (!isPlot && /<UpdateVariable|<JSONPatch|\.set\s*\(\s*['"]/i.test(content)) {
                report.note(`世界书条目「${comment}」同时含剧情/EJS 与 MVU 更新块，已完整保留；更新块由数据桥在运行时解析。`);
            }
            // EJS 重写
            const rw = rewriteEjsConditions(content, layout, report, {
                translateSimpleEjs: !!opts.translateSimpleEjs,
            });
            if (rw.items.length) {
                for (const it of rw.items) {
                    if (it.status === 'auto') {
                        report.auto(`条目「${comment}」MVU 数据读取已改写为扩展注册的 mvu2shujukuGetAllVariables()：\`${it.rewritten}\``);
                    }
                }
            }
            const copy = deepClone(e);
            const afterFormatMacros = rewriteFormatMessageVariableMacros(rw.text, report, `条目「${comment}」`);
            const afterMacros = rewritePlotMacros(afterFormatMacros);
            if (afterMacros !== afterFormatMacros) {
                report.auto(`条目「${comment}」的 MVU 宏 {{get_message_variable::…}} 已改写为数据库表引用（剧情条目保留）。`);
            }
            copy.content = afterMacros;
            newEntries.push(copy);
        }
        isolateCrossEntryEjsFallbacks(newEntries, report);
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
        const pushFrontendRegex = (rx) => {
            const copy = deepClone(rx);
            copy.replaceString = rewriteFormatMessageVariableMacros(copy.replaceString || '', report, `正则「${copy.scriptName || copy.name || ''}」`);
            copy.replaceString = protectFrontendEjsLiterals(copy.replaceString || '');
            const marked = markCardFrontendMode(copy.replaceString || '');
            copy.replaceString = marked.text;
            keptRegexes.push(copy);
        };
        for (const r of regexes) {
            const name = String(r.scriptName || '');
            if (isMvuBlockCleanupRegex(r)) {
                keptRegexes.push(deepClone(r));
                const cleanupKind = String(r.replaceString || '') === '' ? '隐藏' : '折叠显示';
                report.note(`已保留 MVU 标签清理正则「${name}」：它只${cleanupKind}原始更新块，不负责执行 MVU；数据库桥仍从原始楼层读取分支初始化/更新。`);
                continue;
            }
            if (isMvuRegex(r)) {
                report.note(`已移除纯 MVU 变量快照输出正则「${name}」（整个替换体仅为旧变量快照宏）。`);
                continue;
            }
            if (/format_message_variable|status_current_variables|<UpdateVariable\b/i.test(String(r.replaceString || '') + '\n' + String(r.findRegex || ''))) {
                report.note(`已保留含 MVU 语法的正则「${name}」：无法证明整个替换体仅为旧变量输出，显示/业务代码交由兼容层运行，请核对实际效果。`);
            }
            // 内联 Vue/React 等消息前端：若只在 mount 时读取一次 message stat_data，
            // 等数据库 getVariables shim 装好后再启动，避免把初始化窗口的空值固化。
            const inlineReady = guardInlineMessageFrontendDataReady(r.replaceString || '');
            if (inlineReady.count) {
                const copy = deepClone(r);
                copy.replaceString = inlineReady.text;
                report.auto(`正则「${name}」为一次性读取消息变量的内联 module 前端，已等待数据库变量入口就绪后再启动。`);
                const inj = injectOpeningUserDataSync(copy.replaceString, schema, report);
                if (inj.injected) copy.replaceString = inj.script;
                pushFrontendRegex(copy);
                continue;
            }
            const chatMessageReady = guardInlineChatMessageFrontendDataReady(r.replaceString || '');
            if (chatMessageReady.count) {
                const copy = deepClone(r);
                copy.replaceString = chatMessageReady.text;
                report.auto(`正则「${name}」为一次性读取 message.data 的状态栏，已等待数据库消息投影入口就绪后再读取。`);
                const inj = injectOpeningUserDataSync(copy.replaceString, schema, report);
                if (inj.injected) copy.replaceString = inj.script;
                pushFrontendRegex(copy);
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
                pushFrontendRegex(copy);
                continue;
            }
            // 非整页注入的前端同样尝试注入开场白用户数据同步
            if (/characterData\s*=\s*\{/.test(String(r.replaceString || ''))) {
                const inj = injectOpeningUserDataSync(r.replaceString || '', schema, report);
                if (inj.injected) {
                    const copy = deepClone(r);
                    copy.replaceString = inj.script;
                    pushFrontendRegex(copy);
                    continue;
                }
            }
            // 状态栏刷新事件保持原样：数据桥每次写入都会广播 mag_variable_update_ended（与 MVU 原版一致），
            // 前端原有 eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...) 监听即可活体刷新，无需改写
            if (isMvuScriptContent(r.replaceString || '')) {
                report.manual(`正则「${name}」含 MVU API 调用；转换器保留它并依赖数据桥 MVU 兼容层，若逻辑异常请人工改为数据库 API。`);
            }
            pushFrontendRegex(r);
        }
        if (data.extensions) data.extensions.regex_scripts = keptRegexes;

        // 5. tavern_helper 脚本处理
        const th = (data.extensions && data.extensions.tavern_helper) || {};
        const scripts = Array.isArray(th.scripts) ? th.scripts : [];
        const keptScripts = [];
        for (const s of scripts) {
            const content = String(s.content || '');
            if (isMvuEngineScriptContent(content, s.name)) {
                if (isUninspectableExternalSchemaImport(content, s.name)) {
                    report.manual(`已移除纯外部 Schema 导入「${s.name}」以避免旧 Zod 继续拦截数据库更新；导入模块正文不在角色卡内，无法核对其中独有字段、默认值和校验。若转换报告/表格缺少这些内容，请提供该模块源码后人工补入模板。`);
                }
                report.note(`已移除 tavern_helper 脚本「${s.name}」（明确识别为 MVU 引擎/Schema 启动脚本：${content.slice(0, 80)}…）。`);
                continue;
            }
            const isExternal = /(?:^|[^.\w])import\s*(?:\(\s*)?['"](?:https?:)?\/\//i.test(content) || /import\s*\(\s*['"]https?:\/\//i.test(content);
            const usesMvuApi = /\bMvu\s*\./.test(content);
            const ambiguousMvuImport = isExternal && /(?:magvar|mvu)/i.test(content) && !usesMvuApi;
            report.manual(
                `保留 tavern_helper 脚本「${s.name}」（${usesMvuApi ? '调用 Mvu.* 的业务脚本，改由数据库桥兼容层提供标准接口' : (ambiguousMvuImport ? '名称疑似与 MVU 有关，但不是已知引擎产物；为避免误删业务功能已保留，请按需核对' : (isExternal ? '外部 import，无法静态确认其内部调用；已默认安装 MVU 兼容层兜底，若仍有异常请人工检查' : '未检测到 MVU API；若依赖 MVU 变量请人工检查'))}）。`
            );
            const kept = deepClone(s);
            const chatMirrorRewrite = rewriteLegacyMvuChatMirrorScript(content, Object.keys(initvar));
            if (chatMirrorRewrite.count) {
                kept.content = chatMirrorRewrite.text;
                report.auto(`脚本「${s.name}」中 ${chatMirrorRewrite.count} 处旧 MVU chat 根变量镜像事务已改写为 Mvu.getMvuData/replaceMvuData（其他 chat 设置仍保留 TavernHelper 原作用域）。`);
            }
            // 某些旧卡脚本对象缺 type；保留时一并规范化，避免一个旧元素让酒馆助手
            // 对整组 scripts 的 discriminatedUnion 解析失败。
            if (!kept.type) kept.type = 'script';
            keptScripts.push(kept);
        }
        keptScripts.push({
            // 必须带 type:'script'：酒馆助手（JS-Slash-Runner）用 zod discriminatedUnion
            // 解析 tavern_helper.scripts，缺 type 会让整组脚本解析失败 → 角色脚本面板
            // 完全不显示（没有弹窗、没有开关）。原版脚本都带 type:'script'。
            type: 'script',
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
            data.first_mes = markCardFrontendMode(data.first_mes).text;
        }
        if (Array.isArray(data.alternate_greetings)) {
            data.alternate_greetings = data.alternate_greetings.map((g, gi) => {
                if (typeof g !== 'string' || !/<script/i.test(g)) return g;
                const inj = injectOpeningUserDataSync(g, schema, report);
                return markCardFrontendMode(inj.injected ? inj.script : g).text;
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
            convertedAt,
            originalName: origName,
            templateUid: Object.keys(template).filter(k => k.startsWith('sheet_')).map(k => template[k].uid),
            // 布局随卡保存：扩展用它从数据库表格实时重建 stat_data，供 EJS 读取（不依赖卡内桥）
            layout: buildLayoutJson(layout),
            note: '由 MVU 变量角色卡转换而来；表格数据由 SP·数据库 插件维护，运行时由 MVU转数据库扩展统一接管。',
        };

        return { card, schema, layout, template, bridgeScript, report, bridgeOptions, sourceRegexScripts };
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
        if (!merged.mate) {
            merged.mate = {
                type: 'chatSheets',
                version: 2,
                updateConfigUiSentinel: -1,
                globalInjectionConfig: {
                    readableEntryPlacement: { position: 'before_character_definition', depth: 2, order: 99981 },
                    wrapperPlacement: { position: 'before_character_definition', depth: 2, order: 99980 },
                },
            };
        }
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
    const conversionSessions = new WeakMap();
    function templatePromptKeys(template) {
        return Object.fromEntries(Object.keys(template).map(key => [key, JSON.stringify(template[key] && template[key].sourceData)]));
    }
    function conversionOptionKey(opts) {
        const normalized = { mode: 'both', nameSuffix: '_数据库', appendPlaceholder: true,
            ddlIncludeCheck: true, translateSimpleEjs: false, ...opts };
        return JSON.stringify(Object.keys(normalized).sort().filter(k =>
            !['template', 'asPng', 'report'].includes(k) && normalized[k] !== undefined
        ).map(k => [k, normalized[k]]));
    }

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

        const sourceInput = isPngInput
            ? new Uint8Array(input instanceof ArrayBuffer ? input.slice(0) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
            : deepClone(sourceCard);
        const transformed = transformCard(sourceCard, { ...opts, mode, report });
        const result = packageConversion(input, opts, transformed, isPngInput);
        conversionSessions.set(result, { input: sourceInput, options: { ...opts }, key: conversionOptionKey(opts),
            templateKey: JSON.stringify(result.template),
            promptKeys: templatePromptKeys(result.template),
            bridgeOptions: transformed.bridgeOptions, sourceRegexScripts: transformed.sourceRegexScripts });
        return result;
    }

    // 产物装配与卡片分析分开；模板编辑无需重复解析 initvar、Schema、业务脚本和 EJS。
    function packageConversion(input, opts, transformed, isPngInput, metadata = {}) {
        const { card, schema, template, bridgeScript, report } = transformed;
        const mode = opts.mode || 'both';

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
                ...metadata,
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

    function refreshConversion(previous, opts = {}) {
        const session = conversionSessions.get(previous);
        if (!session) throw new Error('转换会话不存在，请重新转换原卡');
        const options = { ...session.options, ...opts, template: opts.template || previous.template };
        if (conversionOptionKey(options) !== session.key) {
            const result = convert(session.input, options);
            result.meta.sourceCharacter = previous.meta.sourceCharacter || null;
            if (previous.meta.avatarBytes) {
                result.meta.avatarBytes = previous.meta.avatarBytes;
                result.meta.avatarMime = previous.meta.avatarMime;
            }
            return result;
        }
        const asPng = options.asPng === true || (options.asPng !== false && previous.meta.isPngInput);
        if (JSON.stringify(options.template) === session.templateKey) {
            if (asPng === previous.meta.asPng && previous.files.find(f => f.kind === 'report').data === previous.reportText) return previous;
            // 格式或报告摘要变化不影响卡片、数据桥和模板。
            const result = packageConversion(session.input, options, previous, previous.meta.isPngInput, previous.meta);
            result.reportText = previous.reportText;
            result.files.find(f => f.kind === 'report').data = result.reportText;
            conversionSessions.set(result, { ...session, options });
            return result;
        }
        const card = deepClone(previous.card), data = card.data || card;
        // 参数编辑器持有表对象引用，刷新下载后仍须继续编辑同一模板。
        const template = options.template;
        const report = createReport();
        for (const key of ['warnings', 'notes', 'autoRewrites', 'manualReview']) report[key] = deepClone(previous.report[key]);
        const promptKeys = templatePromptKeys(template), changedPrompts = {};
        for (const key of Object.keys(template)) {
            if (promptKeys[key] !== session.promptKeys[key]) changedPrompts[key] = template[key];
        }
        if (Object.keys(changedPrompts).length) {
            const migrationReport = createReport();
            migrateTemplatePromptRuntime(changedPrompts, session.sourceRegexScripts, migrationReport);
            for (const key of ['warnings', 'notes', 'autoRewrites', 'manualReview']) {
                const known = new Set(report[key].map(value => JSON.stringify(value)));
                for (const value of migrationReport[key]) {
                    const encoded = JSON.stringify(value);
                    if (!known.has(encoded)) { report[key].push(value); known.add(encoded); }
                }
            }
        }
        const entry = data.character_book.entries.find(e => Array.isArray(e.keys) && e.keys.includes('__ACU_TEMPLATE_DATA__'));
        const scripts = data.extensions.tavern_helper.scripts;
        const bridge = scripts.find(s => s.content === previous.bridgeScript);
        if (!entry || !bridge) throw new Error('转换产物的模板或数据桥缺失，请重新转换原卡');
        entry.content = toBase64(JSON.stringify(template));
        const bridgeScript = generateBridgeScript(previous.schema, template, session.bridgeOptions);
        bridge.content = bridgeScript;
        data.extensions.mvu2shujuku.templateUid = Object.keys(template).filter(k => k.startsWith('sheet_')).map(k => template[k].uid);
        const result = packageConversion(session.input, options, { card, template, schema: previous.schema, bridgeScript, report }, previous.meta.isPngInput, previous.meta);
        // UI 配置应用摘要属于本次转换说明，刷新产物时保留，不叠加重复摘要。
        const oldReport = previous.report.toMarkdown();
        if (previous.reportText.startsWith(oldReport)) result.reportText += previous.reportText.slice(oldReport.length);
        result.files.find(f => f.kind === 'report').data = result.reportText;
        conversionSessions.set(result, { ...session, options, templateKey: JSON.stringify(template), promptKeys: templatePromptKeys(template) });
        return result;
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
            '#mvu2shujuku-settings .mvu2shujuku-param-editor { margin: 10px 0; padding: 8px 10px; border: 1px dashed var(--SmartThemeBorderColor, #666); border-radius: 6px; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-grid { display: grid; grid-template-columns: minmax(90px, 1.2fr) minmax(110px, 1fr) 76px; gap: 6px 8px; align-items: center; margin: 6px 0; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-head { font-weight: 600; font-size: 12px; opacity: 0.8; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-name { word-break: break-all; font-size: 13px; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-cell { min-width: 0; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-grid .mvu2shujuku-param-select, #mvu2shujuku-settings .mvu2shujuku-param-grid .mvu2shujuku-param-value { width: 100%; box-sizing: border-box; min-width: 0; }',
            // 批量行在 flex 行里不能用 100% 宽（会被撑出界面），给固定窄宽
            '#mvu2shujuku-settings .mvu2shujuku-param-bulk .mvu2shujuku-param-select { width: 150px; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-bulk .mvu2shujuku-param-value { width: 76px; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-select { color: var(--SmartThemeBodyColor, #ddd); }',
            '#mvu2shujuku-settings .mvu2shujuku-param-value { color: #222; text-align: right; }',
            '#mvu2shujuku-settings .mvu2shujuku-check-label { flex: 1 1 auto; min-width: 0; word-break: break-word; }',
            '#mvu2shujuku-settings .mvu2shujuku-param-bulk { padding-top: 6px; border-top: 1px solid var(--SmartThemeBorderColor, #666); }',
            '#mvu2shujuku-settings .mvu2shujuku-merge-section { margin: 10px 0; padding: 8px 10px; border: 1px dashed var(--SmartThemeBorderColor, #666); border-radius: 6px; }',
        ].join('\n');
    }

    function getExtensionRuntimeInstaller() {
        if (typeof root.__MVU2SHUJUKU_EXTENSION_RUNTIME_INSTALLER__ === 'function') return root.__MVU2SHUJUKU_EXTENSION_RUNTIME_INSTALLER__;
        if (typeof require === 'function') return require('./extension-runtime.js');
        throw new Error('扩展运行时模块未加载，请使用构建后的 index.js');
    }
    function extensionIndexUi() {
        return 'if (typeof window !== "undefined") window.__MVU2SHUJUKU_EXTENSION_RUNTIME_INSTALLER__(window);';
    }

    /**
     * 装配原生扩展文件。返回 { manifest, 'index.js', 'style.css', README }
     * opts: { coreSource: mvu2shujuku.js 源码字符串（用于内联） }
     */
    function assembleExtension(opts = {}) {
        const coreSource = opts.coreSource || '';
        const pinyinInline = opts.pinyinInline || '';
        const yamlLibsInline = opts.yamlLibsInline || '';
        const jsonrepairInline = opts.jsonrepairInline || '';
        const indexJs = [
            '// MVU转数据库 · SillyTavern 原生扩展',
            '// 生成自 src/mvu2shujuku.js 与表格共用模块（' + VERSION + '），源码内联如下',
            '// @ts-nocheck',
            '(function (root) {',
            'root.__MVU2SHUJUKU_TABLE_CODEC_FACTORY__ = ' + getTableCodecFactory().toString() + ';',
            'root.__MVU2SHUJUKU_INPUT_PARSER_FACTORY__ = ' + getInputParserFactory().toString() + ';',
            'root.__MVU2SHUJUKU_EJS_TRANSFORM_FACTORY__ = ' + getEjsTransformFactory().toString() + ';',
            'root.__MVU2SHUJUKU_SCHEMA_LAYOUT_FACTORY__ = ' + getSchemaLayoutFactory().toString() + ';',
            'root.__MVU2SHUJUKU_RUNTIME_SESSION_FACTORY__ = ' + getRuntimeSessionFactory().toString() + ';',
            'root.__MVU2SHUJUKU_SP_ADAPTER_FACTORY__ = ' + getSpAdapterFactory().toString() + ';',
            'root.__MVU2SHUJUKU_ST_ADAPTER_FACTORY__ = ' + getStAdapterFactory().toString() + ';',
            'root.__MVU2SHUJUKU_SETTINGS_VIEW__ = ' + getSettingsView().toString() + ';',
            'root.__MVU2SHUJUKU_EXTENSION_RUNTIME_INSTALLER__ = ' + getExtensionRuntimeInstaller().toString() + ';',
            'root.__MVU2SHUJUKU_CARD_BRIDGE_INSTALLER__ = ' + getCardBridgeInstaller().toString() + ';',
            'root.__MVU2SHUJUKU_TABLE_WRITER_FACTORY__ = ' + getTableWriterFactory().toString() + ';',
            'root.__MVU2SHUJUKU_BRIDGE_LIFECYCLE_FACTORY__ = ' + getBridgeLifecycleFactory().toString() + ';',
            coreSource,
            pinyinInline ? '\n' + pinyinInline : '',
            // jsonrepair 源码内联必须在核心 IIFE 内：核心的 getJsonrepairSource()
            // 在浏览器端读 root.__MVU2SHUJUKU_JSONREPAIR_SRC__，而扩展脚本以
            // <script type="module"> 加载，顶层没有全局 root；放在 IIFE 外会
            // 直接 ReferenceError 导致整个扩展加载失败。
            jsonrepairInline ? '\n' + jsonrepairInline : '',
            '})(typeof globalThis !== "undefined" ? globalThis : this);',
            yamlLibsInline ? '\n' + yamlLibsInline : '',
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
                '- 开局自动建表对应 MVU 的 init 时机：模板以 base64 写入卡内世界书条目（__ACU_TEMPLATE_DATA__），扩展在进入聊天/首条消息时按需调用 SP·数据库 的 initGameSession 建表，开场白保持原样。',
                '- 卡内桥只向扩展注册当前卡的模板/layout；状态栏、世界书 EJS、Mvu API、事件和写库均由扩展统一运行时处理。',
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
        analyzeMvuInitMetadata,
        resolveInitDataMacros,
        leafInfo,
        json5Lite,
        stableHash,
        scanStatusUsage,
        parseMvuShapes,
        parseRegisteredZodSchema,
        buildSchema,
        buildLayout,
        generateTemplate,
        migrateTemplatePromptRuntime,
        formatMessageVariableValue,
        rewriteFormatMessageVariableMacros,
        findConvertedCharacterIndex,
        mergeTemplates,
        generateBridgeScript,
        resolveLayoutMacros,
        statDataFromTables,
        writeStatDiffToDb,
        get lastStatWriteFailed() { return getTableWriter().lastStatWriteFailed; },
        rewriteEjsConditions,
        protectFrontendEjsLiterals,
        translateSimpleEjsConditions,
        toPinyinSlug,
        transformCard,
        convert,
        refreshConversion,
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

'use strict';
// SP 初始化协议适配器；每个扩展实例拥有独立超时状态。
function createSpAdapter(host) {
    const window = host, globalThis = host;
    const atob = value => host.atob(value);
    const TextDecoder = host.TextDecoder;
    const setTimeout = host.setTimeout.bind(host), clearTimeout = host.clearTimeout.bind(host);
    function mvu2shujukuDecodeB64(b) { try {
        var bin = atob(b);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++)
            bytes[i] = bin.charCodeAt(i);
        return new TextDecoder("utf-8").decode(bytes);
    }
    catch (e) {
        return decodeURIComponent(escape(atob(b)));
    } }
    function mvu2shujukuExpectedTableNames(tpl) { var names = []; if (!tpl || typeof tpl !== "object")
        return names; for (var k in tpl) {
        if (k.indexOf("sheet_") !== 0)
            continue;
        var s = tpl[k];
        if (s && typeof s === "object" && typeof s.name === "string" && names.indexOf(s.name) === -1)
            names.push(s.name);
    } return names; }
    function mvu2shujukuSheetByName(tpl, name) { if (!tpl || typeof tpl !== "object")
        return null; for (var k in tpl) {
        if (k.indexOf("sheet_") === 0 && tpl[k] && tpl[k].name === name)
            return tpl[k];
    } return null; }
    function mvu2shujukuHasExtraRows(api, tpl) { try {
        var all = api.exportTableAsJson() || {};
        for (var k in tpl) {
            if (k.indexOf("sheet_") !== 0)
                continue;
            var ts = tpl[k];
            if (!ts || typeof ts !== "object" || typeof ts.name !== "string")
                continue;
            var rs = null;
            for (var k2 in all) {
                if (k2.indexOf("sheet_") === 0 && all[k2] && all[k2].name === ts.name) {
                    rs = all[k2];
                    break;
                }
            }
            if (!rs)
                continue;
            var tRows = Array.isArray(ts.content) ? ts.content.length - 1 : 0;
            var rRows = Array.isArray(rs.content) ? rs.content.length - 1 : 0;
            var rSeed = Array.isArray(rs.seedRows) ? rs.seedRows.length : 0;
            if (rRows + rSeed > tRows)
                return true;
        }
        return false;
    }
    catch (e) {
        return false;
    } }
    function mvu2shujukuTablesSafeToAnchor(api, tpl) { try {
        var all = api.exportTableAsJson() || {};
        var names = mvu2shujukuExpectedTableNames(tpl);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var rs = null;
            for (var k in all) {
                if (k.indexOf("sheet_") === 0 && all[k] && all[k].name === name) {
                    rs = all[k];
                    break;
                }
            }
            if (!rs)
                continue;
            var rows = (Array.isArray(rs.content) ? rs.content.length : 0) - 1;
            var seed = Array.isArray(rs.seedRows) ? rs.seedRows.length : 0;
            var ts = mvu2shujukuSheetByName(tpl, name);
            var tRows = ts && Array.isArray(ts.content) ? ts.content.length - 1 : 0;
            if (rows + seed > tRows)
                return false;
            if (rows > 0 && ts && Array.isArray(ts.content) && ts.content[1] && Array.isArray(rs.content) && rs.content[1]) {
                var th = ts.content[0] || [];
                var r1 = rs.content[1] || [];
                for (var ci = 1; ci < th.length; ci++) {
                    if (String(ts.content[1][ci] == null ? "" : ts.content[1][ci]) !== String(r1[ci] == null ? "" : r1[ci]))
                        return false;
                }
            }
        }
        return true;
    }
    catch (e) {
        return false;
    } }
    function mvu2shujukuMissingTableNames(api, names) { var all = {}; try {
        all = api.exportTableAsJson() || {};
    }
    catch (e) { } var have = {}; for (var k in all) {
        if (k.indexOf("sheet_") === 0 && all[k] && typeof all[k].name === "string")
            have[all[k].name] = true;
    } var missing = []; for (var i = 0; i < names.length; i++) {
        if (!have[names[i]])
            missing.push(names[i]);
    } return missing; }
    function mvu2shujukuExpectedColumns(tpl) { var map = {}; if (!tpl || typeof tpl !== "object")
        return map; for (var k in tpl) {
        if (k.indexOf("sheet_") !== 0)
            continue;
        var s = tpl[k];
        if (!s || typeof s !== "object" || typeof s.name !== "string")
            continue;
        var hdr = Array.isArray(s.content) && Array.isArray(s.content[0]) ? s.content[0] : [];
        var cols = [];
        for (var i = 1; i < hdr.length; i++) {
            if (cols.indexOf(hdr[i]) === -1)
                cols.push(hdr[i]);
        }
        map[s.name] = cols;
    } return map; }
    function mvu2shujukuMissingColumns(api, expected) { var all = {}; try {
        all = api.exportTableAsJson() || {};
    }
    catch (e) { } var have = {}; for (var k in all) {
        if (k.indexOf("sheet_") === 0 && all[k] && typeof all[k].name === "string")
            have[all[k].name] = all[k];
    } var mismatch = []; for (var name in expected) {
        var sheet = have[name];
        if (!sheet)
            continue;
        var hdr = Array.isArray(sheet.content) && Array.isArray(sheet.content[0]) ? sheet.content[0] : [];
        var exp = expected[name];
        for (var i = 0; i < exp.length; i++) {
            if (hdr.indexOf(exp[i]) === -1) {
                mismatch.push(name + "(缺列:" + exp[i] + ")");
                break;
            }
        }
    } return mismatch; }
    function mvu2shujukuMacroMark(s) { s = String(s == null ? "" : s); return /<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(s) || /\{\{[\s\S]*?\}\}/.test(s); }
    function mvu2shujukuMacroEnv() { var win = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null)); var tries = []; function add(w) { try {
        if (w && tries.indexOf(w) === -1)
            tries.push(w);
    }
    catch (e) { } } add(win); if (win) {
        try {
            add(win.parent);
        }
        catch (e) { }
        try {
            add(win.top);
        }
        catch (e) { }
    } for (var i = 0; i < tries.length; i++) {
        var w = tries[i], ctx = null;
        try {
            if (w.SillyTavern && typeof w.SillyTavern.getContext === "function")
                ctx = w.SillyTavern.getContext();
        }
        catch (e) { }
        try {
            if (!ctx && typeof w.getContext === "function")
                ctx = w.getContext();
        }
        catch (e) { }
        if (ctx && typeof ctx.substituteParams === "function")
            return { ctx: ctx, fn: ctx.substituteParams, holder: w };
    } return null; }
    function mvu2shujukuMacroCacheKey(seed, ctx) { var s = String(seed || "") + "|" + String(ctx && (ctx.chatId || ctx.chat_id || ctx.chatFile || ctx.chatFileName) || "unknown"); var h = 2166136261; for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    } return String(h >>> 0); }
    function mvu2shujukuCheckRowKeyCollision(rows, start, sheet) { var ddl = String(sheet && sheet.sourceData && sheet.sourceData.ddl || ""); var um = ddl.match(/\bUNIQUE\s*\(([^)]+)\)/i); var keyCount = um ? um[1].split(",").length : (/\bUNIQUE\b/i.test(ddl) ? 1 : 0); if (!keyCount || !Array.isArray(rows))
        return; var seen = {}; for (var i = start; i < rows.length; i++) {
        var row = rows[i];
        if (!Array.isArray(row) || row.length < keyCount + 1)
            continue;
        var vals = [];
        for (var k = 0; k < keyCount; k++)
            vals.push(String(row[k + 1] == null ? "" : row[k + 1]));
        if (vals.some(function (v) { return !v; }))
            continue;
        var key = vals.join("\u0000");
        if (seen[key])
            throw new Error("表「" + String(sheet && sheet.name || "") + "」宏替换后键名冲突：" + vals.join(" / "));
        seen[key] = true;
    } }
    function mvu2shujukuResolveTemplateMacros(tpl, seed) { var has = false; for (var k in tpl) {
        if (k.indexOf("sheet_") !== 0)
            continue;
        var s = tpl[k];
        if (!s || typeof s !== "object")
            continue;
        var hdr = Array.isArray(s.content) && Array.isArray(s.content[0]) ? s.content[0] : [];
        for (var hi = 0; hi < hdr.length; hi++)
            if (mvu2shujukuMacroMark(hdr[hi]))
                return { ok: false, status: "error", message: "固定列名不支持运行时宏：" + hdr[hi] };
        var lists = [];
        if (Array.isArray(s.content))
            lists.push({ rows: s.content, start: 1 });
        if (Array.isArray(s.seedRows))
            lists.push({ rows: s.seedRows, start: 0 });
        for (var li = 0; li < lists.length; li++) {
            var rs = lists[li].rows;
            for (var ri = lists[li].start; ri < rs.length; ri++) {
                var row = rs[ri];
                if (!Array.isArray(row))
                    continue;
                for (var ci = 0; ci < row.length; ci++)
                    if (typeof row[ci] === "string" && mvu2shujukuMacroMark(row[ci]))
                        has = true;
            }
        }
    } if (!has)
        return { ok: true, template: tpl }; var env = mvu2shujukuMacroEnv(); if (!env)
        return { ok: false, status: "partial", message: "初始数据含有 SillyTavern 宏，但 substituteParams 尚未就绪，等待重试" }; var ck = mvu2shujukuMacroCacheKey(seed, env.ctx); var holder = env.holder || {}; var cache = holder.__mvu2shujukuResolvedMacroTemplates || (holder.__mvu2shujukuResolvedMacroTemplates = {}); if (cache[ck])
        return { ok: true, template: cache[ck] }; var out = JSON.parse(JSON.stringify(tpl)); try {
        for (var k2 in out) {
            if (k2.indexOf("sheet_") !== 0)
                continue;
            var sh = out[k2];
            if (!sh || typeof sh !== "object")
                continue;
            var sets = [];
            if (Array.isArray(sh.content))
                sets.push({ rows: sh.content, start: 1 });
            if (Array.isArray(sh.seedRows))
                sets.push({ rows: sh.seedRows, start: 0 });
            for (var si = 0; si < sets.length; si++) {
                var rows = sets[si].rows;
                for (var r = sets[si].start; r < rows.length; r++) {
                    if (!Array.isArray(rows[r]))
                        continue;
                    for (var c = 0; c < rows[r].length; c++) {
                        if (typeof rows[r][c] === "string")
                            rows[r][c] = String(env.fn.call(env.ctx, rows[r][c]));
                    }
                }
                mvu2shujukuCheckRowKeyCollision(rows, sets[si].start, sh);
            }
        }
    }
    catch (e) {
        return { ok: false, status: "error", message: e && e.message ? e.message : String(e) };
    } cache[ck] = out; return { ok: true, template: out }; }
    function mvu2shujukuHasFullFrame(o) { try {
        if (!o || typeof o !== "object")
            return false;
        var fr = o.storageFrame;
        if (fr && typeof fr === "object" && fr.version === 2 && Array.isArray(fr.logEntries) && fr.checkpoint && fr.checkpoint.kind === "full")
            return true;
        for (var ck in o) {
            var child = o[ck];
            if (typeof child === "string") {
                try {
                    child = JSON.parse(child);
                }
                catch (e) {
                    continue;
                }
            }
            if (child && typeof child === "object") {
                var fr2 = child.storageFrame;
                if (fr2 && typeof fr2 === "object" && fr2.version === 2 && Array.isArray(fr2.logEntries) && fr2.checkpoint && fr2.checkpoint.kind === "full")
                    return true;
            }
        }
        return false;
    }
    catch (e) {
        return false;
    } }
    function mvu2shujukuChatHasFullCheckpoint() { try {
        var win = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
        var ctx = null;
        var tries = [win];
        if (win) {
            try {
                if (win.parent && win.parent !== win)
                    tries.push(win.parent);
            }
            catch (e) { }
        }
        for (var ti = 0; ti < tries.length; ti++) {
            var w = tries[ti];
            if (!w)
                continue;
            try {
                if (w.SillyTavern && typeof w.SillyTavern.getContext === "function") {
                    ctx = w.SillyTavern.getContext();
                    break;
                }
            }
            catch (e) { }
            try {
                if (typeof w.getContext === "function") {
                    ctx = w.getContext();
                    break;
                }
            }
            catch (e) { }
        }
        var chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
        for (var mi = 0; mi < chat.length; mi++) {
            var msg = chat[mi];
            if (!msg || typeof msg !== "object")
                continue;
            for (var k in msg) {
                if (k.indexOf("TavernDB_ACU_") !== 0 && k.indexOf("_acu_") !== 0)
                    continue;
                var v = msg[k];
                if (typeof v === "string") {
                    try {
                        v = JSON.parse(v);
                    }
                    catch (e) {
                        continue;
                    }
                }
                if (mvu2shujukuHasFullFrame(v))
                    return true;
            }
        }
        return false;
    }
    catch (e) {
        return false;
    } }
    function mvu2shujukuChatIsPristineOpening() { try {
        var win = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
        var ctx = null;
        var tries = [win];
        if (win) {
            try {
                if (win.parent && win.parent !== win)
                    tries.push(win.parent);
            }
            catch (e) { }
        }
        for (var ti = 0; ti < tries.length; ti++) {
            var w = tries[ti];
            if (!w)
                continue;
            try {
                if (w.SillyTavern && typeof w.SillyTavern.getContext === "function") {
                    ctx = w.SillyTavern.getContext();
                    break;
                }
            }
            catch (e) { }
            try {
                if (typeof w.getContext === "function") {
                    ctx = w.getContext();
                    break;
                }
            }
            catch (e) { }
        }
        var chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
        return chat.length === 1 && !!chat[0] && !chat[0].is_user;
    }
    catch (e) {
        return false;
    } }
    function mvu2shujukuForeignRuntimeTableNames(api, names) { var out = []; try {
        var all = api.exportTableAsJson() || {};
        for (var k in all) {
            if (k.indexOf("sheet_") !== 0 || !all[k] || typeof all[k].name !== "string")
                continue;
            var name = all[k].name;
            if (names.indexOf(name) === -1 && out.indexOf(name) === -1)
                out.push(name);
        }
    }
    catch (e) { } return out; }
    function mvu2shujukuChatHasAiFloor() { try {
        var win = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
        var ctx = null;
        var tries = [win];
        if (win) {
            try {
                if (win.parent && win.parent !== win)
                    tries.push(win.parent);
            }
            catch (e) { }
        }
        for (var ti = 0; ti < tries.length; ti++) {
            var w = tries[ti];
            if (!w)
                continue;
            try {
                if (w.SillyTavern && typeof w.SillyTavern.getContext === "function") {
                    ctx = w.SillyTavern.getContext();
                    break;
                }
            }
            catch (e) { }
            try {
                if (typeof w.getContext === "function") {
                    ctx = w.getContext();
                    break;
                }
            }
            catch (e) { }
        }
        var chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
        for (var mi = 0; mi < chat.length; mi++) {
            if (chat[mi] && !chat[mi].is_user)
                return true;
        }
        return false;
    }
    catch (e) {
        return false;
    } }
    var mvu2shujukuInitSessionHung = false;
    var mvu2shujukuInitSessionHungChat = "";
    function mvu2shujukuRuntimeChatKey() { try {
        var win = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
        var ctx = null;
        var tries = [win];
        if (win) {
            try {
                if (win.parent && win.parent !== win)
                    tries.push(win.parent);
            }
            catch (e) { }
        }
        for (var ti = 0; ti < tries.length; ti++) {
            var w = tries[ti];
            if (!w)
                continue;
            try {
                if (w.SillyTavern && typeof w.SillyTavern.getContext === "function") {
                    ctx = w.SillyTavern.getContext();
                    break;
                }
            }
            catch (e) { }
            try {
                if (typeof w.getContext === "function") {
                    ctx = w.getContext();
                    break;
                }
            }
            catch (e) { }
        }
        return String(ctx && (ctx.chatId || ctx.chat_id || ctx.chatFile || ctx.chatFileName) || "unknown");
    }
    catch (e) {
        return "unknown";
    } }
    function mvu2shujukuWithTimeout(promise, ms, label) { var done = false; var tid = null; var timeoutPromise = new Promise(function (resolve) { tid = setTimeout(function () { if (!done) {
        done = true;
        resolve({ timeout: true, message: label + " 超时(" + (ms / 1000) + "s)" });
    } }, ms); }); return Promise.race([Promise.resolve(promise).then(function (v) { if (!done) {
            done = true;
            if (tid)
                clearTimeout(tid);
        } return v; }), timeoutPromise]); }
    async function mvu2shujukuEnsureInit(api, b64, presetName, to) { var out = { status: "skip", message: "", missing: [], replacedFreshForeignCheckpoint: false }; var t1 = (to && to.importMs) || 15000; var t2 = (to && to.initMs) || 20000; var tpl = null; if (to && to.preparedTemplate && typeof to.preparedTemplate === "object") {
        tpl = JSON.parse(JSON.stringify(to.preparedTemplate));
    }
    else {
        try {
            tpl = JSON.parse(mvu2shujukuDecodeB64(b64));
        }
        catch (e) {
            out.status = "error";
            out.message = "模板解码失败: " + (e && e.message ? e.message : e);
            return out;
        }
    } var macroResult = mvu2shujukuResolveTemplateMacros(tpl, b64); if (!macroResult.ok) {
        out.status = macroResult.status || "error";
        out.message = macroResult.message || "初始数据宏替换失败";
        return out;
    } tpl = macroResult.template; out.template = tpl; var names = mvu2shujukuExpectedTableNames(tpl); if (!names.length) {
        out.status = "error";
        out.message = "模板中没有 sheet_* 表";
        return out;
    } out.missing = mvu2shujukuMissingTableNames(api, names); var hasFullCheckpoint = mvu2shujukuChatHasFullCheckpoint(); var foreignRuntimeTables = hasFullCheckpoint ? mvu2shujukuForeignRuntimeTableNames(api, names) : []; var replaceFreshForeign = hasFullCheckpoint && out.missing.length > 0 && foreignRuntimeTables.length > 0 && mvu2shujukuChatIsPristineOpening(); if (hasFullCheckpoint && !replaceFreshForeign) {
        out.status = "skip";
        out.message = "聊天已有 full checkpoint，跳过自动建表（以持久化数据为准，运行时物化由插件完成）";
        return out;
    } if (replaceFreshForeign)
        out.replacedFreshForeignCheckpoint = true; if (!mvu2shujukuChatHasAiFloor()) {
        out.status = "partial";
        out.message = "聊天暂无 AI 楼层（首楼未就绪或切换加载中），等待重试";
        return out;
    } var colMiss = []; var needsImport = out.missing.length > 0; if (!needsImport) {
        colMiss = mvu2shujukuMissingColumns(api, mvu2shujukuExpectedColumns(tpl));
        needsImport = colMiss.length > 0;
    } if (!needsImport) {
        var all2 = {};
        try {
            all2 = api.exportTableAsJson() || {};
        }
        catch (e) { }
        var rtCount = 0;
        var rtEmptyAll = true;
        var rtHasSeed = false;
        var tplHasRows = false;
        for (var k2 in all2) {
            if (k2.indexOf("sheet_") !== 0)
                continue;
            var sh2 = all2[k2];
            if (!sh2 || typeof sh2 !== "object" || typeof sh2.name !== "string")
                continue;
            rtCount++;
            if (Array.isArray(sh2.content) && sh2.content.length > 1)
                rtEmptyAll = false;
            if (Array.isArray(sh2.seedRows) && sh2.seedRows.length)
                rtHasSeed = true;
        }
        for (var tk in tpl) {
            if (tk.indexOf("sheet_") !== 0)
                continue;
            var tsx = tpl[tk];
            if (tsx && typeof tsx === "object" && Array.isArray(tsx.content) && tsx.content.length > 1) {
                tplHasRows = true;
                break;
            }
        } /* 根因修复：插件 native 初始化可能已用“仅表头”模板建表（content 无行、无 checkpoint）。此时跳过 initGameSession 会让 checkpoint 停在无行状态，刷新后 v2-replay 无法恢复任何行（插件 loadFromData 的 hasRealDataRows 门禁 + 有 checkpoint 后 seedRows 不再物化）。只要运行时全表仅表头且带有模板 seedRows（插件 native 初始化签名），就继续走 initGameSession 用完整模板原子建锚+补行（无损：无真实数据行）。*/
        var headerOnlyFresh = rtCount > 0 && rtEmptyAll && rtHasSeed && tplHasRows;
        if (!headerOnlyFresh) {
            var emptyS = [];
            try {
                for (var k3 in all2) {
                    if (k3.indexOf("sheet_") !== 0)
                        continue;
                    var sh3 = all2[k3];
                    if (!sh3 || typeof sh3 !== "object" || typeof sh3.name !== "string")
                        continue;
                    if (Array.isArray(sh3.content) && sh3.content.length > 1)
                        continue;
                    if (Array.isArray(sh3.seedRows) && sh3.seedRows.length)
                        continue;
                    var ts3 = mvu2shujukuSheetByName(tpl, sh3.name);
                    if (!ts3 || !Array.isArray(ts3.content) || ts3.content.length !== 2)
                        continue;
                    emptyS.push(sh3.name);
                }
            }
            catch (e) { }
            if (emptyS.length) {
                for (var ei = 0; ei < emptyS.length; ei++) {
                    try {
                        var ts2 = mvu2shujukuSheetByName(tpl, emptyS[ei]);
                        var hdr2 = ts2.content[0];
                        var row2 = ts2.content[1];
                        var obj2 = {};
                        for (var ci = 1; ci < hdr2.length; ci++) {
                            obj2[hdr2[ci]] = (row2[ci] !== undefined && row2[ci] !== null) ? row2[ci] : "";
                        }
                        await Promise.resolve(api.insertRow(emptyS[ei], obj2));
                    }
                    catch (e) { }
                }
                out.status = "skip";
                out.message = "已为仅表头的单例/JSON表补初始行：" + emptyS.join("、");
                return out;
            }
            out.status = "skip";
            out.message = "已有全部表格且结构匹配，跳过开局建表";
            return out;
        }
    } var steps = []; if (replaceFreshForeign)
        steps.push("检测到新聊天的异卡 checkpoint（" + foreignRuntimeTables.join("、") + "），已按当前卡模板重建"); var initOk = false; try {
        if (mvu2shujukuInitSessionHung && mvu2shujukuInitSessionHungChat && mvu2shujukuInitSessionHungChat !== mvu2shujukuRuntimeChatKey()) {
            mvu2shujukuInitSessionHung = false;
        }
    }
    catch (e) { } if (typeof api.initGameSession === "function" && !mvu2shujukuInitSessionHung) {
        try {
            var r2 = await mvu2shujukuWithTimeout(api.initGameSession({}, { injectTemplate: true, loadPreset: false, templateData: tpl, templatePresetName: presetName || "", resetExistingTableData: true }), t2, "initGameSession");
            if (r2 && r2.timeout) {
                mvu2shujukuInitSessionHung = true;
                try {
                    mvu2shujukuInitSessionHungChat = mvu2shujukuRuntimeChatKey();
                }
                catch (e) { }
                steps.push("initGameSession: 超时，已跳过后续重试");
            }
            else if (r2 && r2.success === false) {
                steps.push("initGameSession: " + (r2.message || "失败"));
            }
            else {
                initOk = true;
                steps.push("initGameSession: 完成" + (r2 && r2.runtimeReady === false ? "（运行时未就绪）" : ""));
            }
        }
        catch (e) {
            steps.push("initGameSession异常: " + (e && e.message ? e.message : e));
        }
    }
    else if (typeof api.initGameSession !== "function") {
        steps.push("initGameSession: 不可用");
    } if (!initOk && typeof api.importTemplateFromData === "function") {
        try {
            var r1 = await mvu2shujukuWithTimeout(api.importTemplateFromData(tpl, { scope: "chat", presetName: presetName || "" }), t1, "importTemplateFromData");
            steps.push(r1 && r1.timeout ? r1.message : (r1 && r1.success === false ? ("importTemplateFromData: " + (r1.message || "失败")) : "importTemplateFromData: 完成"));
        }
        catch (e) {
            steps.push("importTemplateFromData异常: " + (e && e.message ? e.message : e));
        }
    } out.missing = mvu2shujukuMissingTableNames(api, names); colMiss = out.missing.length ? [] : mvu2shujukuMissingColumns(api, mvu2shujukuExpectedColumns(tpl)); out.status = (out.missing.length || colMiss.length) ? "partial" : "ok"; out.message = steps.join("；") + "；剩余缺表：" + (out.missing.length ? out.missing.join("、") : "无") + (colMiss.length ? "；结构不匹配：" + colMiss.join("、") : ""); return out; }
    return { mvu2shujukuDecodeB64, mvu2shujukuExpectedTableNames, mvu2shujukuSheetByName, mvu2shujukuHasExtraRows, mvu2shujukuTablesSafeToAnchor, mvu2shujukuMissingTableNames, mvu2shujukuExpectedColumns, mvu2shujukuMissingColumns, mvu2shujukuMacroMark, mvu2shujukuMacroEnv, mvu2shujukuMacroCacheKey, mvu2shujukuCheckRowKeyCollision, mvu2shujukuResolveTemplateMacros, mvu2shujukuHasFullFrame, mvu2shujukuChatHasFullCheckpoint, mvu2shujukuChatIsPristineOpening, mvu2shujukuForeignRuntimeTableNames, mvu2shujukuChatHasAiFloor, mvu2shujukuRuntimeChatKey, mvu2shujukuWithTimeout, mvu2shujukuEnsureInit };
}
module.exports = createSpAdapter;

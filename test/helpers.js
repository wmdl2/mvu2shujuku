#!/usr/bin/env node
/*
 * 测试公共依赖与 helper（从 run-tests.js 提取，供各 spec 复用）。
 * run-tests.js 只负责注册测试；运行/过滤见 runner.js。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const core = require('../src/mvu2shujuku.js');

const FIXTURE = path.join(__dirname, 'fixtures', '道渊-MVU.json');
const PNG = path.join(__dirname, '..', '..', '参考资料', '参考角色卡', 'v5.2_1-MVU版.png');
const HAS_FIXTURE = fs.existsSync(FIXTURE);

function requireFixture() {
    if (!HAS_FIXTURE) {
        const e = new Error('SKIP_NO_FIXTURE');
        e.code = 'SKIP_NO_FIXTURE';
        throw e;
    }
    return require(FIXTURE);
}

// 模拟真实插件行为的 fake API：updateCell/insertRow/deleteRow 真实落表，
// importTableAsJson 记录并替换表数据（与原生数据库卡的写路径一致）。
function applyingApi(tables, opts = {}) {
    return {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => tables,
        initGameSession: async () => {
            if (opts.onInit) await opts.onInit();
            return { success: true, runtimeReady: true };
        },
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr, o) => {
            const parsed = JSON.parse(jsonStr);
            if (opts.onImport) opts.onImport(parsed, o);
            for (const k of Object.keys(tables)) delete tables[k];
            Object.assign(tables, parsed);
            return true;
        },
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
        insertRow: async (tableName, obj) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s) return 0;
            const row = s.content[0].map(h => (obj && obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
            row[0] = s.content.length || 1;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async (tableName, rowIndex) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            s.content.splice(rowIndex, 1);
            return true;
        },
        registerTableUpdateCallback: () => true,
    };
}

function parseSqlValue(v) {
    if (/^'/.test(v)) return v.replace(/^'|'$/g, '').replace(/''/g, "'");
    const n = Number(v);
    return isNaN(n) ? v : n;
}

function splitSqlValues(str) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inQ) {
            if (ch === "'") {
                if (str[i + 1] === "'") { cur += "'"; i++; }
                else inQ = false;
            } else cur += ch;
        } else if (ch === "'") {
            inQ = true;
        } else if (ch === ',') {
            out.push(parseSqlValue(cur.trim()));
            cur = '';
            continue;
        } else cur += ch;
    }
    if (cur.trim()) out.push(parseSqlValue(cur.trim()));
    return out;
}

function applySqlToTables(tables, sql) {
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
        let m = stmt.match(/^UPDATE\s+(\S+)\s+SET\s+(\S+)\s*=\s*(.+?)\s+WHERE\s+row_id\s*=\s*(\d+)$/);
        if (m) {
            const tn = m[1], col = m[2], raw = m[3], rid = m[4];
            const s = Object.values(tables).find(x => x.name === tn);
            const ci = s.content[0].indexOf(col);
            const row = s.content.find(r => String(r[0]) === rid);
            row[ci] = parseSqlValue(raw);
            continue;
        }
        m = stmt.match(/^INSERT INTO\s+(\S+)\s+\(([^)]+)\)\s+VALUES\s+\((.+)\)$/);
        if (m) {
            const tn = m[1];
            const cols = m[2].split(',').map(s => s.trim());
            const vals = splitSqlValues(m[3]);
            const s = Object.values(tables).find(x => x.name === tn);
            let maxId = 0;
            for (let i = 1; i < s.content.length; i++) {
                const rid = Number(s.content[i] && s.content[i][0]);
                if (!isNaN(rid) && rid > maxId) maxId = rid;
            }
            const row = new Array(s.content[0].length).fill('');
            row[0] = maxId + 1;
            cols.forEach((c, i) => { row[s.content[0].indexOf(c)] = vals[i]; });
            s.content.push(row);
            continue;
        }
        m = stmt.match(/^DELETE FROM\s+(\S+)\s+WHERE\s+row_id\s*=\s*(\d+)$/);
        if (m) {
            const tn = m[1], rid = m[2];
            const s = Object.values(tables).find(x => x.name === tn);
            const idx = s.content.findIndex(r => String(r[0]) === rid);
            if (idx >= 0) s.content.splice(idx, 1);
            continue;
        }
        throw new Error('无法解析测试 SQL: ' + stmt);
    }
}

// 运行卡内数据桥脚本的最小沙箱（Mvu 兼容层 / 桥端到端测试用）
function bridgeSandbox(r, opts = {}) {
    const vm = require('vm');
    const tables = JSON.parse(JSON.stringify(r.template));
    const chat = [];
    const addCheckpoint = () => {
        // 模拟插件提交成功后真的建立 full checkpoint
        chat.push({ message_id: chat.length, is_user: false, mes: '模拟消息',
            TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: Date.now() } } } }) });
    };
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => { addCheckpoint(); return { success: true, runtimeReady: true }; },
        importTableAsJson: async () => { addCheckpoint(); return true; },
        registerTableUpdateCallback: () => {},
        updateCell: async (tableName, rowIndex, col, value) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return false;
            const ci = sheet.content[0].indexOf(col);
            if (ci === -1) return false;
            sheet.content[rowIndex][ci] = value;
            return true;
        },
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({
            chatId: 'c1',
            name: '测试角色',
            chat,
            eventSource: { on: () => {}, emit: () => {} },
            event_types: { MESSAGE_RECEIVED: 'message_received' },
        }),
        ...(opts.extra || {}),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return { win, tables, fakeApi };
}

// 等待桥/扩展侧的合并写入定时器（150ms）完成落库
async function waitBridgeFlush(ms = 300) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    fs,
    path,
    os,
    assert,
    core,
    FIXTURE,
    PNG,
    HAS_FIXTURE,
    requireFixture,
    applyingApi,
    parseSqlValue,
    splitSqlValues,
    applySqlToTables,
    bridgeSandbox,
    waitBridgeFlush,
};

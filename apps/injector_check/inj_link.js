'use strict';
/**
 * inj_link.js - the head unit's diagnostic link (kit/diag.js), restricted to READING from the engine unit.
 *
 * Every request passes check() before it reaches the transport. Allowed, to the DME (0x12) only:
 *   22 <DID> x1..8    ReadDataByIdentifier
 *   22 F6 <MID>       OBD on-board monitor results over UDS (misfire monitors)
 *   06 <MID>          the same with OBD service 06
 *   19 02 <mask>      read the fault memory (reportDTCByStatusMask)
 * Anything else (sessions, clearing faults, security access, writes, I/O control, routines, resets,
 * functional requests, other units) throws. Nothing is ever written to the car.
 *
 * Paced like kit/readonly-diag.js: one request at a time, at least gapMs between two, a 1 s pause after
 * the unit answers busy (NRC 21).
 */
const { Diag, hex } = require('./kit/diag');

const DME = 0x12;
const MAX_DIDS = 8;
const byte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xFF;

function check(target, sid, data) {
    if (target !== DME) throw new Error('read-only: only the engine unit (0x12)');
    if (!Array.isArray(data) || !data.every(byte)) throw new Error('read-only: bad request bytes');
    if (sid === 0x22) {
        if (data.length < 2 || data.length > 2 * MAX_DIDS || data.length % 2) throw new Error('read-only: 22 takes 1 to 8 identifiers');
        return;
    }
    if (sid === 0x06) { if (data.length !== 1) throw new Error('read-only: 06 takes one MID'); return; }
    if (sid === 0x19) { if (data.length !== 2 || data[0] !== 0x02) throw new Error('read-only: only 19 02 <mask>'); return; }
    throw new Error('read-only: service ' + (byte(sid) ? hex(sid) : String(sid)) + ' is not allowed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InjLink {
    constructor(signals, log) {
        this.diag = new Diag(signals, log);
        this.diag.quiet = true;
        this.diag.busyMs = 100;
        this.diag.busyLog = false;
        this.log = log;
        this.gapMs = 25;
        this.chain = Promise.resolve();
        this.next = 0;
        this.stats = { sent: 0, replies: 0, missed: 0 };
    }

    async init() { await this.diag.init(); return this; }
    get ready() { return !!this.diag.p; }
    get error() { return this.diag.error; }

    /** The DME's reply bytes (positive or 7F refusal), or null when it didn't answer. */
    request(sid, data, accept, timeoutMs) {
        const d = data.slice();
        try { check(DME, sid, d); } catch (e) { this.log.error('blocked: ' + e.message); return Promise.reject(e); }
        const run = async () => {
            const wait = Math.max(0, this.next - Date.now());
            if (wait) await sleep(wait);
            try {
                this.stats.sent++;
                const u = await this.diag.physical(DME, sid, d, timeoutMs || 1500, accept);
                if (!u) { this.stats.missed++; return null; }
                this.stats.replies++;
                if (u[0] === 0x7F && u[2] === 0x21) this.next = Math.max(this.next, Date.now() + 1000);
                return u;
            } finally { this.next = Math.max(this.next, Date.now() + this.gapMs); }
        };
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {});
        return p;
    }

    /** 22 with several identifiers: 62 <DID> <data> ... or 7F 22 <nrc>. */
    readMany(dids) {
        const data = [];
        dids.forEach((x) => data.push((x >> 8) & 0xFF, x & 0xFF));
        return this.request(0x22, data, (u) => (u[0] === 0x62 && dids.indexOf((u[1] << 8) | u[2]) >= 0) || (u[0] === 0x7F && u[1] === 0x22));
    }

    /** OBD monitor results of one MID: [{ tid, unit, value, min, max }] or null. Service 06 first, then 22 F6xx. */
    async monitor(mid) {
        let u = await this.request(0x06, [mid], (x) => (x[0] === 0x46 && x[1] === mid) || (x[0] === 0x7F && x[1] === 0x06));
        let did = false;
        if (!u || u[0] === 0x7F) {
            u = await this.request(0x22, [0xF6, mid], (x) => (x[0] === 0x62 && x[1] === 0xF6 && x[2] === mid) || (x[0] === 0x7F && x[1] === 0x22));
            did = true;
        }
        if (!u || u[0] === 0x7F) return null;
        const out = [], size = did ? 8 : 9;
        for (let i = did ? 3 : 1; i + size <= u.length; i += size) {
            const o = did ? i : i + 1;
            if (!did && u[i] !== mid) break;
            out.push({ tid: u[o], unit: u[o + 1], value: (u[o + 2] << 8) | u[o + 3], min: (u[o + 4] << 8) | u[o + 5], max: (u[o + 6] << 8) | u[o + 7] });
        }
        return out.length ? out : null;
    }

    /** The DME's fault memory: { ok, nrc, dtcs: [{ code: 'hex6', status }] }. */
    async faults() {
        const u = await this.request(0x19, [0x02, 0xFF], (x) => (x[0] === 0x59 && x[1] === 0x02) || (x[0] === 0x7F && x[1] === 0x19), 6000);
        if (!u) return { ok: false, nrc: null, dtcs: [], why: 'no answer' };
        if (u[0] === 0x7F) return { ok: false, nrc: u[2], dtcs: [], why: 'refused, NRC ' + hex(u[2]) };
        const dtcs = [];
        for (let i = 3; i + 4 <= u.length; i += 4) {          // 59 02 <availability mask> then DTC(3) status(1)
            dtcs.push({ code: hex(((u[i] << 16) | (u[i + 1] << 8) | u[i + 2]) >>> 0, 6), status: u[i + 3] });
        }
        return { ok: true, nrc: null, dtcs };
    }
}

module.exports = { InjLink, check, DME };

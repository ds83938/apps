'use strict';
/**
 * rwd.js - RWD Mode: switch xDrive between AWD and RWD on a button press, the cautious way.
 *
 * What it sends, and nothing else:
 *   reads : DSC 0x29  22 F1 50      SGBD index (which DSC this is)
 *           DSC 0x29  22 DB E1      LMV_FUNKTION: 1 = xDrive on, 0 = off
 *           LMV 0x19  22 F1 50      transfer case index (shown only)
 *           LMV 0x19  22 DB 32      front-axle torque + the transfer case's own on/off qualifier
 *           DSC 0x29  19 02 FF      DSC fault memory (only for the cleanup below)
 *   writes: DSC 0x29  2E DB E1 00   RWD for the current ignition cycle
 *           DSC 0x29  2E DB E1 01   AWD again
 *           DSC 0x29  14 FF FF FF   clear the DSC fault memory - ONLY when the one and only entry
 *                                   stored is 480724 (the "xDrive off" entry this app caused) and
 *                                   only after AWD is confirmed back. Any other DSC fault: untouched.
 *
 * Nothing is coded or flashed. An ignition cycle always brings AWD back by itself, whatever the
 * buttons did. Never: a DSC reset, a session change, security access, another control unit.
 *
 * Rules for both buttons (checked again right before the bytes leave):
 *   - Armed setting on (ships Disarmed: then not a single byte, reads included)
 *   - DSC is an ALLOWED variant (DSC_G20 0F2510 by default), anything else refused
 *   - live, fresh car data; speed known and < 0.5 km/h; selector known and in P; ignition on
 *   - engine running is fine. If this DSC refuses RWD with the engine running, the app remembers
 *     that (data/rwd_mode.json) and from then on asks for the engine off for RWD only
 *   - two presses within CONFIRM_MS; MAX_ATTEMPTS writes per ignition cycle, COOLDOWN_MS apart
 * The screen shows AWD / RWD only from a read-back: the transfer case's qualifier when it answers,
 * else the DSC's DBE1 with the engine running. A request alone is never shown as done.
 *
 * Known behaviour while in RWD (the DSC's own, not avoidable without flashing the transfer case):
 * the DSC stores 480724 and the cluster shows an all-wheel-drive notice until AWD is back.
 */
const fs = require('fs');
const path = require('path');
// in the built app the kit sits beside this file; the PC tests load it from the repo
let kitDiag;
try { kitDiag = require('./kit/diag'); } catch (e) { kitDiag = require('../../kit/runtime/diag'); }
const { parseDtcReply } = kitDiag;

const DSC = 0x29;
const LMV = 0x19;
const DID_SGBD = [0xF1, 0x50];
const DID_LMV_FUNKTION = [0xDB, 0xE1];
const DID_LMV_MOMENT = [0xDB, 0x32];
const WRITE = { off: [0xDB, 0xE1, 0x00], on: [0xDB, 0xE1, 0x01] };
const DTC_XDRIVE_OFF = '480724';

const ALLOWED = { '0F2510': 'DSC_G20' };        // measured by others on G22 M440i, G26, G20 330e, G42 230i
const LMV_OFF_MASK = 0xC0;                      // DB32 requested-torque qualifier: 0x2x active, 0xE8 off

const IGNITION = 7, READY_START = 8, READY = 10;
const IGN_ON_STATES = [IGNITION, READY_START, READY];
const IGN_OFF_STATES = [1, 2, 3, 5];
const FRESH_MS = 3000;
const CONFIRM_MS = 6000;
const COOLDOWN_MS = 10000;
const MAX_ATTEMPTS = 4;
const POLL_MS = 2000;
const TORQUE_MS = 1000;
const VERIFY_MS = 6000;                         // the read-back must show the new mode within this

const NRC = {
    0x12: 'sub-function not supported', 0x13: 'wrong length', 0x22: 'conditions not correct',
    0x31: 'not supported by this DSC', 0x33: 'security access denied', 0x7E: 'not in this session',
    0x7F: 'not in this session', 0x83: 'engine is running', 0x88: 'vehicle speed too high',
    0x90: 'selector not in P',
};
const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
const hexs = (a) => Array.from(a || [], hex2).join(' ');
const sgbdIndex = (data) => data.map(hex2).join('').replace(/^0+(?=.{6})/, '');

class RwdMode {
    /** ctx: { settings, log, dataDir }, car: kit/car.js, diag: kit/diag.js Diag, now: clock (tests). */
    constructor(ctx, car, diag, now) {
        this.ctx = ctx; this.car = car; this.diag = diag; this.log = ctx.log;
        this.now = now || (() => Date.now());
        this.file = ctx.dataDir ? path.join(ctx.dataDir, 'rwd_mode.json') : null;
        // learned on this car: offRunning true/false/null, onWorks true/false/null; cleanup: our 480724 to remove
        this.learned = { offRunning: null, onWorks: null, cleanup: false };
        try { if (this.file) Object.assign(this.learned, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first run */ }
        this._resetUnit();
        this._resetCycle();
    }

    _save() { try { if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.learned)); } catch (e) { this.log.warn('rwd save: ' + e); } }

    _resetUnit() { this.index = null; this.unit = null; this.lmvIndex = null; this.supported = null; this.reason = null; }

    _resetCycle() {
        this.dbe1 = null; this.dbe1Running = false;
        this.lmvState = null; this.torque = null;
        this.pending = null;                    // { want: 'off'|'on', until } awaiting read-back
        this.offSet = false;                    // RWD accepted this cycle and DBE1 read back 0
        this.confirm = null;                    // { which, until }
        this.busy = false; this.reading = false;
        this.lastPoll = 0; this.lastTorque = 0;
        this.note = null; this.noteType = 'dim';
        this.attempts = 0; this.lastAttempt = 0;
        this.cleanupTried = false;
    }

    get armed() { return this.ctx.settings.get('arm') === 'on'; }
    linkUp() { return !!(this.diag && this.diag.available); }

    /* ---------- car state ---------- */

    live() {
        const d = (this.car && this.car.data()) || {};
        const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
        const fresh = !d.demo && !!this.car.lastCar && this.now() - this.car.lastCar <= FRESH_MS;
        return { demo: !!d.demo, fresh, rpm: num(d.rpm), speed: num(d.speed), stage: d.stage || null, condition: num(d.condition) };
    }

    engineRunning() {
        const d = this.live();
        return !d.demo && ((d.rpm !== null && d.rpm > 400) || d.condition === READY || d.condition === READY_START);
    }

    /** Conditions for a button; ok strictly true / false (unknown = false: no send on a guess). */
    checks(which) {
        const d = this.live();
        const yes = (v) => !d.demo && d.fresh && v;
        const list = [
            { label: 'Live data', ok: !d.demo && d.fresh },
            { label: 'Ignition on', ok: yes(IGN_ON_STATES.indexOf(d.condition) >= 0) },
            { label: 'Stopped', ok: yes(d.speed !== null && d.speed < 0.5) },
            { label: 'In P', ok: yes(d.stage === 'P') },
        ];
        // this DSC refused RWD with the engine running once: from then on RWD asks for it off
        if (which === 'off' && this.learned.offRunning === false) {
            list.push({ label: 'Engine off', ok: yes(d.condition === IGNITION && d.rpm !== null && d.rpm < 50) });
        }
        list.push({ label: 'Parking brake on', ok: null, info: true });     // the head unit can't see it
        return list;
    }

    blocker(which) {
        if (!this.armed) return 'Disarmed in Settings · nothing is sent';
        if (!this.linkUp()) return 'Waiting for the diagnostic link';
        if (this.supported === null) return 'Checking the DSC…';
        if (this.supported === false) return this.reason || 'Not available on this car';
        if (this.busy || this.pending) return 'Busy';
        if (which === 'on' && this.learned.onWorks === false) return 'This DSC ignores AWD on · switch the ignition off and on';
        const m = this.mode();
        if (which === 'off' && (m === 'RWD' || m === 'RWD SET')) return 'Already RWD';
        if (which === 'on' && m === 'AWD') return 'Already AWD';
        if (this.attempts >= MAX_ATTEMPTS) return 'Too many attempts · switch the ignition off and on';
        const wait = this.lastAttempt + COOLDOWN_MS - this.now();
        if (wait > 0) return 'Wait ' + Math.ceil(wait / 1000) + ' s';
        const bad = this.checks(which).find((c) => !c.info && c.ok !== true);
        return bad ? 'Needs: ' + bad.label : null;
    }

    /* ---------- diagnostics ---------- */

    async _exchange(ecu, sid, data, accept, timeoutMs) {
        this.log.info('rwd: -> ' + hex2(ecu) + ' ' + hexs([sid].concat(data)));
        let r;
        try { r = await this.diag.physical(ecu, sid, data, timeoutMs || 2500, accept); } catch (e) {
            this.log.warn('rwd: transport ' + (e && e.message || e));
            return { ok: false, nrc: null, raw: null };
        }
        this.log.info('rwd: <- ' + hex2(ecu) + ' ' + (r && r.length ? hexs(r) : 'no answer'));
        if (!r || !r.length) return { ok: false, nrc: null, raw: null };
        if (r[0] === 0x7F && r[1] === sid) return { ok: false, nrc: r[2], raw: r };
        if (r[0] === sid + 0x40) return { ok: true, data: r.slice(3), raw: r };
        return { ok: false, nrc: null, raw: r };
    }

    async _read(ecu, did) {
        const r = await this._exchange(ecu, 0x22, did, (u) => (u[0] === 0x62 && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7F && u[1] === 0x22));
        return r.ok && !(r.raw[1] === did[0] && r.raw[2] === did[1]) ? { ok: false, nrc: null } : r;
    }

    async identify() {
        this._resetUnit();
        if (!this.armed || !this.linkUp()) return;
        const sg = await this._read(DSC, DID_SGBD);
        if (!sg.ok) { this.supported = false; this.reason = 'The DSC did not identify itself'; return; }
        this.index = sgbdIndex(sg.data);
        this.unit = ALLOWED[this.index] || null;
        if (!this.unit) {
            this.supported = false;
            this.reason = 'DSC ' + this.index + ' is not on the allowed list · nothing will be sent';
            this.log.warn('rwd: DSC ' + this.index + ' not allowed');
            return;
        }
        const r = await this._read(DSC, DID_LMV_FUNKTION);
        if (!r.ok || !r.data.length) {
            this.supported = false;
            this.reason = 'The DSC does not answer LMV_FUNKTION' + (r.nrc != null ? ' (NRC ' + hex2(r.nrc) + ')' : '');
            return;
        }
        this.supported = true;
        this._setDbe1(r.data[0]);
        const lv = await this._read(LMV, DID_SGBD);
        if (lv.ok) this.lmvIndex = sgbdIndex(lv.data);
        await this._readTorque();
        this.log.info('rwd: DSC ' + this.index + ' (' + this.unit + ') DBE1 ' + this.dbe1 + ' LMV ' + (this.lmvIndex || '?')
            + ' learned ' + JSON.stringify(this.learned));
    }

    _setDbe1(b) { this.dbe1 = b ? 1 : 0; this.dbe1Running = this.engineRunning(); }

    async _readTorque() {
        const r = await this._read(LMV, DID_LMV_MOMENT);
        if (!r.ok || r.data.length < 8) return;
        const s16 = (i) => ((r.data[i] << 8 | r.data[i + 1]) << 16 >> 16) / 4;
        this.torque = { actual: s16(0), requested: s16(4) };
        const q = r.data[6] << 8 | r.data[7];
        const st = (q & LMV_OFF_MASK) === LMV_OFF_MASK ? 'off' : 'on';
        if (st !== this.lmvState) this.log.info('rwd: transfer case reports xDrive ' + st + ' (qualifier ' + hex2(r.data[6]) + hex2(r.data[7]) + ')');
        this.lmvState = st;
    }

    /** Vehicle state changes: an ignition off ends the cycle (AWD is back by itself). */
    onCondition(n) {
        if (IGN_OFF_STATES.indexOf(n) >= 0) { this.log.info('rwd: ignition off · cycle state cleared'); this._resetCycle(); }
    }

    /** Called with each frame while on screen. */
    tick() {
        if (!this.armed || this.busy || this.reading || this.supported !== true || !this.linkUp()) return null;
        const t = this.now();
        const jobs = [];
        if (t - this.lastPoll >= POLL_MS || this.pending) {
            this.lastPoll = t;
            jobs.push(this._read(DSC, DID_LMV_FUNKTION).then((r) => { if (r.ok && r.data.length) this._setDbe1(r.data[0]); }));
        }
        if (t - this.lastTorque >= TORQUE_MS) { this.lastTorque = t; jobs.push(this._readTorque()); }
        if (!jobs.length) return null;
        this.reading = true;
        return Promise.all(jobs).then(() => this._afterReads()).then(() => { this.reading = false; }, (e) => { this.reading = false; throw e; });
    }

    /** Settle a pending switch from the read-back, and remove our own fault entry once AWD is back. */
    async _afterReads() {
        const m = this.mode();
        if (this.pending) {
            const want = this.pending.want === 'off' ? ['RWD', 'RWD SET'] : ['AWD'];
            if (want.indexOf(m) >= 0) {
                if (this.pending.want === 'on') { this.learned.onWorks = true; this._save(); }
                this.note = this.pending.want === 'off' ? 'RWD confirmed' + (this.engineRunning() ? '' : ' · start the engine without switching the ignition off')
                    : 'AWD confirmed';
                this.noteType = 'go';
                this.pending = null;
            } else if (this.now() > this.pending.until) {
                if (this.pending.want === 'on') {
                    this.learned.onWorks = false; this._save();
                    this.note = 'The DSC accepted AWD but the transfer case stayed off · switch the ignition off and on';
                } else this.note = 'Accepted, but no read-back shows RWD · treat it as AWD';
                this.noteType = 'warn';
                this.pending = null;
            }
        }
        if (m === 'AWD' && this.learned.cleanup && !this.cleanupTried && !this.pending) await this._cleanup();
    }

    /** Clear 480724 only, and only when it is the DSC's sole entry. Stopped in P, like the buttons. */
    async _cleanup() {
        const d = this.live();
        if (!(d.fresh && d.speed !== null && d.speed < 0.5 && d.stage === 'P')) return;     // later, when parked
        this.cleanupTried = true;
        const params = [0x02, 0xFF];
        const r = await this._exchange(DSC, 0x19, params, (u) => (u[0] === 0x59 && u[1] === 0x02) || (u[0] === 0x7F && u[1] === 0x19), 4000);
        const p = parseDtcReply(r.raw, params);
        if (!p.ok) { this.log.warn('rwd: DSC fault read failed, cleanup later'); this.cleanupTried = false; return; }
        const codes = p.dtcs.map((x) => x.code.toUpperCase());
        if (!codes.length) { this.learned.cleanup = false; this._save(); return; }
        if (codes.some((c) => c !== DTC_XDRIVE_OFF)) {
            this.learned.cleanup = false; this._save();
            this.note = 'Other DSC faults stored (' + codes.filter((c) => c !== DTC_XDRIVE_OFF).join(', ') + ') · left alone, check with a scanner';
            this.noteType = 'warn';
            return;
        }
        const c = await this._exchange(DSC, 0x14, [0xFF, 0xFF, 0xFF], (u) => u[0] === 0x54 || (u[0] === 0x7F && u[1] === 0x14), 8000);
        if (c.ok || (c.raw && c.raw[0] === 0x54)) {
            this.learned.cleanup = false; this._save();
            this.note = 'AWD confirmed · xDrive-off fault 480724 cleared'; this.noteType = 'go';
        } else this.log.warn('rwd: clear refused ' + (c.nrc != null ? 'NRC ' + hex2(c.nrc) : 'no answer'));
    }

    /* ---------- buttons ---------- */

    /** First press asks, the second within CONFIRM_MS sends. which = 'off' (RWD) | 'on' (AWD). */
    async press(which) {
        const b = this.blocker(which);
        if (b) { this.note = b; this.noteType = 'warn'; this.confirm = null; return; }
        if (!this.confirm || this.confirm.which !== which || this.now() > this.confirm.until) {
            this.confirm = { which, until: this.now() + CONFIRM_MS };
            this.note = 'Parking brake on? Press again to switch to ' + (which === 'off' ? 'RWD' : 'AWD');
            this.noteType = 'warn';
            return;
        }
        this.confirm = null;
        await this._send(which);
    }

    confirming(which) { return !!this.confirm && this.confirm.which === which && this.now() <= this.confirm.until; }

    async _send(which) {
        const b = this.blocker(which);                       // everything once more, the car may have rolled
        if (b) { this.note = b; this.noteType = 'warn'; return; }
        this.busy = true;
        try {
            this.attempts++; this.lastAttempt = this.now();
            const running = this.engineRunning();
            const r = await this._exchange(DSC, 0x2E, WRITE[which],
                (u) => (u[0] === 0x6E && u[1] === 0xDB && u[2] === 0xE1) || (u[0] === 0x7F && u[1] === 0x2E));
            if (!r.ok) {
                if (which === 'off' && running && (r.nrc === 0x22 || r.nrc === 0x83)) {
                    this.learned.offRunning = false; this._save();
                    this.note = 'This DSC takes RWD only with the engine off · switch it off (ignition on) and press again';
                } else {
                    this.note = r.nrc != null ? 'Refused: ' + (NRC[r.nrc] || 'NRC ' + hex2(r.nrc))
                        + (r.nrc === 0x33 ? ' · try diagnostic mode: Start 3x without the brake' : '')
                        : 'No answer from the DSC · nothing changed';
                }
                this.noteType = 'warn';
                return;
            }
            if (which === 'off') {
                this.learned.cleanup = true;
                if (running) this.learned.offRunning = true;
                this._save();
            }
            this.offSet = which === 'off';
            this.pending = { want: which, until: this.now() + VERIFY_MS };
            this.note = 'Accepted · checking…'; this.noteType = 'dim';
            this.log.info('rwd: ' + which + ' accepted' + (running ? ' (engine running)' : ''));
        } finally {
            this.busy = false;
        }
    }

    /** AWD / RWD from a read-back only. */
    mode() {
        if (this.supported !== true) return null;
        if (this.lmvState) return this.lmvState === 'off' ? 'RWD' : 'AWD';
        if (this.dbe1 !== null && this.dbe1Running) return this.dbe1 ? 'AWD' : 'RWD';
        // engine off and no transfer-case answer: DBE1 = 0 right after our own accepted write is the DSC's word
        if (this.dbe1 === 0 && (this.offSet || (this.pending && this.pending.want === 'off'))) return 'RWD SET';
        return null;
    }

    view() {
        return {
            armed: this.armed, link: this.linkUp(), supported: this.supported, reason: this.reason,
            index: this.index, unit: this.unit, lmvIndex: this.lmvIndex, mode: this.mode(),
            torque: this.torque, checks: this.checks(this.mode() === 'AWD' ? 'off' : 'on'),
            blockOff: this.blocker('off'), blockOn: this.blocker('on'),
            confirmOff: this.confirming('off'), confirmOn: this.confirming('on'),
            busy: this.busy || !!this.pending, note: this.note, noteType: this.noteType, learned: this.learned,
        };
    }
}

module.exports = { RwdMode, ALLOWED, WRITE, MAX_ATTEMPTS, CONFIRM_MS, COOLDOWN_MS, VERIFY_MS };

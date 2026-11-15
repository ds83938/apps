'use strict';
// RWD Mode against an in-memory DSC / transfer case. No car needed:
//   node kit/tools/test_rwd_mode.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RwdMode, MAX_ATTEMPTS, COOLDOWN_MS, CONFIRM_MS, VERIFY_MS } = require('../../apps/rwd_mode/rwd');

function fake(opts) {
    const o = Object.assign({ index: [0x00, 0x0F, 0x25, 0x10], nrc: null, offNeedsEngineOff: false, onIgnored: false,
        dtcs: null, engine: 'running' }, opts);
    const sent = [];
    const state = { dbe1: 1, dtcs: o.dtcs || [] };
    const carData = o.engine === 'running' ? { rpm: 750, speed: 0, stage: 'P', condition: 10, demo: false }
        : { rpm: 0, speed: 0, stage: 'P', condition: 7, demo: false };
    const diag = {
        available: true,
        async physical(ecu, sid, data) {
            sent.push([ecu, sid].concat(data).map((b) => b.toString(16).padStart(2, '0')).join(' '));
            if (sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50) return [0x62, 0xF1, 0x50].concat(ecu === 0x29 ? o.index : [0, 0x0F, 0x21, 0x80]);
            if (ecu === 0x29 && sid === 0x22 && data[0] === 0xDB && data[1] === 0xE1) return [0x62, 0xDB, 0xE1, state.dbe1];
            if (ecu === 0x29 && sid === 0x2E) {
                if (o.nrc) return [0x7F, 0x2E, o.nrc];
                if (data[2] === 0 && o.offNeedsEngineOff && carData.rpm > 50) return [0x7F, 0x2E, 0x22];
                if (data[2] === 1 && o.onIgnored) return [0x6E, 0xDB, 0xE1];
                state.dbe1 = data[2];
                if (data[2] === 0 && state.dtcs.indexOf('480724') < 0) state.dtcs.push('480724');
                return [0x6E, 0xDB, 0xE1];
            }
            if (ecu === 0x29 && sid === 0x19) {
                const out = [0x59, 0x02, 0xFF];
                state.dtcs.forEach((c) => out.push(parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), 0x08));
                return out;
            }
            if (ecu === 0x29 && sid === 0x14) { state.dtcs = []; return [0x54]; }
            if (ecu === 0x19 && sid === 0x22 && data[0] === 0xDB && data[1] === 0x32)
                return [0x62, 0xDB, 0x32, 0, 0, 0, 0, 0, 0, 0, state.dbe1 ? 0x20 : 0xE8];
            return [0x7F, sid, 0x31];
        },
    };
    let t = 1e6;
    const car = { lastCar: t, data: () => carData };
    const set = { arm: 'on' };
    const dataDir = o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rwd-'));
    const ctx = { settings: { get: (k) => set[k] }, log: { info() {}, warn() {}, error() {} }, dataDir };
    const rwd = new RwdMode(ctx, car, diag, () => t);
    const adv = (ms) => { t += ms; car.lastCar = t; };
    const twice = async (w) => { await rwd.press(w); adv(300); await rwd.press(w); };
    const settle = async () => { for (let i = 0; i < 5; i++) { adv(2100); await rwd.tick(); } };
    const writes = () => sent.filter((s) => /^29 2e /.test(s));
    return { rwd, sent, state, car, carData, set, adv, twice, settle, writes, dataDir };
}

(async () => {
    // disarmed: not one byte
    { const f = fake(); f.set.arm = 'off'; await f.rwd.identify(); await f.twice('off'); await f.twice('on');
      assert.strictEqual(f.sent.length, 0, 'disarmed sends nothing'); }

    // unlisted DSC: reads only
    { const f = fake({ index: [0, 0x0F, 0x28, 0x50] }); await f.rwd.identify();
      assert.strictEqual(f.rwd.supported, false); await f.twice('off');
      assert.strictEqual(f.writes().length, 0); assert.ok(!f.sent.some((s) => /^29 (14|2e)/.test(s))); }

    // engine running: RWD, then AWD, then the 480724 entry is cleared
    { const f = fake(); await f.rwd.identify(); assert.strictEqual(f.rwd.mode(), 'AWD');
      await f.rwd.press('off'); assert.strictEqual(f.writes().length, 0, 'first press only asks');
      f.adv(300); await f.rwd.press('off'); await f.settle();
      assert.deepStrictEqual(f.writes(), ['29 2e db e1 00']);
      assert.strictEqual(f.rwd.mode(), 'RWD'); assert.strictEqual(f.rwd.learned.offRunning, true);
      f.adv(COOLDOWN_MS); await f.twice('on'); await f.settle();
      assert.deepStrictEqual(f.writes(), ['29 2e db e1 00', '29 2e db e1 01']);
      assert.strictEqual(f.rwd.mode(), 'AWD'); assert.strictEqual(f.rwd.learned.onWorks, true);
      assert.ok(f.sent.indexOf('29 14 ff ff ff') >= 0, 'own fault cleared');
      assert.deepStrictEqual(f.state.dtcs, []); assert.strictEqual(f.rwd.learned.cleanup, false); }

    // another DSC fault stored: never cleared
    { const f = fake({ dtcs: ['5E1234'] }); await f.rwd.identify();
      await f.twice('off'); await f.settle(); f.adv(COOLDOWN_MS); await f.twice('on'); await f.settle();
      assert.ok(f.sent.indexOf('29 14 ff ff ff') < 0, 'mixed faults left alone');
      assert.ok(/Other DSC faults/.test(f.rwd.note)); }

    // cleanup waits while moving, happens once parked
    { const f = fake(); await f.rwd.identify(); await f.twice('off'); await f.settle();
      f.adv(COOLDOWN_MS); await f.twice('on'); f.carData.stage = 'D'; f.carData.speed = 20; await f.settle();
      assert.ok(f.sent.indexOf('29 14 ff ff ff') < 0, 'no clear while driving');
      f.carData.stage = 'P'; f.carData.speed = 0; await f.settle();
      assert.ok(f.sent.indexOf('29 14 ff ff ff') >= 0, 'cleared once parked'); }

    // a DSC that wants the engine off for RWD: learned, then asked for; remembered across restarts
    { const f = fake({ offNeedsEngineOff: true }); await f.rwd.identify(); await f.twice('off');
      assert.strictEqual(f.rwd.learned.offRunning, false); assert.ok(/engine off/i.test(f.rwd.note));
      f.adv(COOLDOWN_MS); await f.twice('off'); assert.strictEqual(f.writes().length, 1, 'blocked until the engine is off');
      f.carData.rpm = 0; f.carData.condition = 7; await f.twice('off');
      assert.strictEqual(f.writes().length, 2); await f.settle(); assert.strictEqual(f.rwd.mode(), 'RWD');
      const g = fake({ dataDir: f.dataDir }); assert.strictEqual(g.rwd.learned.offRunning, false, 'remembered'); }

    // a DSC that accepts 01 but changes nothing: shown honestly, AWD button retired
    { const f = fake({ onIgnored: true }); await f.rwd.identify(); await f.twice('off'); await f.settle();
      f.adv(COOLDOWN_MS); await f.twice('on'); f.adv(VERIFY_MS + 1); await f.settle();
      assert.strictEqual(f.rwd.mode(), 'RWD'); assert.strictEqual(f.rwd.learned.onWorks, false);
      assert.ok(/ignition/.test(f.rwd.view().blockOn)); }

    // every gate blocks
    const gates = [['moving', (d) => { d.speed = 4; }], ['in D', (d) => { d.stage = 'D'; }],
        ['selector unknown', (d) => { d.stage = undefined; }], ['speed unknown', (d) => { d.speed = null; }],
        ['demo', (d) => { d.demo = true; }], ['ignition off', (d) => { d.condition = 5; d.rpm = 0; }]];
    for (const [name, mut] of gates) {
        const f = fake(); await f.rwd.identify(); mut(f.carData); await f.twice('off');
        assert.strictEqual(f.writes().length, 0, name + ' must block');
    }
    { const f = fake(); await f.rwd.identify(); f.car.lastCar -= 10000; await f.rwd.press('off'); await f.rwd.press('off');
      assert.strictEqual(f.writes().length, 0, 'stale data must block'); }
    { const f = fake(); await f.rwd.identify(); await f.rwd.press('off'); f.carData.speed = 2; f.adv(300); await f.rwd.press('off');
      assert.strictEqual(f.writes().length, 0, 'rechecked at send'); }
    { const f = fake(); await f.rwd.identify(); await f.rwd.press('off'); f.adv(CONFIRM_MS + 1); await f.rwd.press('off');
      assert.strictEqual(f.writes().length, 0, 'late second press only asks again'); }
    { const f = fake(); await f.rwd.identify(); await f.rwd.press('off'); f.adv(300); await f.rwd.press('on');
      assert.strictEqual(f.writes().length, 0, 'the other button does not confirm'); }

    // refusals: capped
    { const f = fake({ nrc: 0x33 }); await f.rwd.identify();
      for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { await f.twice('off'); f.adv(COOLDOWN_MS + 1); }
      assert.strictEqual(f.writes().length, MAX_ATTEMPTS); }

    // ignition cycle resets the per-cycle state but keeps what was learned
    { const f = fake(); await f.rwd.identify(); await f.twice('off'); await f.settle();
      f.rwd.onCondition(5); assert.strictEqual(f.rwd.attempts, 0); assert.strictEqual(f.rwd.learned.offRunning, true); }

    console.log('rwd_mode: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

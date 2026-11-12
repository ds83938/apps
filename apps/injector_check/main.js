'use strict';
/**
 * Injector Check - an INPA-style look at the six injectors of a B58 (and B48 / B38) engine, read from the
 * engine unit (DME) over the head unit's diagnostic link. Only reads: see inj_link.js.
 *
 * Pages (tabs, or the bar's Next page):
 *   Injectors  per cylinder, live: the DME's injector flow correction, rough running, misfire counter and
 *              ignition angle, each cylinder against the median of the other five (inj_analysis.js)
 *   Fuel       rail pressure actual / target (with a trace), low pressure fuel, lambda actual / target,
 *              mixture adaptation, mean injector adaptation, fuel temperature, flow, quality, ethanol, knock
 *   Idle test  30 s of averaging at a warm idle (like INPA's smooth-running test); results are kept in
 *              data/idle-tests.json so a later test can be compared with an earlier one
 *   Faults     the DME's fault memory (codes and status) and the OBD misfire monitors per cylinder
 *
 * With no car (the emulator, or a car that hasn't answered within a few seconds and Demo = Auto) the
 * pages run on made-up data (inj_demo.js) and show a DEMO badge.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const D = require('./inj_dids');
const A = require('./inj_analysis');
const { InjLink } = require('./inj_link');
const Demo = require('./inj_demo');

const W = 1600, H = 520;
const PAGES = ['injectors', 'fuel', 'test', 'faults'];
const TABS = ['Injectors', 'Fuel', 'Idle test', 'Faults'];
const FRESH_MS = 5000;              // a value older than this shows as no data
const MISSING_RETRY_MS = 60000;     // an identifier the DME refused is asked again after this
const TEST_MS = 30000;
const HISTORY = 20;                 // idle tests kept
const RAIL_SEC = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = A.isNum;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const histFile = path.join(ctx.dataDir || '.', 'idle-tests.json');
        let page = Math.max(0, PAGES.indexOf(settings.get('page')));

        /* ---------------- reading ---------------- */
        const raw = {};             // hex -> { v, t }
        const missing = {};         // hex -> when the DME refused it
        const startT = Date.now();
        let lastReply = 0;
        const link = new InjLink(ctx.signals, log);
        link.init().then(() => log.info('diagnostic link ' + (link.ready ? 'ready' : 'not available: ' + link.error)))
            .catch((e) => log.warn('diagnostic link: ' + e));
        const demo = new Demo();

        const carPresent = () => Date.now() - lastReply < 10000;
        const usingDemo = () => settings.get('demo') === 'on'
            || (settings.get('demo') === 'auto' && !carPresent() && (!link.ready || Date.now() - startT > 8000));

        const missingNow = () => {
            const out = {}, now = Date.now();
            Object.keys(missing).forEach((h) => { if (now - missing[h] < MISSING_RETRY_MS) out[h] = true; });
            return out;
        };
        const put = (h, v) => { if (isNum(v)) { raw[h] = { v, t: Date.now() }; lastReply = Date.now(); } };

        async function readOne(h) {
            const u = await link.readMany([D.DID[h].did]);
            if (!u) return;
            if (u[0] === 0x7F) { if (u[2] !== 0x21 && u[2] !== 0x78) missing[h] = Date.now(); lastReply = Date.now(); return; }
            const vals = D.splitReply(u);
            if (vals && vals[h] !== undefined) put(h, vals[h]); else missing[h] = Date.now();
        }

        async function pollOnce() {
            const which = test.running ? 'test' : PAGES[page];
            const dids = D.didsFor(which, missingNow());
            for (let i = 0; i < dids.length; i += 8) {
                const chunk = dids.slice(i, i + 8);
                const u = await link.readMany(chunk.map((h) => D.DID[h].did));
                if (u === undefined || u === null) continue;
                if (u[0] === 0x62) {
                    const vals = D.splitReply(u);
                    if (vals) { Object.keys(vals).forEach((h) => put(h, vals[h])); continue; }
                }
                // refused (one of them isn't there: NRC 31) or a reply that doesn't add up: one at a time
                if (u[0] === 0x7F && u[2] === 0x21) continue;
                for (const h of chunk) await readOne(h);
            }
        }

        /** The current readings (car or demo): { values: { key: v }, cyl: { inj: [..6], ... } } */
        function data() {
            if (usingDemo()) return demo.sample();
            const now = Date.now(), fresh = (h) => raw[h] && now - raw[h].t < FRESH_MS ? raw[h].v : null;
            const values = {}, cyl = {};
            Object.keys(D.VALUES).forEach((k) => {
                for (const h of D.VALUES[k]) { const v = fresh(h); if (isNum(v)) { values[k] = v; break; } }
            });
            Object.keys(D.CYL).forEach((g) => { cyl[g] = D.CYL[g].map(fresh); });
            return { values, cyl };
        }

        /* ---------------- rail trace (Fuel page) ---------------- */
        const rail = [];            // [t, actual, target]
        let lastRailT = 0;

        /* ---------------- idle test ---------------- */
        const test = { running: false, t0: 0, inj: null, rough: null, mis0: null, mis1: null, rpm: null, cool: null, samples: 0, result: null, note: '' };
        let history = [];
        try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); if (!Array.isArray(history)) history = []; } catch (e) { history = []; }

        function startTest() {
            const d = data(), rpm = d.values.rpm, cool = d.values.coolant;
            if (!usingDemo() && !(isNum(rpm) && rpm > 400 && rpm < 1100)) {
                test.note = isNum(rpm) && rpm >= 1100 ? 'Let the engine idle (below 1100 rpm), foot off the pedal, then start.' : 'Start the engine and let it idle, then start the test.';
                return;
            }
            Object.assign(test, { running: true, t0: Date.now(), inj: new A.Stats(), rough: new A.Stats(), rpm: new A.Stats(), cool: null, mis0: null, mis1: null, samples: 0, result: null,
                note: isNum(cool) && cool < 60 ? 'Engine still cold (' + T(cool).toFixed(0) + tU() + '): a warm engine gives a fairer result.' : '' });
            log.info('idle test started');
        }

        function afterSample() {
            const now = Date.now();
            if (page === 1 || now - lastRailT > 1000) {
                if (now - lastRailT >= 250) {
                    const v = data().values;
                    rail.push([now, isNum(v.rail) ? v.rail : null, isNum(v.railTarget) ? v.railTarget : null]);
                    while (rail.length && now - rail[0][0] > RAIL_SEC * 1000) rail.shift();
                    lastRailT = now;
                }
            }
            if (!test.running) return;
            const d = data(), rpm = d.values.rpm;
            if (!usingDemo() && isNum(rpm) && (rpm < 300 || rpm > 1500)) {
                test.running = false;
                test.note = rpm < 300 ? 'Stopped: the engine went off.' : 'Stopped: the revs went up (' + rpm.toFixed(0) + ' rpm). Keep it at idle.';
                return;
            }
            test.inj.add(d.cyl.inj.map(A.pct));
            test.rough.add(d.cyl.rough);
            test.rpm.add([rpm]);
            if (isNum(d.values.coolant)) test.cool = d.values.coolant;
            if (!test.mis0 && d.cyl.misfire.some(isNum)) test.mis0 = d.cyl.misfire.slice();
            if (d.cyl.misfire.some(isNum)) test.mis1 = d.cyl.misfire.slice();
            test.samples++;
            if (now - test.t0 >= TEST_MS) finishTest();
        }

        function finishTest() {
            test.running = false;
            const inj = test.inj.means(), rough = test.rough.means();
            const mis = [0, 1, 2, 3, 4, 5].map((i) => (test.mis0 && test.mis1 && isNum(test.mis0[i]) && isNum(test.mis1[i]) ? Math.max(0, test.mis1[i] - test.mis0[i]) : null));
            const j = A.judge({ inj: inj.map((p) => (isNum(p) ? 1 + p / 100 : null)), rough, misfire: mis, ign: [] });
            const r = {
                t: Date.now(), demo: usingDemo(), samples: test.samples, rpm: test.rpm.mean(0), coolant: test.cool,
                inj, injSd: [0, 1, 2, 3, 4, 5].map((i) => test.inj.sd(i)),
                rough, roughSd: [0, 1, 2, 3, 4, 5].map((i) => test.rough.sd(i)), misfires: mis,
                suspects: j.suspects.map((s) => ({ cyl: s.cyl, level: s.level, why: s.why })),
            };
            test.result = r;
            if (test.samples < 10) { test.note = 'Too few readings (' + test.samples + '): the engine unit answered slowly. Try again.'; return; }
            if (!r.demo) {
                history.unshift(r);
                history = history.slice(0, HISTORY);
                try { fs.writeFileSync(histFile, JSON.stringify(history)); } catch (e) { log.warn('save idle test: ' + e); }
            }
            log.info('idle test done: ' + test.samples + ' samples, suspects ' + JSON.stringify(r.suspects.map((s) => s.cyl)));
        }

        /* ---------------- faults ---------------- */
        const faults = { t: 0, list: null, why: '', mon: null };
        let faultsBusy = false;
        async function readFaults() {
            if (faultsBusy) return;
            if (usingDemo()) {
                faults.t = Date.now(); faults.why = '';
                faults.list = [{ code: 'DEMO01', status: 0x08 }, { code: 'DEMO02', status: 0x2C }];
                faults.mon = [[0, 0], [0, 0], [0, 1], [2, 6], [0, 0], [0, 0]];
                return;
            }
            if (!link.ready) { faults.why = 'No diagnostic link on this head unit.'; return; }
            faultsBusy = true;
            try {
                const f = await link.faults();
                faults.list = f.ok ? f.dtcs : null;
                faults.why = f.ok ? '' : 'Fault memory: ' + f.why;
                const mon = [];
                for (let c = 0; c < 6; c++) {
                    const m = await link.monitor(0xA2 + c);           // OBD MID A2..A7: misfire, cylinder 1..6
                    const tid = (id) => { const x = m && m.find((r) => r.tid === id); return x ? x.value : null; };
                    mon.push([tid(0x0C), tid(0x0B)]);                  // this / last drive cycle, average of the last 10
                }
                faults.mon = mon.some((x) => x.some(isNum)) ? mon : null;
                faults.t = Date.now();
            } catch (e) { faults.why = String(e.message || e); } finally { faultsBusy = false; }
        }

        /* ---------------- units ---------------- */
        const psi = () => settings.get('units') === 'us';
        const P = (bar) => (isNum(bar) ? (psi() ? bar * 14.5038 : bar) : null);
        const pU = () => (psi() ? 'psi' : 'bar');
        const T = (c) => (isNum(c) ? (psi() ? c * 1.8 + 32 : c) : null);
        const tU = () => (psi() ? '°F' : '°C');
        const LV = (t, level) => (level === 'crit' ? t.crit : level === 'warn' ? t.warn : level === 'ok' ? t.text : t.dim);
        const fmtS = (x, d) => (isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '--');

        /* ---------------- drawing ---------------- */
        function drawInjectors(cv, t, d) {
            const v = d.values, j = A.judge(d.cyl);
            // strip: what the engine is doing, and the overall fuel corrections
            const y0 = G.TOP + 30;
            const strip = [
                ['RPM', G.fmt(v.rpm, 0), ''], ['COOLANT', G.fmt(T(v.coolant), 0), tU()],
                ['INJ. ADAPT. MEAN', fmtS(A.pct(v.injMean), 1), '%'], ['MIXTURE ADAPT.', fmtS(A.pct(v.mixMul), 1), '%'],
            ];
            let x = 28;
            strip.forEach((s) => {
                cv.text(s[0], x, y0, 16, t.dim, { font: 'bold', spacing: 1.5 });
                const w = cv.text(s[1], x + cv.textWidth(s[0], 16, { font: 'bold', spacing: 1.5 }) + 12, y0 + 2, 28, t.text, { font: 'num' });
                x += cv.textWidth(s[0], 16, { font: 'bold', spacing: 1.5 }) + 12 + w + 6;
                if (s[2]) x += cv.text(s[2], x, y0, 18, t.dim);
                x += 34;
            });
            cv.text('FIRING ORDER ' + D.FIRING.join('-'), W - 28, y0, 16, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });

            // six cylinder cards
            const top = G.TOP + 48, ch = 300, gap = 14, cw = (W - 48 - gap * 5) / 6;
            for (let i = 0; i < 6; i++) {
                const cx = 24 + i * (cw + gap), inj = j.inj[i], sus = j.suspects.find((s) => s.cyl === i + 1);
                G.panel(cv, t, cx, top, cw, ch, 'Cylinder ' + (i + 1));
                if (sus) G.pill(cv, t, cx + cw - 76, top + 18, 62, 30, sus.level === 'crit' ? 'CHECK' : 'LOOK', { color: sus.level === 'crit' ? t.crit : t.warn, size: 16, spacing: 1 });
                cv.text('INJECTOR CORRECTION', cx + 18, top + 76, 15, t.dim, { font: 'bold', spacing: 1.2 });
                const big = isNum(inj.v) ? fmtS(inj.v, 1) : '--';
                const bw = cv.text(big, cx + 18, top + 128, 50, LV(t, inj.level), { font: 'num' });
                cv.text(' %', cx + 18 + bw, top + 128, 22, t.dim);
                // a bar around 0: -10 .. +10 %
                const bx = cx + 18, bwid = cw - 36, by = top + 142, mid = bx + bwid / 2;
                cv.fillRect(bx, by, bwid, 8, withAlpha(t.tick, 0.35));
                cv.fillRect(mid - 1, by - 4, 2, 16, t.dim);
                if (isNum(inj.v)) {
                    const e = bx + bwid / 2 + G.clamp(inj.v / 10, -1, 1) * bwid / 2;
                    cv.fillRect(Math.min(mid, e), by, Math.max(2, Math.abs(e - mid)), 8, inj.level === 'crit' ? t.crit : inj.level === 'warn' ? t.warn : t.accent2 || t.accent);
                }
                const rows = [
                    ['Rough running', isNum(j.rough[i].v) ? fmtS(j.rough[i].v, 2) : '--', 'rad/s²', j.rough[i].level],
                    ['Misfires', isNum(d.cyl.misfire[i]) ? String(d.cyl.misfire[i]) : '--', '', j.misfire[i]],
                    ['Ignition', isNum(j.ign[i].v) ? fmtS(j.ign[i].v, 1) : '--', '°CA', j.ign[i].level],
                ];
                rows.forEach((r, k) => {
                    const ry = top + 192 + k * 34;
                    cv.text(r[0], cx + 18, ry, 19, t.dim);
                    const uw = r[2] ? cv.textWidth(' ' + r[2], 15) : 0;
                    cv.text(r[1], cx + cw - 18 - uw, ry, 24, LV(t, r[3]), { align: 'right', font: 'num' });
                    if (r[2]) cv.text(' ' + r[2], cx + cw - 18, ry, 15, t.dim, { align: 'right' });
                });
            }

            // verdict
            const vy = top + ch + 14;
            G.panel(cv, t, 24, vy, W - 48, G.BOTTOM - vy, null);
            const anyCyl = d.cyl.inj.some(isNum) || d.cyl.rough.some(isNum);
            let lines;
            if (!anyCyl) lines = [{ text: noDataWhy(), color: t.dim }];
            else if (!j.suspects.length) lines = [{ text: 'No cylinder stands out from the others right now.', color: t.text }];
            else lines = j.suspects.slice(0, 2).map((s) => ({ text: 'Cylinder ' + s.cyl + ': ' + s.why.join(' · '), color: LV(t, s.level) }));
            lines.forEach((l, k) => cv.text(fit(cv, l.text, W - 96, 21), 44, vy + 38 + k * 30, 21, l.color, { font: k === 0 ? 'bold' : 'label' }));
            cv.text('Live values move a lot. For a fair comparison run the Idle test with a warm engine.', W - 44, G.BOTTOM - 14, 16, t.dim, { align: 'right' });
        }

        function drawFuel(cv, t, d) {
            const v = d.values, dec = psi() ? 0 : 1, decLp = psi() ? 1 : 2;
            const diff = (a, b, k) => (isNum(a) && isNum(b) ? fmtS(a - b, k) : '');
            const railDev = isNum(v.rail) && isNum(v.railTarget) && v.railTarget > 20 ? (v.rail - v.railTarget) / v.railTarget * 100 : null;
            const lamDev = isNum(v.lambda) && isNum(v.lambdaTarget) ? v.lambda - v.lambdaTarget : null;
            const rows = [
                ['Rail pressure (high)', G.fmt(P(v.rail), 0), G.fmt(P(v.railTarget), 0), isNum(railDev) ? fmtS(railDev, 1) + ' %' : '', pU(), isNum(railDev) && Math.abs(railDev) > 15 ? 'warn' : null],
                ['Low pressure fuel', G.fmt(P(v.lpfp), decLp), '', '', pU() + ' (sensor raw)', null],
                ['Lambda', G.fmt(v.lambda, 3), G.fmt(v.lambdaTarget, 3), diff(v.lambda, v.lambdaTarget, 3), '', isNum(lamDev) && Math.abs(lamDev) > 0.05 ? 'warn' : null],
                ['Mixture adaptation', fmtS(A.pct(v.mixMul), 1), '', '', '% (+ = adds fuel)', isNum(v.mixMul) && Math.abs(A.pct(v.mixMul)) > 10 ? 'warn' : null],
                ['Injector adaptation, mean', fmtS(A.pct(v.injMean), 1), '', '', '%', null],
                ['Fuel temperature', G.fmt(T(v.fuelTemp), 0), '', '', tU(), null],
                ['Fuel flow', G.fmt(v.fuelFlow, 2), '', '', 'l/h', null],
                ['Fuel quality (adapted)', isNum(v.fuelQuality) ? G.fmt(98 - 7 * v.fuelQuality, 1) : '--', '', '', 'RON', null],
                ['Ethanol', G.fmt(v.ethanol, 0), '', '', '%', null],
                ['Knock retard, mean', G.fmt(v.knock, 1), '', '', '°CA', isNum(v.knock) && v.knock > 3 ? 'warn' : null],
            ];
            const lw = 900;
            G.panel(cv, t, 24, G.TOP + 8, lw, G.BOTTOM - G.TOP - 8, 'Fuel system');
            G.table(cv, t, 42, G.TOP + 64, lw - 36, [
                { label: 'Value', w: 330 }, { label: 'Actual', w: 140, align: 'right', font: 'num' }, { label: 'Target', w: 130, align: 'right', font: 'num' },
                { label: 'Diff', w: 110, align: 'right', font: 'num' }, { label: '', w: 154 },
            ], rows.map((r) => [r[0], { text: r[1], color: r[5] ? t[r[5]] : r[1] === '--' ? t.dim : t.text }, r[2], r[3], { text: '  ' + r[4], color: t.dim }]),
            { rowH: 37, size: 22 });

            // rail trace
            const rx = 24 + lw + 16, rw = W - rx - 24;
            G.panel(cv, t, rx, G.TOP + 8, rw, G.BOTTOM - G.TOP - 8, 'Rail pressure, last minute');
            const now = Date.now(), vals = rail.reduce((a, r) => a.concat([r[1], r[2]].filter(isNum)), []);
            const hi = vals.length ? Math.max.apply(null, vals) : 350, top = Math.max(50, Math.ceil(P(hi) * 1.15 / 50) * 50);
            G.chart(cv, t, rx + 16, G.TOP + 64, rw - 32, G.BOTTOM - G.TOP - 110, {
                xMin: -RAIL_SEC, xMax: 0, yMin: 0, yMax: top, xUnit: 's', yUnit: pU(),
                series: [
                    { pts: rail.map((r) => [(r[0] - now) / 1000, P(r[2])]), color: t.dim, width: 2, dash: true },
                    { pts: rail.map((r) => [(r[0] - now) / 1000, P(r[1])]), color: t.accent2 || t.accent },
                ],
                empty: 'no rail pressure yet',
            });
            cv.text('actual', rx + 70, G.BOTTOM - 14, 16, t.accent2 || t.accent, { font: 'bold' });
            cv.text('target (dashed)', rx + 150, G.BOTTOM - 14, 16, t.dim, { font: 'bold' });
        }

        function drawTest(cv, t, d) {
            const lw = 980;
            G.panel(cv, t, 24, G.TOP + 8, lw, G.BOTTOM - G.TOP - 8, 'Idle test (smooth running)');
            const px = 44;
            if (test.running) {
                const p = G.clamp((Date.now() - test.t0) / TEST_MS, 0, 1);
                cv.text('Recording... keep the engine at idle, foot off the pedal, A/C and lights as they are.', px, G.TOP + 92, 22, t.text);
                cv.roundRect(px, G.TOP + 112, lw - 40, 20, 10, withAlpha(t.tick, 0.35));
                cv.roundRect(px, G.TOP + 112, (lw - 40) * p, 20, 10, t.accent2 || t.accent);
                cv.text(Math.ceil((1 - p) * TEST_MS / 1000) + ' s left · ' + test.samples + ' readings', px, G.TOP + 162, 20, t.dim);
                drawTestTable(cv, t, px, G.TOP + 190, lw - 40, {
                    inj: test.inj.means(), injSd: [0, 1, 2, 3, 4, 5].map((i) => test.inj.sd(i)), rough: test.rough.means(),
                    roughSd: [0, 1, 2, 3, 4, 5].map((i) => test.rough.sd(i)), misfires: [null, null, null, null, null, null],
                }, true);
            } else if (test.result) {
                const r = test.result;
                const head = (r.demo ? 'DEMO · ' : '') + r.samples + ' readings at ' + G.fmt(r.rpm, 0) + ' rpm' + (isNum(r.coolant) ? ', coolant ' + G.fmt(T(r.coolant), 0) + tU() : '');
                cv.text(head, px, G.TOP + 84, 20, t.dim);
                drawTestTable(cv, t, px, G.TOP + 100, lw - 40, r, false);
                const s = r.suspects;
                const msg = !s.length ? { text: 'No cylinder stands out. Injectors look even.', color: t.text }
                    : { text: 'Cylinder ' + s[0].cyl + ': ' + s[0].why.join(' · '), color: LV(t, s[0].level) };
                const ls = wrap(cv, msg.text + (s.length > 1 ? '  ·  also cylinder ' + s.slice(1).map((x) => x.cyl).join(', ') : ''), lw - 40, 20).slice(0, 2);
                ls.forEach((l, k) => cv.text(l, px, G.BOTTOM - 22 - (ls.length - 1 - k) * 28, 20, msg.color, { font: 'bold' }));
            } else {
                const tips = [
                    'Averages each cylinder for 30 s, the way INPA\'s smooth-running test does.',
                    '1. Warm engine (coolant 80 °C or more), parked, idling.',
                    '2. Foot off the pedal. Leave A/C and lights as they are.',
                    '3. Press Start. Each cylinder is compared with the other five.',
                    '',
                    'Injector correction + = the DME adds fuel to that cylinder (under-flowing),',
                    '- = it takes fuel away (over-flowing or dripping).',
                ];
                tips.forEach((l, k) => cv.text(l, px, G.TOP + 92 + k * 32, 21, k === 0 ? t.text : t.dim));
            }
            if (test.note) cv.text(fit(cv, test.note, lw - 40, 18), px, test.result && !test.running ? G.TOP + 64 + 300 : G.BOTTOM - 20, 18, t.warn);
            G.button(cv, t, 24 + lw - 220, G.TOP + 26, 200, 46, test.running ? 'Stop' : test.result ? 'Run again' : 'Start', () => toggleTest(), { primary: !test.running });

            // history
            const hx = 24 + lw + 16, hw = W - hx - 24;
            G.panel(cv, t, hx, G.TOP + 8, hw, G.BOTTOM - G.TOP - 8, 'Earlier tests');
            const rows = history.slice(0, 8).map((r) => {
                const worst = r.suspects && r.suspects[0];
                const dev = A.compare(r.inj, A.LIMITS.inj).reduce((a, x) => (isNum(x.dev) && Math.abs(x.dev) > Math.abs(a) ? x.dev : a), 0);
                return [dateOf(r.t), { text: worst ? 'Cyl ' + worst.cyl : 'even', color: worst ? LV(t, worst.level) : t.text }, fmtS(dev, 1) + ' %'];
            });
            G.table(cv, t, hx + 18, G.TOP + 64, hw - 36, [{ label: 'When', w: 260 }, { label: 'Stands out', w: 140 }, { label: 'Max inj.', w: hw - 36 - 400, align: 'right', font: 'num' }],
                rows, { rowH: 40, size: 20, empty: 'none yet' });
        }

        function drawTestTable(cv, t, x, y, w, r, live) {
            const inj = A.compare(r.inj, A.LIMITS.inj), rough = A.compare(r.rough, A.LIMITS.rough);
            const mis = A.misfires(r.misfires || []);
            const rows = [0, 1, 2, 3, 4, 5].map((i) => [
                String(i + 1),
                { text: fmtS(inj[i].v, 1) + (isNum(r.injSd[i]) ? ' ±' + r.injSd[i].toFixed(1) : ''), color: live ? t.text : LV(t, inj[i].level) },
                { text: isNum(inj[i].dev) ? fmtS(inj[i].dev, 1) : '--', color: live ? t.dim : LV(t, inj[i].level) },
                { text: fmtS(rough[i].v, 2) + (isNum(r.roughSd[i]) ? ' ±' + r.roughSd[i].toFixed(2) : ''), color: live ? t.text : LV(t, rough[i].level) },
                { text: isNum(rough[i].dev) ? fmtS(rough[i].dev, 2) : '--', color: live ? t.dim : LV(t, rough[i].level) },
                { text: isNum(r.misfires[i]) ? String(r.misfires[i]) : '--', color: LV(t, mis[i]) },
            ]);
            G.table(cv, t, x, y, w, [
                { label: 'Cyl', w: 70 }, { label: 'Injector %', w: 200, align: 'right', font: 'num' }, { label: 'vs others', w: 140, align: 'right', font: 'num' },
                { label: 'Rough rad/s²', w: 220, align: 'right', font: 'num' }, { label: 'vs others', w: 140, align: 'right', font: 'num' }, { label: 'Misfires', w: w - 770, align: 'right', font: 'num' },
            ], rows, { rowH: 33, size: 21 });
        }

        function drawFaults(cv, t) {
            const lw = 820;
            G.panel(cv, t, 24, G.TOP + 8, lw, G.BOTTOM - G.TOP - 8, 'Engine fault memory');
            G.button(cv, t, 24 + lw - 220, G.TOP + 26, 200, 46, faultsBusy ? 'Reading...' : 'Read', () => readFaults(), { primary: true, busy: faultsBusy });
            const ST = (s) => [s & 0x01 && 'active', s & 0x08 && 'stored', s & 0x04 && 'pending', s & 0x80 && 'lamp'].filter(Boolean).join(', ') || 'history';
            const level = (s) => (s & 0x01 || s & 0x80 ? 'crit' : s & 0x0C ? 'warn' : null);
            if (!faults.t && !faults.why) {
                cv.text(faultsBusy ? 'Reading the engine unit...' : 'Press Read to get the DME\'s fault codes and misfire monitors.', 44, G.TOP + 110, 21, t.dim);
            } else {
                const list = faults.list || [];
                G.table(cv, t, 42, G.TOP + 84, lw - 36, [{ label: 'Code', w: 160, font: 'num' }, { label: 'Status', w: 300 }, { label: '', w: lw - 36 - 460 }],
                    list.slice(0, 9).map((f) => [{ text: f.code, color: LV(t, level(f.status)) || t.text }, ST(f.status), { text: '0x' + f.status.toString(16).toUpperCase().padStart(2, '0'), color: t.dim }]),
                    { rowH: 34, size: 22, empty: faults.why || 'No faults stored in the engine unit.' });
                if (list.length > 9) cv.text('+ ' + (list.length - 9) + ' more', 44, G.BOTTOM - 20, 18, t.dim);
                cv.text('Codes as the DME stores them. Look them up in ISTA or your DTC scanner.', lw, G.BOTTOM - 20, 16, t.dim, { align: 'right' });
            }
            const mx = 24 + lw + 16, mw = W - mx - 24;
            G.panel(cv, t, mx, G.TOP + 8, mw, G.BOTTOM - G.TOP - 8, 'OBD misfire monitor');
            if (faults.mon) {
                const m = faults.mon, lv = A.misfires(m.map((x) => x[0]));
                G.table(cv, t, mx + 18, G.TOP + 64, mw - 36, [{ label: 'Cylinder', w: 160 }, { label: 'This / last cycle', w: 250, align: 'right', font: 'num' }, { label: 'Avg 10 cycles', w: mw - 36 - 410, align: 'right', font: 'num' }],
                    m.map((x, i) => [String(i + 1), { text: isNum(x[0]) ? String(x[0]) : '--', color: LV(t, lv[i]) }, isNum(x[1]) ? String(x[1]) : '--']), { rowH: 40, size: 22 });
            } else cv.text(faults.t ? 'The engine unit gave no misfire monitor data.' : '', mx + 18, G.TOP + 110, 20, t.dim);
        }

        function noDataWhy() {
            if (!link.ready) return 'No diagnostic link: ' + (link.error || 'starting...');
            if (!carPresent()) return 'The engine unit doesn\'t answer. Ignition on? (Demo data shows in Auto after a few seconds.)';
            return 'The engine unit doesn\'t send these values (see the log).';
        }
        function fit(cv, s, w, size) {
            if (cv.textWidth(s, size) <= w) return s;
            while (s.length > 4 && cv.textWidth(s + '...', size) > w) s = s.slice(0, -1);
            return s + '...';
        }
        function wrap(cv, s, w, size) {
            const out = [];
            let line = '';
            s.split(' ').forEach((word) => {
                const next = line ? line + ' ' + word : word;
                if (line && cv.textWidth(next, size, { font: 'bold' }) > w) { out.push(line); line = word; } else line = next;
            });
            if (line) out.push(line);
            return out;
        }
        function dateOf(ms) {
            const d = new Date(ms + (settings.get('utcOffset') || 0) * 60000), p = (n) => String(n).padStart(2, '0');
            return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '. ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
        }

        function toggleTest() {
            if (test.running) { test.running = false; test.note = 'Stopped.'; } else { test.note = ''; startTest(); }
            return render();
        }
        function setPage(i) {
            page = i;
            if (PAGES[page] === 'faults' && !faults.t && !faultsBusy) readFaults().then(() => render()).catch((e) => log.warn(e));
            return render();
        }

        async function render() {
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            [drawInjectors, drawFuel, drawTest, drawFaults][page](cv, t, d);
            G.frame(cv, t, TABS, page, [usingDemo() && { text: 'DEMO' }, test.running && page !== 2 && { text: 'TEST' }]);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_PAGE', () => setPage((page + 1) % PAGES.length));
        ui.onClick('BTN_TEST', () => { if (page !== 2) page = 2; return toggleTest(); });
        ui.onClick('BTN_FAULTS', () => { page = 3; readFaults().then(() => render()).catch((e) => log.warn(e)); return render(); });
        ctx.onTab((i) => setPage(i));
        if (ctx.hideButton) { ctx.hideButton('BTN_TEST'); ctx.hideButton('BTN_FAULTS'); }
        const shouldPoll = () => link.ready && settings.get('demo') !== 'on' && (ui.isVisible('MAIN') || test.running);
        (async function pollLoop() {
            for (;;) {
                try {
                    if (shouldPoll()) { await pollOnce(); afterSample(); await sleep(40); } else await sleep(300);
                } catch (e) { log.warn('poll: ' + (e && e.message || e)); await sleep(1000); }
            }
        })();
        // demo samples arrive at a steady pace
        setInterval(() => { try { if (usingDemo()) afterSample(); } catch (e) { log.error(e); } }, 150);

        ctx.loop('MAIN', 8, render);
        settings.onChange((k) => { if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page'))); });
        render().catch((e) => log.warn('first render: ' + e));
    },
});

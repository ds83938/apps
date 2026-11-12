'use strict';
/**
 * Signal Scanner: logs every change of the signals in app.json config.watch, with a timestamp,
 * to a JSON Lines file in the app's data folder. Read only: it subscribes (and re-reads, for
 * config.poll), it never sends.
 *
 * Center-screen page:
 *   Mark       puts a MARK line in the log (tap it, then press the button you are testing),
 *              and 6 s later says which signals moved that were QUIET before (NEW), with their
 *              value, and how many busy ones it ignored (counters, CRCs, sensors that always tick)
 *   New log    starts a fresh file
 *   status     interfaces answering, fields, changes logged, interfaces the car doesn't have
 *   recent     the last changes, newest first
 *   catalogue  names matching config.search, or why the signal catalogue could not be read
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, classify } = require('./recorder');

const FLUSH_MS = 5000;
const BEFORE_MS = 500;    // a mark also catches what changed just before it
const AFTER_MS = 6000;    // time to reach the shifter after tapping Mark
const BASE_MS = 20000;    // "was it already busy?" looks this far back
const RECENT = 14;
const MARK_TEXT = 210;    // the page shows about three lines; the log has all of it
const CATALOG = process.env.SCAN_CATALOG || '/etc/oap/someip/someip-interfaces.json';

const short = (v, n) => {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > n ? s.slice(0, n - 3) + '...' : s;
};
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Names in the catalogue matching re, as "a > b > name" (the two levels above the matching key or
 * value give the interface it sits in). Structure-agnostic: walks every key and string value.
 */
function searchCatalogue(root, re) {
    const out = [], seen = Object.create(null);
    const add = (trail, name) => {
        const s = trail.slice(-2).concat(name).join(' > ');
        if (!seen[s] && out.length < 60) { seen[s] = true; out.push(s); }
    };
    const walk = (o, trail, depth) => {
        if (depth > 12 || o === null || typeof o !== 'object') return;
        Object.keys(o).forEach((k) => {
            const v = o[k];
            const label = Array.isArray(o) ? trail : trail.concat(k);
            if (!Array.isArray(o) && re.test(k)) add(trail, k);
            if (typeof v === 'string' && re.test(v) && v.length < 120) add(label, v);
            walk(v, label, depth + 1);
        });
    };
    walk(root, [], 0);
    return out;
}

/** What the app can see at a path, for the "catalogue not found" note: names in a folder, or the error code. */
function look(p) {
    try { return p + ': ' + fs.readdirSync(p).slice(0, 12).join(', '); } catch (e) { return p + ': ' + (e.code || e.message); }
}

/** Copy the catalogue next to the log and list the names matching re; on failure say why and what is visible instead. */
function readCatalogue(dir, re, log) {
    try {
        fs.copyFileSync(CATALOG, path.join(dir, 'someip-interfaces.json'));
        const hits = searchCatalogue(JSON.parse(fs.readFileSync(CATALOG, 'utf8')), re);
        const note = hits.length ? hits.length + ' catalogue names match:\n' + hits.join('\n') : 'Catalogue read, no names match the search';
        fs.writeFileSync(path.join(dir, 'catalogue-matches.txt'), note + '\n');
        log.info(note);
        return note;
    } catch (e) {
        const note = 'Catalogue not readable (' + (e.code || e.message) + ') · ' + look('/etc/oap') + ' · ' + look('/etc/oap/someip');
        log.warn('catalogue: ' + e + ' | ' + note);
        return note;
    }
}

mgu.run({
    start(ctx) {
        const log = ctx.log, ui = ctx.ui, dir = ctx.dataDir;
        const cfg = (ctx.spec && ctx.spec.config) || {};
        let rec, file, marks = 0, markWindows = [], lastMark = '';

        const newRun = () => {
            rec = new Recorder({ maxEntries: 200000 });
            file = path.join(dir, 'scan-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
            marks = 0;
            markWindows = [];
            lastMark = '';
        };
        const flush = () => {
            try { fs.writeFileSync(file, rec.toJsonl()); } catch (e) { log.warn('scan save: ' + e); }
        };

        const found = readCatalogue(dir, new RegExp(cfg.search || 'exhaust', 'i'), log);

        newRun();

        // every field in app.json config.watch, keyed "Interface.field"; "*" = every field the interface has;
        // config.poll[iface] = also re-read that often (fields the car never notifies, like the tyre pressures)
        const watch = cfg.watch || {};
        const poll = cfg.poll || {};
        const subs = [], missing = [];
        let fieldCount = 0, total = 0;
        Object.keys(watch).forEach((iface) => {
            const name = iface.split('.').pop();
            let fields = watch[iface];
            if (fields === '*') {
                try { fields = Object.keys(ctx.signals.loadConfig(iface).fields || {}); }
                catch (e) { log.warn(iface + ' (all fields): ' + e); missing.push(name); total++; return; }
                log.info(iface + ': watching all ' + fields.length + ' fields: ' + fields.join(', '));
            }
            const handlers = {};
            fields.forEach((field) => {
                const key = name + '.' + field;
                handlers[field] = (v) => { rec.push(key, v); };
            });
            total++;
            if (!fields.length) return;
            fieldCount += fields.length;
            ctx.signals.watch(iface, '1', handlers, log, poll[iface] ? { pollMs: poll[iface] } : undefined).then((r) => {
                subs.push(r);
                if (r.error) { missing.push(name); log.warn(iface + ': ' + r.error); }
            });
        });
        if (!total) log.warn('config.watch is empty: nothing to listen to');

        const render = () => {
            const answering = subs.filter((s) => s.available).length;
            const changes = rec.entries.filter((e) => e.key !== 'MARK').length;
            const status = answering + '/' + total + ' interfaces answering · ' + fieldCount + ' fields · ' + changes + ' changes · ' + marks + ' marks'
                + (missing.length ? ' · not on this car: ' + missing.join(', ') : '');
            const recent = rec.entries.slice(-RECENT).reverse()
                .map((e) => (e.t / 1000).toFixed(1) + 's  ' + e.key + ' = ' + short(e.v, 70)).join('\n');
            return Promise.all([
                ui.text('STATUS', status),
                ui.text('FILE', path.basename(file)),
                ui.text('MARKED', lastMark || 'Tap Mark, then press the button you are testing'),
                ui.text('RECENT', recent || 'No changes yet'),
                ui.text('FOUND', found),
            ]);
        };

        /** The page line for one finished mark; everything it leaves out is in the log file. */
        const describe = (n, r) => {
            const fresh = r.fresh.slice(0, 4).map((f) => f.key + ' = ' + short(f.value, 48) + (f.count > 1 ? ' (x' + f.count + ')' : ''));
            let s = 'Mark ' + n + ': ' + (fresh.length ? 'NEW ' + fresh.join(' ; ') + (r.fresh.length > 4 ? ' +' + (r.fresh.length - 4) + ' more' : '') : 'nothing new');
            if (r.busy.length) s += ' · ' + r.busy.length + ' busy ignored';
            if (r.baselineMs < BASE_MS) s += ' · only ' + Math.round(r.baselineMs / 1000) + ' s of history';
            return cut(s, MARK_TEXT);
        };

        ui.onClick('BTN_MARK', () => {
            marks++;
            const n = marks;
            const t = Date.now() - rec.started;
            rec.push('MARK', n);
            lastMark = 'Mark ' + n + ': listening for 6 s, press the button now';
            flush();
            render();
            const skip = markWindows.slice();            // earlier marks: their presses are not "busy history"
            markWindows.push([t - BEFORE_MS, t + AFTER_MS]);
            setTimeout(() => {
                const r = classify(rec.entries, t, { before: BEFORE_MS, after: AFTER_MS, baseMs: BASE_MS, ignore: cfg.quietInMark || [], skip });
                lastMark = describe(n, r);
                log.info(lastMark);
                log.info('mark ' + n + ' full: NEW ' + JSON.stringify(r.fresh) + ' BUSY ' + r.busy.map((b) => b.key + ' x' + b.count).join(', '));
                render();
            }, AFTER_MS + 100);
        });
        ui.onClick('BTN_NEW', () => { flush(); newRun(); return render(); });

        const flushTimer = setInterval(flush, FLUSH_MS);
        const uiTimer = setInterval(() => { if (ui.isVisible('MAIN')) render(); }, 1000);
        process.on('exit', () => { clearInterval(flushTimer); clearInterval(uiTimer); flush(); });
        render();
    },
});

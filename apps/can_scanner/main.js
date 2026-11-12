'use strict';
/**
 * Signal Scanner: logs every change of the signals in app.json config.watch, with a timestamp,
 * to a JSON Lines file in the app's data folder. Read only: it subscribes, it never sends.
 *
 * Center-screen page:
 *   Mark       puts a MARK line in the log (tap it, then press the button you are testing),
 *              and 6 s later shows which signals changed from 0.5 s before to 6 s after it
 *   New log    starts a fresh file
 *   status     signals answering, changes logged, file name
 *   recent     the last changes, newest first
 *
 * On start it also copies the head unit's signal catalogue
 * (/etc/oap/someip/someip-interfaces.json) into data/, so we can pick more signals to watch.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, summarise } = require('./recorder');

const FLUSH_MS = 5000;
const BEFORE_MS = 500;    // a mark also catches what changed just before it
const AFTER_MS = 6000;    // time to reach the shifter after tapping Mark
const RECENT = 14;
const CATALOG = process.env.SCAN_CATALOG || '/etc/oap/someip/someip-interfaces.json';

const short = (v) => {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
};

/**
 * Names in the catalogue matching re, as "a.b.name" (the two levels above the matching key or
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

mgu.run({
    start(ctx) {
        const log = ctx.log, ui = ctx.ui, dir = ctx.dataDir;
        let rec, file, marks = 0, answering = 0, total = 0, lastMark = '';

        const newRun = () => {
            rec = new Recorder({ maxEntries: 200000 });
            file = path.join(dir, 'scan-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
            marks = 0;
            lastMark = '';
        };
        const flush = () => {
            try { fs.writeFileSync(file, rec.toJsonl()); } catch (e) { log.warn('scan save: ' + e); }
        };

        // the catalogue, once: a read-only copy, and the names in it that match config.search
        let found = 'Catalogue not found';
        try {
            fs.copyFileSync(CATALOG, path.join(dir, 'someip-interfaces.json'));
            const hits = searchCatalogue(JSON.parse(fs.readFileSync(CATALOG, 'utf8')), new RegExp(((ctx.spec || {}).config || {}).search || 'exhaust', 'i'));
            found = hits.length ? hits.length + ' catalogue names match:\n' + hits.join('\n') : 'No catalogue names match the search';
            fs.writeFileSync(path.join(dir, 'catalogue-matches.txt'), found + '\n');
            log.info(found);
        } catch (e) { log.warn('catalogue: ' + e); }

        newRun();

        // every field in app.json config.watch, keyed "Interface.field"; "*" = every field the interface has
        const cfg = (ctx.spec && ctx.spec.config) || {};
        const watch = cfg.watch || {};
        const quiet = cfg.quietInMark || [];
        let fieldCount = 0;
        Object.keys(watch).forEach((iface) => {
            let fields = watch[iface];
            if (fields === '*') {
                try { fields = Object.keys(ctx.signals.loadConfig(iface).fields || {}); }
                catch (e) { log.warn(iface + ' (all fields): ' + e); return; }
                log.info(iface + ': watching all ' + fields.length + ' fields: ' + fields.join(', '));
            }
            const handlers = {};
            fields.forEach((field) => {
                const key = iface.split('.').pop() + '.' + field;
                handlers[field] = (v) => { rec.push(key, v); };
            });
            if (!fields.length) return;
            total++;
            fieldCount += fields.length;
            ctx.signals.watch(iface, '1', handlers, log).then((r) => {
                if (r.available) answering++;
                else if (r.error) log.warn(iface + ': ' + r.error);
            });
        });
        if (!total) log.warn('config.watch is empty: nothing to listen to');

        const render = () => {
            const changes = rec.entries.filter((e) => e.key !== 'MARK').length;
            const status = answering + '/' + total + ' interfaces answering · ' + fieldCount + ' fields · ' + changes + ' changes · ' + marks + ' marks';
            const recent = rec.entries.slice(-RECENT).reverse()
                .map((e) => (e.t / 1000).toFixed(1) + 's  ' + e.key + ' = ' + short(e.v)).join('\n');
            return Promise.all([
                ui.text('STATUS', status),
                ui.text('FILE', path.basename(file)),
                ui.text('MARKED', lastMark || 'Press Mark, then the button you are testing'),
                ui.text('RECENT', recent || 'No changes yet'),
                ui.text('FOUND', found),
            ]);
        };

        ui.onClick('BTN_MARK', () => {
            marks++;
            const n = marks;
            const t = Date.now() - rec.started;
            rec.push('MARK', n);
            lastMark = 'Mark ' + n + ': listening for 6 s, press the button now';
            flush();
            render();
            setTimeout(() => {
                const hits = summarise(rec.around(t, BEFORE_MS, AFTER_MS).filter((e) => e.key !== 'MARK' && quiet.indexOf(e.key) < 0));
                const names = Object.keys(hits);
                lastMark = 'Mark ' + n + ': ' + (names.length ? names.map((k) => k + ' x' + hits[k]).join(', ') : 'nothing changed');
                log.info(lastMark);
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

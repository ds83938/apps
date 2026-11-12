'use strict';
/**
 * Signal Scanner: logs every change of the signals in app.json config.watch, with a timestamp,
 * to a JSON Lines file in the app's data folder. Read only: it subscribes, it never sends.
 *
 * Center-screen page:
 *   Mark       puts a MARK line in the log (press it, then press the button you are testing),
 *              and 1.5 s later shows which signals changed within 1.5 s either side of it
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
const WINDOW_MS = 1500;
const RECENT = 14;
const CATALOG = '/etc/oap/someip/someip-interfaces.json';

const short = (v) => {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
};

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

        // the catalogue, once: read-only copy for the next round of signals
        try {
            fs.copyFileSync(CATALOG, path.join(dir, 'someip-interfaces.json'));
            log.info('copied the signal catalogue to data/someip-interfaces.json');
        } catch (e) { log.warn('catalogue copy: ' + e); }

        newRun();

        // every field in app.json config.watch, keyed "Interface.field"
        const watch = (ctx.spec && ctx.spec.config && ctx.spec.config.watch) || {};
        Object.keys(watch).forEach((iface) => {
            const handlers = {};
            watch[iface].forEach((field) => {
                const key = iface.split('.').pop() + '.' + field;
                handlers[field] = (v) => { rec.push(key, v); };
            });
            if (!watch[iface].length) return;
            total++;
            ctx.signals.watch(iface, '1', handlers, log).then((r) => {
                if (r.available) answering++;
                else if (r.error) log.warn(iface + ': ' + r.error);
            });
        });
        if (!total) log.warn('config.watch is empty: nothing to listen to');

        const render = () => {
            const status = answering + '/' + total + ' interfaces answering · ' + rec.entries.length + ' changes · ' + marks + ' marks';
            const recent = rec.entries.slice(-RECENT).reverse()
                .map((e) => (e.t / 1000).toFixed(1) + 's  ' + e.key + ' = ' + short(e.v)).join('\n');
            return Promise.all([
                ui.text('STATUS', status),
                ui.text('FILE', path.basename(file)),
                ui.text('MARKED', lastMark || 'Press Mark, then the button you are testing'),
                ui.text('RECENT', recent || 'No changes yet'),
            ]);
        };

        ui.onClick('BTN_MARK', () => {
            marks++;
            const n = marks;
            const t = Date.now() - rec.started;
            rec.push('MARK', n);
            flush();
            render();
            setTimeout(() => {
                const hits = summarise(rec.around(t, WINDOW_MS, WINDOW_MS).filter((e) => e.key !== 'MARK'));
                const names = Object.keys(hits);
                lastMark = 'Mark ' + n + ': ' + (names.length ? names.map((k) => k + ' x' + hits[k]).join(', ') : 'nothing changed');
                log.info(lastMark);
                render();
            }, WINDOW_MS + 100);
        });
        ui.onClick('BTN_NEW', () => { flush(); newRun(); return render(); });

        const flushTimer = setInterval(flush, FLUSH_MS);
        const uiTimer = setInterval(() => { if (ui.isVisible('MAIN')) render(); }, 1000);
        process.on('exit', () => { clearInterval(flushTimer); clearInterval(uiTimer); flush(); });
        render();
    },
});

'use strict';
/**
 * recorder.js - turns raw signal callbacks into a timestamped change log.
 *
 * Pure logic, no SOME/IP, so it runs on the Mac (see test/recorder.test.js).
 * Only records a value when it differs from the last one seen for that signal,
 * so a steady signal costs nothing. Values are stored as JSON-safe numbers,
 * strings, booleans, or a JSON copy of objects.
 */
class Recorder {
    /**
     * @param {object} opts
     * @param {number} [opts.maxEntries=50000] cap; oldest entries drop first
     * @param {() => number} [opts.now=Date.now]
     */
    constructor(opts) {
        this.maxEntries = (opts && opts.maxEntries) || 50000;
        this.now = (opts && opts.now) || Date.now;
        this.entries = [];
        this.last = new Map();   // key -> last serialised value
        this.started = this.now();
        this.dropped = 0;
    }

    /** Record one callback. Returns true when it was a change. */
    push(key, value) {
        const s = JSON.stringify(value === undefined ? null : value);
        if (this.last.has(key) && this.last.get(key) === s) return false;
        this.last.set(key, s);
        const t = this.now() - this.started;
        this.entries.push({ t, key, v: JSON.parse(s) });
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
            this.dropped++;
        }
        return true;
    }

    /** Lines in JSON Lines format, one entry per line. */
    toJsonl() {
        const head = { meta: true, started: this.started, dropped: this.dropped };
        return [JSON.stringify(head)].concat(this.entries.map((e) => JSON.stringify(e))).join('\n') + '\n';
    }

    /**
     * Changes in a window around a moment, for "I pressed this button at T".
     * t is in ms since the recorder started; before/after in ms.
     */
    around(t, before, after) {
        return this.entries.filter((e) => e.t >= t - before && e.t <= t + after);
    }
}

/** Keys that changed inside the window, with how many times each changed. */
function summarise(entries) {
    const counts = {};
    for (const e of entries) counts[e.key] = (counts[e.key] || 0) + 1;
    return counts;
}

/**
 * Splits what changed around a mark into NEW and BUSY.
 *
 *   t           the mark's time (ms since the recorder started)
 *   o.before    window starts this long before t,   o.after  and ends this long after it
 *   o.baseMs    how far back before the window to look for "was it already busy"
 *   o.maxBase   a signal that changed more than this many times in the baseline is BUSY (default 1)
 *   o.ignore    keys that are always BUSY
 *   o.skip      [[from, to], ...] earlier mark windows: changes inside them don't count as baseline
 *               (the button you pressed 15 s ago must not make itself look busy)
 *
 * Returns { fresh: [{key, count, value}], busy: [{key, count}], baselineMs } where baselineMs is how
 * much history there really was (a mark right after start has less than baseMs).
 */
function classify(entries, t, o) {
    const before = o.before, after = o.after, baseMs = o.baseMs;
    const maxBase = o.maxBase === undefined ? 1 : o.maxBase;
    const ignore = o.ignore || [], skip = o.skip || [];
    const winStart = t - before, baseStart = winStart - baseMs;
    const win = {}, base = {};
    for (const e of entries) {
        if (e.key === 'MARK') continue;
        if (e.t >= winStart && e.t <= t + after) {
            (win[e.key] = win[e.key] || []).push(e);
        } else if (e.t >= baseStart && e.t < winStart && !skip.some((w) => e.t >= w[0] && e.t <= w[1])) {
            base[e.key] = (base[e.key] || 0) + 1;
        }
    }
    const fresh = [], busy = [];
    Object.keys(win).forEach((k) => {
        const list = win[k];
        if (ignore.indexOf(k) < 0 && (base[k] || 0) <= maxBase) fresh.push({ key: k, count: list.length, value: list[list.length - 1].v });
        else busy.push({ key: k, count: list.length });
    });
    return { fresh, busy, baselineMs: Math.max(0, Math.min(baseMs, winStart)) };
}

module.exports = { Recorder, summarise, classify };

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

module.exports = { Recorder, summarise };

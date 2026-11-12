'use strict';
/**
 * inj_analysis.js - which cylinder stands out from the others. Pure functions, no car.
 *
 * Each cylinder is compared with the MEDIAN OF THE OTHER FIVE, so one bad cylinder can't hide itself
 * by pulling the reference. The limits are this app's starting points, not BMW's: a flag means
 * "differs from the other cylinders", not "faulty". Confirm with a swap test (see README).
 */
const isNum = (x) => typeof x === 'number' && isFinite(x);

function median(a) {
    const s = a.filter(isNum).slice().sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * How far each value is from the median of the others.
 * lim = { warn, crit }: absolute differences (in the value's own unit) for 'warn' / 'crit'.
 * Returns [{ v, ref, dev, level: 'ok'|'warn'|'crit'|null }] (null: no value).
 */
function compare(values, lim) {
    return values.map((v, i) => {
        if (!isNum(v)) return { v: null, ref: null, dev: null, level: null };
        const ref = median(values.filter((x, j) => j !== i));
        if (!isNum(ref)) return { v, ref: null, dev: null, level: null };
        const dev = v - ref, a = Math.abs(dev);
        return { v, ref, dev, level: a >= lim.crit ? 'crit' : a >= lim.warn ? 'warn' : 'ok' };
    });
}

/** Injector flow correction factors (1.000 = none) -> percent (+ = the DME adds fuel to that cylinder). */
const pct = (f) => (isNum(f) ? (f - 1) * 100 : null);

/** The limits, per quantity (see README "How it judges"). */
const LIMITS = {
    inj: { warn: 4, crit: 8 },          // injector correction, percentage points from the others
    rough: { warn: 1.5, crit: 3 },      // rough running, rad/s² from the others (idle, warm)
    ign: { warn: 3, crit: 6 },          // ignition angle, °CA from the others
};

/**
 * Misfire counters: a cylinder with misfires while the others have (almost) none.
 * Returns levels per cylinder.
 */
function misfires(counts) {
    const total = counts.filter(isNum).reduce((a, b) => a + b, 0);
    return counts.map((c) => {
        if (!isNum(c)) return null;
        if (c === 0) return 'ok';
        return c >= 5 && c >= total * 0.5 ? 'crit' : 'warn';
    });
}

/**
 * Put it together for one set of per-cylinder readings: { inj: [factor x6], rough: [x6], misfire: [x6], ign: [x6] }.
 * Returns { inj, rough, ign, misfire, suspects: [{ cyl, level, why: [text] }] } sorted worst first.
 */
function judge(cyl) {
    const injPct = (cyl.inj || []).map(pct);
    const out = {
        inj: compare(injPct, LIMITS.inj),
        rough: compare(cyl.rough || [], LIMITS.rough),
        ign: compare(cyl.ign || [], LIMITS.ign),
        misfire: misfires(cyl.misfire || []),
    };
    const rank = { crit: 2, warn: 1 };
    const sus = [];
    for (let i = 0; i < 6; i++) {
        const why = [];
        let lv = 0;
        const add = (level, text) => { if (rank[level]) { why.push(text); lv = Math.max(lv, rank[level]); } };
        const r = out.inj[i];
        if (r && r.level) add(r.level, 'injector ' + sign(r.dev, 1) + ' % vs others' + (r.dev > 0 ? ' (DME adds fuel: lean / under-flowing)' : ' (DME takes fuel away: rich / over-flowing or dripping)'));
        const q = out.rough[i];
        if (q && q.level) add(q.level, 'rough running ' + sign(q.dev, 1) + ' rad/s² vs others');
        const m = out.misfire[i];
        if (m) add(m, (cyl.misfire[i]) + ' misfire' + (cyl.misfire[i] === 1 ? '' : 's'));
        const g = out.ign[i];
        if (g && g.level) add(g.level, 'ignition ' + sign(g.dev, 1) + ' °CA vs others');
        if (lv) sus.push({ cyl: i + 1, level: lv === 2 ? 'crit' : 'warn', score: lv * 10 + why.length, why });
    }
    sus.sort((a, b) => b.score - a.score);
    out.suspects = sus;
    return out;
}

const sign = (x, d) => (x >= 0 ? '+' : '') + x.toFixed(d);

/** Running statistics for the idle test: add(values x6) per sample, then result(). */
class Stats {
    constructor() { this.n = []; this.sum = []; this.sq = []; this.min = []; this.max = []; }
    add(vals) {
        vals.forEach((v, i) => {
            if (!isNum(v)) return;
            this.n[i] = (this.n[i] || 0) + 1;
            this.sum[i] = (this.sum[i] || 0) + v;
            this.sq[i] = (this.sq[i] || 0) + v * v;
            this.min[i] = isNum(this.min[i]) ? Math.min(this.min[i], v) : v;
            this.max[i] = isNum(this.max[i]) ? Math.max(this.max[i], v) : v;
        });
    }
    mean(i) { return this.n[i] ? this.sum[i] / this.n[i] : null; }
    sd(i) {
        if (!(this.n[i] > 1)) return null;
        const m = this.mean(i);
        return Math.sqrt(Math.max(0, this.sq[i] / this.n[i] - m * m));
    }
    means() { return [0, 1, 2, 3, 4, 5].map((i) => this.mean(i)); }
}

module.exports = { median, compare, pct, judge, misfires, LIMITS, Stats, isNum, sign };

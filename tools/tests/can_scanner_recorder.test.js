'use strict';
// Run: node tools/tests/can_scanner_recorder.test.js   (no car, no dependencies)
const assert = require('assert');
const { Recorder, summarise, classify } = require('../../apps/can_scanner/recorder');

let clock = 0;
const r = new Recorder({ now: () => clock, maxEntries: 5 });

clock = 0;   assert.strictEqual(r.push('a', 1), true);   // first value always recorded
clock = 10;  assert.strictEqual(r.push('a', 1), false);  // unchanged: skipped
clock = 20;  assert.strictEqual(r.push('a', 2), true);   // change recorded
clock = 30;  assert.strictEqual(r.push('b', { x: 1 }), true);
clock = 40;  assert.strictEqual(r.push('b', { x: 1 }), false);

assert.deepStrictEqual(r.entries.map((e) => [e.t, e.key, e.v]), [
    [0, 'a', 1], [20, 'a', 2], [30, 'b', { x: 1 }],
]);

// around(): window in ms, inclusive
assert.deepStrictEqual(summarise(r.around(20, 5, 5)), { a: 1 });
assert.deepStrictEqual(summarise(r.around(20, 15, 15)), { a: 1, b: 1 });

// cap: oldest drop first, counted
for (let i = 0; i < 10; i++) { clock = 100 + i; r.push('c', i); }
assert.strictEqual(r.entries.length, 5);
assert.strictEqual(r.entries[4].v, 9);
assert.ok(r.dropped > 0);

// jsonl: header plus one line per entry, each parseable
const lines = r.toJsonl().trim().split('\n').map((l) => JSON.parse(l));
assert.strictEqual(lines[0].meta, true);
assert.strictEqual(lines.length, r.entries.length + 1);

// classify(): a chattering signal is BUSY, a signal that was quiet and then moved is NEW
{
    const es = [];
    // "crc" ticks every 500 ms for 40 s; "temp" about once a second; "btn" is quiet until the press
    for (let ms = 0; ms <= 40000; ms += 500) es.push({ t: ms, key: 'crc', v: ms });
    for (let ms = 0; ms <= 40000; ms += 1000) es.push({ t: ms, key: 'temp', v: 90 });
    es.push({ t: 30500, key: 'btn', v: 'PRESSED' }, { t: 30600, key: 'btn', v: 'RELEASED' });
    es.push({ t: 30000, key: 'MARK', v: 1 });
    es.sort((a, b) => a.t - b.t);
    const o = { before: 500, after: 6000, baseMs: 20000 };

    let r = classify(es, 30000, o);
    assert.deepStrictEqual(r.fresh.map((f) => f.key), ['btn']);
    assert.strictEqual(r.fresh[0].count, 2);
    assert.strictEqual(r.fresh[0].value, 'RELEASED');            // the last value in the window
    assert.deepStrictEqual(r.busy.map((b) => b.key).sort(), ['crc', 'temp']);
    assert.strictEqual(r.baselineMs, 20000);

    // ignore list forces BUSY even for a quiet signal
    r = classify(es, 30000, Object.assign({ ignore: ['btn'] }, o));
    assert.deepStrictEqual(r.fresh, []);

    // a mark right after start: only 8 s of history, and it says so
    r = classify(es, 8500, o);
    assert.strictEqual(r.baselineMs, 8000);

    // the button pressed 15 s earlier (previous mark window) must not make it look busy now
    const again = es.concat([{ t: 14500, key: 'btn', v: 'PRESSED' }, { t: 14600, key: 'btn', v: 'RELEASED' },
        { t: 15500, key: 'btn', v: 'X' }, { t: 16000, key: 'btn', v: 'Y' }]).sort((a, b) => a.t - b.t);
    r = classify(again, 30000, Object.assign({ skip: [[14000, 20500]] }, o));
    assert.deepStrictEqual(r.fresh.map((f) => f.key), ['btn']);
    r = classify(again, 30000, o);
    assert.deepStrictEqual(r.fresh.map((f) => f.key), []);       // without skip the earlier press makes it look busy
    assert.ok(r.busy.some((b) => b.key === 'btn'));
}

console.log('recorder: all checks passed');

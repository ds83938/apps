'use strict';
// Run: node tools/tests/can_scanner_recorder.test.js   (no car, no dependencies)
const assert = require('assert');
const { Recorder, summarise } = require('../../apps/can_scanner/recorder');

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

console.log('recorder: all checks passed');

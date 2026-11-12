'use strict';
/**
 * inj_demo.js - made-up readings for the emulator / bench and for a car that doesn't answer yet (DEMO badge).
 * A warm idle with cylinder 4 slightly off, so the page shows what a flag looks like.
 */
class Demo {
    constructor() { this.t0 = Date.now(); this.mis = [0, 0, 0, 2, 0, 0]; }
    sample() {
        const t = (Date.now() - this.t0) / 1000, n = (a) => (Math.random() - 0.5) * a;
        if (Math.random() < 0.01) this.mis[3]++;
        const rail = 350 + 4 * Math.sin(t / 2) + n(6);
        return {
            values: {
                rpm: 650 + n(20), coolant: 91 + n(0.2), load: 17 + n(1),
                injMean: 1.012, mixMul: 1.031 + n(0.002),
                rail, railTarget: 350, lpfp: 5.05 + n(0.08),
                lambda: 1.0 + n(0.02), lambdaTarget: 1.0,
                fuelTemp: 34, fuelFlow: 1.1 + n(0.05), fuelQuality: 0.02, ethanol: 0, knock: 0,
            },
            cyl: {
                inj: [1.004, 0.998, 1.009, 1.071, 1.001, 0.995].map((f) => f + n(0.002)),
                rough: [0.4, -0.3, 0.6, 2.6, -0.1, 0.2].map((v) => v + n(0.5)),
                misfire: this.mis.slice(),
                ign: [4.5, 4.2, 4.8, 3.9, 4.4, 4.6].map((v) => v + n(0.3)),
            },
        };
    }
}

module.exports = Demo;

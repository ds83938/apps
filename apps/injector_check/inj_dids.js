'use strict';
/**
 * inj_dids.js - what Injector Check reads from the engine unit (DME, diagnostic address 0x12) and how.
 *
 * Identifiers and scaling: the DME8FF_R SGBD (B58 / B48 / B38 engines, G series), as published in the
 * EdiabasX SGBD reference and in cauliflowermossgrape/idrive7-apps' Live Data built-in catalog (MIT).
 * Every one is read with UDS 22 ReadDataByIdentifier, one value at offset 0 after the identifier.
 *
 *   DID[hex] = { t: 'u8'|'s8'|'u16'|'s16', k: factor, o: offset }    value = raw * k + o
 *
 * A value lists candidates (VALUES[key] = [did, ...]): the first one the car answers wins.
 * Plain Node 8 (the car's 8.16.2).
 */
const DID = {
    // engine
    4807: { t: 's16', k: 0.5, name: 'Engine speed', u: 'rpm' },
    4300: { t: 's16', k: 0.1, o: -273.14, name: 'Coolant', u: '°C' },
    5805: { t: 's16', k: 0.1, o: -273.14, name: 'Engine temperature', u: '°C' },
    5813: { t: 'u8', k: 0.75, name: 'Relative air charge', u: '%' },
    // per cylinder: injector flow correction (limited), factor around 1.000
    '55B4': { t: 'u16', k: 3.052e-05 }, '55B5': { t: 'u16', k: 3.052e-05 }, '55B6': { t: 'u16', k: 3.052e-05 },
    '55B7': { t: 'u16', k: 3.052e-05 }, '55B8': { t: 'u16', k: 3.052e-05 }, '55B9': { t: 'u16', k: 3.052e-05 },
    // per cylinder: rough running (Laufunruhe), rad/s²
    '4A30': { t: 's16', k: 0.0625 }, '4A31': { t: 's16', k: 0.0625 }, '4A32': { t: 's16', k: 0.0625 },
    '4A33': { t: 's16', k: 0.0625 }, '4A34': { t: 's16', k: 0.0625 }, '4A35': { t: 's16', k: 0.0625 },
    // per cylinder: misfire counter
    '4B23': { t: 'u16', k: 1 }, '4B24': { t: 'u16', k: 1 }, '4B25': { t: 'u16', k: 1 },
    '4B30': { t: 'u16', k: 1 }, '4B31': { t: 'u16', k: 1 }, '4B32': { t: 'u16', k: 1 },
    // per cylinder: ignition angle, °CA
    '4A49': { t: 's16', k: 0.1 }, '4A4A': { t: 's16', k: 0.1 }, '4A4C': { t: 's16', k: 0.1 },
    '4A4D': { t: 's16', k: 0.1 }, '4A4E': { t: 's16', k: 0.1 }, '4A4F': { t: 's16', k: 0.1 },
    // fuel system
    '546E': { t: 'u16', k: 3.052e-05, name: 'Injector flow adaptation, mean' },
    '4A9D': { t: 'u16', k: 3.0517578e-05, name: 'Mixture adaptation (multiplicative)' },
    '58EF': { t: 'u16', k: 0.005, name: 'Rail pressure', u: 'bar' },            // 0.0005 MPa
    5658: { t: 'u16', k: 0.02, name: 'Rail pressure', u: 'bar' },               // 0.002 MPa
    5837: { t: 'u16', k: 0.005, name: 'Rail pressure target', u: 'bar' },
    '56C1': { t: 'u16', k: 0.02, name: 'Rail pressure target', u: 'bar' },
    5463: { t: 's16', k: 0.001, name: 'Low pressure fuel (sensor raw)', u: 'bar' },  // hPa
    5889: { t: 'u16', k: 0.000244140625, name: 'Lambda actual' },
    5640: { t: 'u16', k: 0.00024414, name: 'Lambda actual (sensor)' },
    5816: { t: 'u16', k: 0.000244140625, name: 'Lambda target' },
    '4AD5': { t: 'u8', k: 0.75, o: -48, name: 'Fuel temperature', u: '°C' },
    5656: { t: 'u16', k: 0.00119209 * 3.6, name: 'Fuel flow', u: 'l/h' },       // ml/s -> l/h
    5776: { t: 'u8', k: 0.00390625, name: 'Fuel quality factor' },              // 0 = RON 98, 1 = RON 91
    '550D': { t: 'u8', k: 0.39215686, name: 'Ethanol', u: '%' },
    '554C': { t: 's8', k: 0.375, name: 'Knock retard, mean of all cylinders', u: '°CA' },
};
Object.keys(DID).forEach((k) => { DID[k].did = parseInt(k, 16); DID[k].hex = k; });

const SIZE = { u8: 1, s8: 1, u16: 2, s16: 2 };

/** B58 firing order, shown on the page. */
const FIRING = [1, 5, 3, 6, 2, 4];

const CYL = {
    inj: ['55B4', '55B5', '55B6', '55B7', '55B8', '55B9'],
    rough: ['4A30', '4A31', '4A32', '4A33', '4A34', '4A35'],
    misfire: ['4B23', '4B24', '4B25', '4B30', '4B31', '4B32'],
    ign: ['4A49', '4A4A', '4A4C', '4A4D', '4A4E', '4A4F'],
};

/** Single values: candidates, best first. */
const VALUES = {
    rpm: ['4807'], coolant: ['4300', '5805'], load: ['5813'],
    injMean: ['546E'], mixMul: ['4A9D'],
    rail: ['58EF', '5658'], railTarget: ['5837', '56C1'], lpfp: ['5463'],
    lambda: ['5889', '5640'], lambdaTarget: ['5816'],
    fuelTemp: ['4AD5'], fuelFlow: ['5656'], fuelQuality: ['5776'], ethanol: ['550D'], knock: ['554C'],
};

/** What each page reads (keys of VALUES, and the per-cylinder groups). */
const PAGE_READS = {
    injectors: { values: ['rpm', 'coolant', 'injMean', 'mixMul'], cyl: ['inj', 'rough', 'misfire', 'ign'] },
    fuel: { values: ['rpm', 'coolant', 'load', 'rail', 'railTarget', 'lpfp', 'lambda', 'lambdaTarget', 'mixMul', 'injMean', 'fuelTemp', 'fuelFlow', 'fuelQuality', 'ethanol', 'knock'], cyl: [] },
    test: { values: ['rpm', 'coolant', 'injMean', 'mixMul'], cyl: ['inj', 'rough', 'misfire'] },
    faults: { values: ['rpm'], cyl: [] },
};

/** The identifiers a page needs, given which candidates turned out to be missing on this car. */
function didsFor(page, missing) {
    const r = PAGE_READS[page] || PAGE_READS.injectors, out = [];
    const add = (h) => { if (out.indexOf(h) < 0) out.push(h); };
    r.values.forEach((k) => {
        const c = VALUES[k].filter((h) => !missing[h]);
        if (c.length) add(c[0]);           // the best candidate that isn't known missing
    });
    r.cyl.forEach((g) => CYL[g].forEach((h) => { if (!missing[h]) add(h); }));
    return out;
}

/** One identifier's value from its data bytes (after 62 <DID>); null when too short. */
function decode(hexId, data) {
    const d = DID[hexId];
    if (!d || data.length < SIZE[d.t]) return null;
    const n = SIZE[d.t];
    let raw = 0;
    for (let i = 0; i < n; i++) raw = raw * 256 + data[i];
    if (d.t[0] === 's' && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
    return raw * d.k + (d.o || 0);
}

/**
 * Take apart a reply to several identifiers: 62 <DID> <data> <DID> <data> ... (each DID's data length
 * is fixed by its type). Returns { hex: value } or null when it doesn't add up.
 */
function splitReply(uds) {
    if (!uds || uds[0] !== 0x62) return null;
    const out = {};
    let i = 1;
    while (i + 2 <= uds.length) {
        const did = (uds[i] << 8) | uds[i + 1], h = did.toString(16).toUpperCase().padStart(4, '0'), d = DID[h];
        if (!d) return null;
        const n = SIZE[d.t];
        if (i + 2 + n > uds.length) return null;
        out[h] = decode(h, uds.slice(i + 2, i + 2 + n));
        i += 2 + n;
    }
    return i === uds.length ? out : null;
}

module.exports = { DID, SIZE, CYL, VALUES, PAGE_READS, FIRING, didsFor, decode, splitReply };

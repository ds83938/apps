'use strict';
/**
 * ui.js - the RWD Mode screen drawn as BMW's own SETUP menu:
 *
 *   [icon] Engine      EFFICIENT   SPORT        SPORT PLUS
 *   [icon] Chassis     COMFORT     SPORT        SPORT PLUS
 *   [icon] Steering    COMFORT     SPORT
 *   [icon] Brake       COMFORT     SPORT
 *   [icon] M xDrive    4WD         4WD SPORT    2WD          <- the focused row: red line under the label
 *                                                              and the active option, grey under the others
 * The active option of each row is red. Engine / Chassis / Steering / Brake mirror the driving mode
 * the car reports (read only). 4WD SPORT is greyed out: it needs a transfer-case flash, not offered.
 * Pure drawing: draw(cv, G, t, v, press, note) with v = RwdMode.view() + v.drive (driving mode).
 */
const { withAlpha } = require('./kit/canvas');

const W = 1600, H = 520;
const RED = '#e8262b';
const WHITE = '#ffffff';
const GREY_TEXT = withAlpha('#ffffff', 0.2);       // an option that can't be picked (4WD SPORT)
const GREY_LINE = withAlpha('#ffffff', 0.32);
const ICON_X = 96, LABEL_X = 150, LABEL_END = 600;
const COL_X = [646, 976, 1306], COL_W = 300;
const ROW_H = 74;

/* ---------- line icons (white, 3 px, ~36 px box centred on cx, cy) ---------- */
const rad = (d) => d * Math.PI / 180;
const pt = (cx, cy, r, a) => [cx + Math.sin(rad(a)) * r, cy - Math.cos(rad(a)) * r];

function iconEngine(cv, cx, cy) {                  // a dial with its needle
    cv.arc(cx, cy + 3, 13, 16, -125, 125, WHITE, { round: true });
    for (let a = -90; a <= 90; a += 45) { const [x0, y0] = pt(cx, cy + 3, 8, a), [x1, y1] = pt(cx, cy + 3, 11, a); cv.line(x0, y0, x1, y1, 2, WHITE); }
    const [nx, ny] = pt(cx, cy + 3, 11, 40);
    cv.line(cx, cy + 3, nx, ny, 3, WHITE);
    cv.circle(cx, cy + 3, 3, WHITE);
}

function iconChassis(cv, cx, cy) {                 // a damper with its spring, slanted like BMW's
    const ang = rad(-28), c = Math.cos(ang), sn = Math.sin(ang);
    const k = (u, v) => [cx + u * c - v * sn, cy + u * sn + v * c];    // u across, v along the damper
    cv.line(...k(0, -19), ...k(0, -13), 3, WHITE);
    cv.line(...k(-6, -13), ...k(6, -13), 3, WHITE);                  // top spring seat
    const zig = [];
    for (let i = 0; i <= 5; i++) zig.push(k(i % 2 ? 6 : -6, -13 + i * 3.6));
    cv.polyline(zig, 2.5, WHITE);
    cv.line(...k(-6, 5), ...k(6, 5), 3, WHITE);                      // lower seat
    cv.line(...k(0, 5), ...k(0, 14), 8, WHITE);                      // the damper body
    cv.line(...k(0, 14), ...k(0, 19), 3, WHITE);
}

function iconSteering(cv, cx, cy) {                // a three-spoke wheel
    cv.arc(cx, cy, 14, 17, 0, 360, WHITE);
    cv.circle(cx, cy + 2, 4.5, WHITE);
    cv.line(cx - 15, cy - 1, cx - 4, cy + 1, 3, WHITE);
    cv.line(cx + 15, cy - 1, cx + 4, cy + 1, 3, WHITE);
    cv.line(cx, cy + 6, cx, cy + 15, 3, WHITE);
}

function iconBrake(cv, cx, cy) {                   // a disc with its caliper
    cv.arc(cx, cy, 13, 16, 0, 360, WHITE);
    cv.arc(cx, cy, 4, 6.5, 0, 360, WHITE);
    for (let a = 0; a < 360; a += 72) { const [x, y] = pt(cx, cy, 9.5, a); cv.circle(x, y, 1.6, WHITE); }
    cv.arc(cx, cy, 17, 22, 20, 100, WHITE, { round: true });
}

function iconXDrive(cv, cx, cy) {                  // both axles and the shaft between them
    [cy - 11, cy + 11].forEach((y) => {
        cv.line(cx - 12, y, cx + 12, y, 3, WHITE);
        cv.roundRect(cx - 18, y - 6, 6, 12, 2, WHITE);
        cv.roundRect(cx + 12, y - 6, 6, 12, 2, WHITE);
    });
    cv.line(cx, cy - 11, cx, cy + 11, 3, WHITE);
}

/* ---------- rows ---------- */

/** One row. opts: [{ text, state: 'on'|'free'|'off', run, key, confirm }], focus: draw the row's lines. */
function row(cv, y, icon, label, opts, focus) {
    icon(cv, ICON_X, y - 10);
    cv.text(label, LABEL_X, y, 34, WHITE, { font: 'label' });
    const lineY = y + 22;
    if (focus) {
        cv.fillRect(52, lineY, LABEL_END - 52, 3, RED);
        cv.text('<', 22, y - 1, 30, RED, { font: 'label' });
    }
    opts.forEach((o, i) => {
        if (!o) return;
        const x = COL_X[i];
        if (o.confirm) cv.fillRect(x - 12, y - 36, COL_W - 26, lineY - y + 36, withAlpha(RED, 0.18));
        const col = o.state === 'on' || o.confirm ? RED : o.state === 'off' ? GREY_TEXT : WHITE;
        cv.text(o.text, x, y - 2, 27, col, { font: 'bold', spacing: 0.5 });
        if (focus) cv.fillRect(x - 12, lineY, COL_W - 26, o.state === 'on' || o.confirm ? 3 : 2,
            o.state === 'on' || o.confirm ? RED : o.state === 'off' ? withAlpha('#ffffff', 0.14) : GREY_LINE);
        if (o.run && cv.target) cv.target(x - 12, y - 40, COL_W - 26, ROW_H - 4, o.run, o.key);
    });
}

/** The driving mode (statusFESVehicleDynamicSwitchHMI) -> each row's setting, or null when it can't be told. */
function settingsFor(drive) {
    const sport = { engine: 1, chassis: 1, steering: 1, brake: 1 };
    const plus = { engine: 2, chassis: 2, steering: 1, brake: 1 };
    const comfort = { engine: 0, chassis: 0, steering: 0, brake: 0 };
    if (drive == null) return null;
    const n = Number(drive);
    if (!isNaN(n) && String(drive).trim() !== '') {
        if (n === 1 || n === 15) return sport;
        if (n === 2 || n === 23) return plus;
        if (n === 4 || n === 5 || n === 7 || n === 8 || n === 17 || n === 18 || n === 19) return comfort;
        return null;                               // Individual, Adaptive, initialising: per-row values not reported
    }
    const s = String(drive).toUpperCase();
    if (/INDIVIDUAL|ADAPTIVE/.test(s)) return null;
    if (/SPORT_PLUS|EXPERT|PLUS/.test(s) && /SPORT|EXPERT/.test(s)) return plus;
    if (/SPORT/.test(s)) return sport;
    if (/COMFORT|ECO|HYBRID/.test(s)) return comfort;
    return null;
}

function draw(cv, G, t, v, press, info) {
    cv.clear('#000000');
    let top;
    if (cv.chrome) {                                // full screen: the HMI's title strip says SETUP (screen title)
        G.frame(cv, t, [], 0, []);
        top = 18;
    } else {                                        // standard layout: the menu's own header
        cv.fillRect(0, 0, W, 64, '#000000');
        const hx = 40, hy = 38;                     // a house
        cv.fill([[hx, hy - 16], [hx - 14, hy - 4], [hx + 14, hy - 4]], WHITE);
        cv.fillRect(hx - 10, hy - 4, 20, 13, WHITE);
        cv.fillRect(hx - 3, hy + 2, 6, 7, '#000000');
        cv.text('SETUP', 78, hy + 8, 30, withAlpha('#ffffff', 0.6), { font: 'label', spacing: 1 });
        cv.fillRect(70, 62, W - 140, 2, withAlpha('#ffffff', 0.8));
        top = 64;
    }
    const pitch = Math.min(ROW_H, (H - top - 60) / 5);
    let y = top + pitch * 0.68;

    const s = settingsFor(v.drive) || {};
    const pick = (key, i) => (s[key] === i ? 'on' : 'free');
    const info3 = (text) => () => info(text);
    const ro = 'Engine, Chassis, Steering and Brake follow the driving mode (read only)';
    row(cv, y, iconEngine, 'Engine', [{ text: 'EFFICIENT', state: pick('engine', 0), run: info3(ro), key: 'e0' },
        { text: 'SPORT', state: pick('engine', 1), run: info3(ro), key: 'e1' },
        { text: 'SPORT PLUS', state: pick('engine', 2), run: info3(ro), key: 'e2' }], false);
    y += pitch;
    row(cv, y, iconChassis, 'Chassis', [{ text: 'COMFORT', state: pick('chassis', 0) },
        { text: 'SPORT', state: pick('chassis', 1) }, { text: 'SPORT PLUS', state: pick('chassis', 2) }], false);
    y += pitch;
    row(cv, y, iconSteering, 'Steering', [{ text: 'COMFORT', state: pick('steering', 0) }, { text: 'SPORT', state: pick('steering', 1) }], false);
    y += pitch;
    row(cv, y, iconBrake, 'Brake', [{ text: 'COMFORT', state: pick('brake', 0) }, { text: 'SPORT', state: pick('brake', 1) }], false);
    y += pitch;

    // --- M xDrive: the live row ---
    const m = v.mode, usable = v.armed && v.supported === true;
    const awd = m === 'AWD', rwd = m === 'RWD' || m === 'RWD SET';
    row(cv, y, iconXDrive, 'M xDrive', [
        { text: '4WD', state: awd ? 'on' : usable ? 'free' : 'off', run: press('on'), key: 'rwd_on', confirm: v.confirmOn },
        { text: '4WD SPORT', state: 'off', run: info3('4WD Sport needs a transfer case flash · not offered by this app'), key: 'rwd_sport' },
        { text: '2WD', state: rwd ? 'on' : usable ? 'free' : 'off', run: press('off'), key: 'rwd_off', confirm: v.confirmOff },
    ], true);

    // --- one quiet hint line, like the menu's: what is going on / what is missing ---
    const hint = !v.armed ? 'Disarmed in Settings · nothing is sent to the car'
        : v.supported === false ? v.reason
        : v.confirmOff || v.confirmOn ? 'Parking brake on? Press ' + (v.confirmOff ? '2WD' : '4WD') + ' again to confirm'
        : v.note || (m === 'RWD SET' ? 'Start the engine without switching the ignition off'
            : awd ? v.blockOff : rwd ? v.blockOn : v.blockOff);
    const bottom = (G.pageBottom ? G.pageBottom(cv) : H) - 22;
    if (hint) cv.text(hint, 52, bottom, 21, v.noteType === 'go' ? '#2fd27a'
        : v.note || v.supported === false || v.confirmOff || v.confirmOn ? '#d29922' : withAlpha('#ffffff', 0.45), { font: 'label' });
    const nm = (x) => (x < 0 ? '-' : '') + Math.abs(x).toFixed(1) + ' Nm';
    if (v.torque) cv.text('Front axle ' + nm(v.torque.actual), W - 52, bottom, 21, withAlpha('#ffffff', 0.45), { font: 'label', align: 'right' });
    return cv;
}

module.exports = { draw, settingsFor, W, H };

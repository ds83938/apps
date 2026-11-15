'use strict';
/**
 * RWD Mode - AWD / RWD on a button press (stopped, in P; engine running is fine), back to AWD by itself on an ignition cycle. See rwd.js for exactly what is
 * sent and the rules around it. Ships Disarmed: then the app only draws, it sends no bytes at all.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const { RwdMode } = require('./rwd');
const UI = require('./ui');

const { W, H } = UI;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'gear', 'condition']);
        const diag = await new Diag(ctx.signals, log).init();
        const rwd = new RwdMode(ctx, car, diag);
        let loop = null;
        const repaint = () => (loop && loop.kick ? loop.kick() : render());

        const press = (which) => () => { const p = rwd.press(which); repaint(); return p.then(repaint).catch((e) => log.error('rwd', e)); };

        // the driving mode, for the Engine / Chassis / Steering / Brake rows (read only)
        let drive = null;
        ctx.signals.watch('de.bmw.infotainment.drivingexcitement.FES', '1', {
            statusFESVehicleDynamicSwitchHMI: (s) => { drive = s && s.actualValueModeDrivingExperience; repaint(); },
        }, log).then((s) => log.info('drive mode ' + (s && s.error ? 'error: ' + s.error : 'subscribed')));
        // a press on a row that only shows something: say why on the hint line
        const info = (text) => { rwd.note = text; rwd.noteType = 'dim'; repaint(); };

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H) || new Canvas(W, H);
            const r = rwd.tick();
            if (r) r.then(repaint).catch((e) => log.error('rwd tick', e));
            UI.draw(cv, G, t, Object.assign(rwd.view(), { drive }), press, info);
            return ui.image('MAIN_GFX', cv);
        }

        loop = ctx.loop('MAIN', 10, render);
        if (ctx.hideButton) { ctx.hideButton('BTN_AWD'); ctx.hideButton('BTN_RWD'); }
        ui.onClick('BTN_AWD', press('on'));           // fallback when the HMI bar has the buttons
        ui.onClick('BTN_RWD', press('off'));

        // the ignition: watched also off screen, so an ignition cycle always clears the state
        let lastCond = null;
        setInterval(() => {
            const d = car.data();
            if (d.demo || typeof d.condition !== 'number' || d.condition === lastCond) return;
            lastCond = d.condition;
            rwd.onCondition(d.condition);
        }, 250);

        const reidentify = () => rwd.identify().then(repaint).catch((e) => log.error('identify', e));
        settings.onChange((key) => { if (key === 'arm') reidentify(); else repaint(); });
        diag.on('available', (on) => { if (on) reidentify(); else repaint(); });
        await reidentify();
        log.info('rwd_mode ready (' + (rwd.armed ? 'armed' : 'disarmed') + ')');
    },
});

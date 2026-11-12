# Signal Scanner

Logs every change of the car signals it listens to, with a time, to a file on the head unit. **Read only:** it subscribes to signals and never sends anything to the car.

Made to find out whether buttons (for example on a retrofitted shifter) send anything the head unit can see.

## Use

1. Open **Signal Scanner** from the apps menu, car parked.
2. Press **Mark**, then press the button you are testing. Wait two seconds.
3. The page shows `Mark N:` and the signals that changed within 1.5 s of the mark, or `nothing changed`.
4. Repeat for each button. Write down which mark number was which button.
5. **New log** starts a fresh file.

The page also lists the latest changes, newest first, and how many interfaces are answering.

## Files (in the app's `data/` folder on the car)

- `scan-<time>.jsonl`: one JSON line per change, `{"t": ms since the log started, "key": "Interface.field", "v": value}`, plus `{"key": "MARK", "v": N}` lines. Saved every 5 s and on every Mark.
- `someip-interfaces.json`: a copy of the head unit's full signal catalogue, made on start, to choose more signals to watch.

## What it listens to

`config.watch` in `app.json` (keep it in step with `"signals"`, which is what the installer grants). Version 0.1.0 watches what the other apps in this repo already use: rpm, temperatures, accelerations, speed, the drive-mode switch (FES), gearbox, tank and outside temperature. A button whose signal isn't in that list won't show up, even if the car sends it. The next version adds signals picked from the catalogue copy.

A head unit only sees what the car's gateway passes to it, so "nothing changed" does not prove a button is dead.

## Test without the car

```sh
node tools/tests/can_scanner_recorder.test.js
```

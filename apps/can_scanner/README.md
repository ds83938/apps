# Signal Scanner

Logs every change of the car signals it listens to, with a time, to a file on the head unit. **Read only:** it subscribes to signals and never sends anything to the car.

Made to find out whether buttons (for example on a retrofitted shifter) send anything the head unit can see.

## Use

1. Open **Signal Scanner** from the apps menu, car parked.
2. Tap **Mark**, then press the button you are testing within 6 seconds. Press it once and leave the other controls alone.
3. After 6 s the page shows `Mark N:` and the signals that changed from 0.5 s before the mark to 6 s after it, or `nothing changed`.
4. Repeat for each button. Write down which mark number was which button.
5. **New log** starts a fresh file.

The page also lists the latest changes, newest first, and how many interfaces are answering.

## Files (in the app's `data/` folder on the car)

- `scan-<time>.jsonl`: one JSON line per change, `{"t": ms since the log started, "key": "Interface.field", "v": value}`, plus `{"key": "MARK", "v": N}` lines. Saved every 5 s and on every Mark. The change count on the page leaves the marks out.
- `someip-interfaces.json`: a copy of the head unit's full signal catalogue, made on start, to choose more signals to watch.

## What it listens to

`config.watch` in `app.json` (keep it in step with `"signals"`, which is what the installer grants). Version 0.2.0 watches every field of the drive-dynamics (FES) and VehicleInformation interfaces, plus rpm, temperatures, accelerations, speed, tank and outside temperature. The two accelerations are left out of Mark results (`config.quietInMark`): parked, they flicker around zero all the time. On start it also lists catalogue names matching `config.search` (exhaust, flap, sound, Abgas, Klappe...) on the page and in `data/catalogue-matches.txt`. A button whose signal isn't in that list won't show up, even if the car sends it. The next version adds signals picked from the catalogue copy.

A head unit only sees what the car's gateway passes to it, so "nothing changed" does not prove a button is dead.

## Test without the car

```sh
node tools/tests/can_scanner_recorder.test.js
```

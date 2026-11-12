# Signal Scanner

Logs every change of the car signals it listens to, with a time, to a file on the head unit. **Read only:** it subscribes to signals and never sends anything to the car.

Made to find out whether buttons (for example on a retrofitted shifter) send anything the head unit can see.

## Use

1. Open **Signal Scanner** from the apps menu, car parked. Give it 20 s to learn what is normally busy.
2. Tap **Mark**, then press the button you are testing within 6 seconds. Press it once and leave the other controls alone.
3. After 6 s the page shows `Mark N: NEW <signal> = <value>` for every signal that was **quiet** before and moved, and `N busy ignored` for signals that tick all the time (counters, CRCs, sensors). `nothing new` means no quiet signal moved.
4. Repeat for each button. Write down which mark number was which button.
5. **New log** starts a fresh file.

A signal counts as busy when it changed more than once in the 20 s before the mark, apart from earlier marks' own windows, so pressing the same button every 10 s does not hide it. The full lists (new and busy, with counts) are in the log.

The page also lists the latest changes, newest first, and which interfaces answer. An interface this car doesn't have is named after "not on this car".

## Files (in the app's `data/` folder on the car)

- `scan-<time>.jsonl`: one JSON line per change, `{"t": ms since the log started, "key": "Interface.field", "v": value}`, plus `{"key": "MARK", "v": N}` lines. Saved every 5 s and on every Mark. The change count on the page leaves the marks out.
- `someip-interfaces.json`: a copy of the head unit's full signal catalogue, made on start, to choose more signals to watch.

## What it listens to

`config.watch` in `app.json` (keep it in step with `"signals"`, which is what the installer grants). Version 0.3.0:

- every field of the drive-dynamics (FES) and VehicleInformation interfaces
- rpm, temperatures, accelerations, speed, tank, outside temperature
- tyre pressures and temperatures (TPMS, re-read every 4 s: the car never notifies them), the M drive display (MDrive) and the car's wake / ignition state (VehicleCondition). These three are `_optional`: a car without them still installs the app.

On start it tries to copy the head unit's signal catalogue (`/etc/oap/someip/someip-interfaces.json`) into `data/` and lists the names matching `config.search` (exhaust, flap, sound, Abgas, Klappe...). If the app cannot read it, the page says why and lists what it can see under `/etc/oap`.

A head unit only sees what the car's gateway passes to it, so "nothing new" does not prove a button is dead.

## Test without the car

```sh
node tools/tests/can_scanner_recorder.test.js
```

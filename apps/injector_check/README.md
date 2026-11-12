# Injector Check

An INPA-style injector check on the center screen, for the B58 (and B48 / B38) engines of the G series. It reads what the engine unit (DME) knows about each cylinder and shows which one stands out from the others.

**It only reads.** The app's diagnostic link (`inj_link.js`) talks to the engine unit only, and only allows reading identifiers (UDS `22`), the OBD misfire monitors (`06` / `22 F6xx`) and the fault memory (`19 02`). Clearing faults, resetting adaptations, sessions, security access, writes, routines and anything to another unit are refused before they leave the head unit. It never resets your adaptations, so the values you see are what the DME has learned.

## Pages

| Tab | What it shows |
|---|---|
| **Injectors** | Live, per cylinder: the DME's **injector flow correction** (in %, around 0), **rough running** (rad/s²), the **misfire counter** and the **ignition angle**. Above: rpm, coolant, the mean injector adaptation and the mixture adaptation. A cylinder that differs from the other five gets LOOK (amber) or CHECK (red), and the bottom line says why. |
| **Fuel** | High-pressure rail actual vs target (with a one-minute trace), low-pressure fuel (the sensor's raw value), lambda actual vs target, mixture adaptation, mean injector adaptation, fuel temperature, flow, adapted fuel quality, ethanol and the mean knock retard. |
| **Idle test** | 30 s of averaging at a warm idle, like INPA's smooth-running test: injector correction and rough running per cylinder as mean ± spread, misfires during the test, and each cylinder against the others. The last 20 results are kept on the head unit (`data/idle-tests.json`) so you can compare after a swap or a repair. The test stops by itself if the revs go up or the engine goes off. |
| **Faults** | The engine unit's fault memory (codes and status as the DME stores them) and the OBD misfire monitor per cylinder (this / last drive cycle, and the average of the last 10). |

## What the numbers mean

- **Injector correction.** The DME trims fuel per cylinder. `+5 %` means it adds 5 % more fuel to that cylinder than planned: the injector flows less than it should (or the cylinder runs lean for another reason). `-5 %` means it takes fuel away: the injector flows too much, or drips. One cylinder far from the other five is the classic sign of a tired injector.
- **Rough running.** How much the crankshaft speeds up or slows down on that cylinder's stroke. A weak cylinder stands out from the rest. Compare at a warm idle, not while driving.
- **Misfire counter.** Misfires the DME counted on that cylinder. Misfires on one cylinder only, together with an injector correction on the same cylinder, point at the injector; misfires without one point more at the plug or coil.
- **Mixture adaptation.** The DME's overall fuel trim. Well above 0 on every cylinder at once is not an injector: think fuel delivery (low-pressure pump, filter), an air leak or the air mass reading.

## How it judges

Each cylinder is compared with the **median of the other five**, so one bad cylinder can't hide itself by pulling the reference. Flags (amber / red):

| | amber from | red from |
|---|---|---|
| Injector correction | 4 % from the others | 8 % |
| Rough running | 1.5 rad/s² | 3 rad/s² |
| Ignition angle | 3 °CA | 6 °CA |
| Misfires | any on one cylinder | 5 or more, and half or more of all |

These limits are this app's starting points, **not BMW's**. A flag means "differs from the other cylinders", not "faulty". Live values move a lot; use the Idle test with a warm engine for a fair comparison.

**Confirming a suspect:** swap the suspect injector with a neighbour (say 4 and 3), clear nothing, drive a day, run the idle test again. If the deviation moves to the other cylinder, it is the injector. If it stays, look at that cylinder's coil, plug or compression. Swapping a coil first is the cheaper test for misfires.

## Reading

One request at a time, at least 25 ms apart, up to 8 identifiers per request, only while the app's screen is shown or an idle test runs. An identifier this car's DME refuses is skipped and asked again after a minute. Identifiers and scaling are the DME8FF_R SGBD's (B58 / B48 / B38, G series), taken from cauliflowermossgrape's Live Data catalog; checked in the emulator only so far.

## Not yet checked on a car

Everything here is built from the DME's published identifier list and run in the emulator with demo data. The first car test should confirm: that all four per-cylinder groups answer, the sign of the injector correction, typical rough-running values at idle, the low-pressure fuel scaling, and that the fault memory and misfire monitors read. Please report what yours shows.

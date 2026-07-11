# annalog-rooms

**UWB room presence for Annalog.** Two ultra-wideband tags (worn by
caregivers) range against one anchor per room; this server reads the tags over
USB serial, decides which room each person is in, and broadcasts live events —
the hardware feed behind **AnnalogTrack** in the
[Annalog Suite](https://github.com/KawikaTu/annalog-suite).

```
[ tag Anupam (USB) ] --distances--> [ RoomTracker A ] --\
                                                         +--> console + CSV + WebSocket
[ tag Kawika (USB) ] --distances--> [ RoomTracker B ] --/
```

## How it works

- **`backend/serialSource.js`** — reads distance reports from a tag's serial
  port (115200 baud) and emits parsed `{ anchorId, distance }` sets.
- **`backend/tagScheduler.js`** — the referee. The CLI firmware has no
  multi-initiator scheduler, so tags take turns speaking (3 s ranging,
  1.2 s gap for anchors to re-lock; full cycle ≈ 9 s).
- **`backend/roomTracker.js`** — nearest-anchor room detection with hysteresis:
  1. **Slam dunk:** within 1.0 m of an anchor → that room, immediately.
  2. **Hysteresis:** otherwise only switch if the new anchor is 0.8 m closer —
     kills doorway flip-flopping.
  3. **Lost anchor:** if the current room's anchor goes silent but another
     answers, switch after 15 s (must exceed one scheduler cycle).
- **`backend/server.js`** — Express + WebSocket on **:3000**. Serves the
  dashboard, appends every room change to `logs/room-events.csv`, and
  broadcasts JSON to every connected client:
  - `{ type: 'init', rooms, people }` — snapshot on connect
  - `{ type: 'room_entered', tagName, room, enteredAtIso, previousRoom, previousRoomSeconds, … }`
  - `{ type: 'distances', tagName, distances }` — raw signal, throttled to 1/s
- **`frontend/index.html`** — zero-build live dashboard (room board + movement
  ledger).

Consumers: open `http://localhost:3000` for the dashboard, or connect a
WebSocket client — that's exactly what
[`annalog-backend`](https://github.com/KawikaTu/annalog-backend)'s
`trackBridge.js` does to feed AnnalogTrack.

## Run

```bash
npm install
# edit the two TAG serial ports at the top of backend/server.js
#   (ls /dev/tty.usbmodem*), and the anchor→room map in backend/roomTracker.js
npm start          # → http://localhost:3000
```

Anchors are started on wall power with `respf -MULTI -addr=N`; tags are driven
by the scheduler with `initf -MULTI -PADDR=[1,2]`.

## Scaling out (Raspberry Pi)

Run one instance of this server per zone (e.g. per Raspberry Pi with its local
tags/anchors) and point the suite backend at all of them:
`ROOMS_FEED_URLS=ws://pi-1:3000,ws://pi-2:3000`.

## Output

`logs/room-events.csv` — append-only log:
`entered_at_iso, person, room, previous_room, left_previous_at_iso, seconds_in_previous`

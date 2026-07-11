// ===========================================================================
// backend/server.js — Annalog room presence (self-contained)
// ---------------------------------------------------------------------------
//   [ tag Anupam (USB) ] --distances--> [ tracker A ] --\
//                                                        +--> console + CSV + browser
//   [ tag Kawika (USB) ] --distances--> [ tracker B ] --/
//
//   TagScheduler round-robins the tags (only one ranges at a time) because
//   the CLI firmware has no multi-initiator scheduler of its own.
// ===========================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { SerialSource } from './serialSource.js';
import { RoomTracker, ROOMS } from './roomTracker.js';
import { TagScheduler } from './tagScheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// ⬇️  EDIT: your two TAG boards (NOT the anchors — anchors live on wall
//     power and never appear here). Find ports with: ls /dev/tty.usbmodem*
const TAGS = [
  { port: '/dev/tty.usbmodemCF50CBB6673C1', name: 'Anupam' },
  { port: '/dev/tty.usbmodemDDC0D0CCF9E21', name: 'Kawika' },
];
// ⬆️  END OF THE PART YOU EDIT

// --- CSV log: logs/room-events.csv -----------------------------------------
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const csvPath = path.join(logDir, 'room-events.csv');
if (!fs.existsSync(csvPath)) {
  fs.writeFileSync(
    csvPath,
    'entered_at_iso,person,room,previous_room,left_previous_at_iso,seconds_in_previous\n'
  );
}
function logToCsv(e) {
  const row = [
    e.enteredAtIso,
    e.tagName,
    e.room,
    e.previousRoom ?? '',
    e.leftPreviousAtIso ?? '',
    e.previousRoomSeconds ?? '',
  ].join(',');
  fs.appendFile(csvPath, row + '\n', (err) => {
    if (err) console.error('[csv] write failed:', err.message);
  });
}

// --- HTTP + WebSocket -------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, '..', 'frontend')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Latest state per person, so late-joining browsers catch up instantly.
const people = {}; // { Anupam: { room, enteredAtIso }, ... }

wss.on('connection', (ws) => {
  console.log(`[ws] browser connected (${wss.clients.size} open)`);
  ws.send(JSON.stringify({ type: 'init', rooms: ROOMS, people }));
  ws.on('close', () =>
    console.log(`[ws] browser left (${wss.clients.size} open)`)
  );
});

function broadcast(message) {
  const json = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(json);
  }
}

// --- Wire up each tag --------------------------------------------------------
const sources = [];
const schedulerSlots = []; // so the scheduler can reach each tag's port
const lastDistanceBroadcast = {}; // throttle raw distance updates per person

for (const t of TAGS) {
  const source = new SerialSource({
    serial: { path: t.port, baudRate: 115200 },
    tag: { name: t.name },
  });
  const tracker = new RoomTracker(); // separate memory per person

  tracker.on('room', (event) => {
    people[event.tagName] = {
      room: event.room,
      enteredAtIso: event.enteredAtIso,
    };
    console.log(
      `[room] ${event.tagName} entered ${event.room} at ${event.enteredAtIso}` +
      (event.previousRoom
        ? ` — left ${event.previousRoom} after ${event.previousRoomSeconds}s`
        : '')
    );
    logToCsv(event);
    broadcast(event);
  });

  source.on('distances', (payload) => {
    tracker.update({ distances: payload.distances, tagName: t.name });

    // Live "raw signal" for the dashboard, at most once per second per tag.
    const now = Date.now();
    if (now - (lastDistanceBroadcast[t.name] ?? 0) > 1000) {
      lastDistanceBroadcast[t.name] = now;
      broadcast({
        type: 'distances',
        tagName: t.name,
        distances: payload.distances,
      });
    }
  });

  // One tag's port dying must never take down the other tag.
  source.on('error', (err) => {
    console.log(`[${t.name}] port error (${err.message}) — keeping others running`);
  });

  source.start();
  sources.push(source);
  schedulerSlots.push({ name: t.name, source }); // hand this tag to the referee
}

// --- The referee: force tags to take turns -----------------------------------
// You measured stop -> initf re-acquire at ~1s by hand, so:
//   rangeMs 3000 = each tag speaks 3s (several clean rounds)
//   gapMs  1200 = silence for the anchors to re-lock
// Full cycle = 2 * (3000 + 300 + 1200) = 9s, safely under the 15s
// lost-anchor timeout in roomTracker.js.
const scheduler = new TagScheduler(schedulerSlots, {
  rangeMs: 3000,
  gapMs: 1200,
  startCmd: 'initf -MULTI -PADDR=[1,2]',
  stopCmd: 'stop',
  onTurn: (name) => {
    console.log(`[scheduler] floor -> ${name}`);
    broadcast({ type: 'turn', tagName: name });
  },
});

// Give the serial ports a moment to finish opening before typing into them.
setTimeout(() => scheduler.start(), 3000);

// --- Go live ------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('\n  ┌───────────────────────────────────────────────┐');
  console.log('  │  Annalog room presence is running             │');
  console.log(`  │  Open  http://localhost:${PORT}                  │`);
  console.log('  └───────────────────────────────────────────────┘\n');
});

process.on('SIGINT', async () => {
  console.log('\n[server] shutting down ...');
  await scheduler.stopAll(); // leave the airwaves clean for next run
  for (const s of sources) s.stop();
  server.close(() => process.exit(0));
});

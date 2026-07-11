// ===========================================================================
// backend/serialSource.js — parses Qorvo QM33 CLI ranging output
// ---------------------------------------------------------------------------
// The firmware prints one round per SESSION_INFO_NTF, measurements on
// following lines:
//
//   SESSION_INFO_NTF: {session_handle=1, sequence_number=163, block_index=163, n_measurements=2
//    [mac_address=0x0001, status="SUCCESS", distance[cm]=152]
//    [mac_address=0x0002, status="RX_TIMEOUT"]}
//
// We collect the whole round, keep only clean SUCCESS measurements, and emit:
//   { distances: [ { id:'0x0001', dist:1.52 }, ... ], tagName }
// (dist in METERS.)
// ===========================================================================

import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const HEADER_RE = /SESSION_INFO_NTF.*n_measurements\s*=\s*(\d+)/;
const MEASUREMENT_RE = /mac_address\s*=\s*(0x[0-9A-Fa-f]+)/;
const STATUS_RE = /status\s*=\s*"?(\w+)"?/;
const DISTANCE_RE = /distance\D{0,5}(-?\d+)/i; // also catches garbled negatives so we can reject them

export class SerialSource extends EventEmitter {
  constructor({ serial, tag }) {
    super();
    this.path = serial.path;
    this.baudRate = serial.baudRate ?? 115200;
    this.tagName = tag?.name ?? 'tag';
    this.port = null;
    this._expecting = 0;
    this._batch = [];
    // DEBUG: true = log every serial line + every command sent.
    // Flip to false for the demo once two-tag switching is confirmed.
    this.debug = true;
  }

  start() {
    this.port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    this.port.open((err) => {
      if (err) {
        this.emit('error', err);
        return;
      }
      console.log(`[serial] ${this.tagName}: opened ${this.path}`);
    });

    const lines = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    lines.on('data', (line) => this._handleLine(line.toString().trim()));

    this.port.on('error', (err) => this.emit('error', err));
    this.port.on('close', () =>
      console.log(`[serial] ${this.tagName}: port closed`)
    );
  }

  // The scheduler types commands into the board through this, exactly like
  // you typing in the serial terminal. \r\n = pressing Enter.
  sendCommand(cmd) {
    if (this.debug) console.log(`[cmd] ${this.tagName} <- ${cmd}`);
    this.port.write(cmd + '\r\n');
  }

  // Clear round-counting state. Called by the scheduler right before it
  // (re)starts this tag, so leftovers from the previous session can never
  // leave the parser stuck waiting for measurements that will not come.
  resetParser() {
    this._expecting = 0;
    this._batch = [];
  }

  stop() {
    if (this.port?.isOpen) this.port.close();
  }

  _handleLine(line) {
    if (!line) return;

    if (this.debug) console.log('[raw]', this.tagName, line);

    const header = line.match(HEADER_RE);
    if (header) {
      this._flush(); // previous round ended abruptly? emit what we had
      this._expecting = parseInt(header[1], 10) || 0;
      // A measurement can ride on the same line as the header — fall through.
    }

    const mac = line.match(MEASUREMENT_RE);
    if (mac && this._expecting > 0) {
      const status = line.match(STATUS_RE)?.[1] ?? '';
      const distMatch = line.match(DISTANCE_RE);

      if (/^success$/i.test(status) && distMatch) {
        const dist = parseInt(distMatch[1], 10) / 100; // cm -> meters
        // Only accept clean, physically-possible distances. Garbled lines
        // (chopped text, negative numbers) are dropped silently.
        if (Number.isFinite(dist) && dist >= 0) {
          this._batch.push({
            id: mac[1].toLowerCase(),
            dist,
          });
        }
      }
      this._expecting -= 1;
      if (this._expecting === 0) this._flush();
    }
  }

  _flush() {
    if (this._batch.length > 0) {
      this.emit('distances', { distances: this._batch, tagName: this.tagName });
    }
    this._batch = [];
    this._expecting = 0;
  }
}

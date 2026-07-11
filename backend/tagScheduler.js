// ===========================================================================
// backend/tagScheduler.js — THE REFEREE
// ---------------------------------------------------------------------------
// The QM33 CLI firmware has no scheduler: two initiator tags fight over the
// anchors and one starves. This module makes the tags take turns by typing
// commands into their serial ports, EXACTLY like you do by hand:
//
//   stop the running tag  ->  short silence  ->  initf the next tag  ->  ...
//
// Only one tag ever transmits at a time, so collisions are impossible.
// You confirmed by hand that stop-then-initf re-acquires in ~1s, so this
// should feel just as fast.
// ===========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TagScheduler {
  /**
   * @param {Array} slots - one entry per tag, in turn order:
   *   { name: 'Kawika', source: <SerialSource instance> }
   * @param {Object} opts - all optional:
   *   rangeMs  - how long each tag gets the floor        (default 4000)
   *   gapMs    - silence after 'stop' so anchors unlock   (default 1500)
   *   startCmd - command that starts ranging
   *   stopCmd  - command that stops the session
   *   onTurn   - callback (name) => {} whenever the floor changes
   */
  constructor(slots, opts = {}) {
    this.slots = slots;
    this.rangeMs = opts.rangeMs ?? 4000;
    this.gapMs = opts.gapMs ?? 1500;
    this.startCmd = opts.startCmd ?? 'initf -MULTI -PADDR=[1,2]';
    this.stopCmd = opts.stopCmd ?? 'stop';
    this.onTurn = opts.onTurn ?? (() => {});
    this.running = false;
    this._loopPromise = null;
  }

  cycleMs() {
    return this.slots.length * (this.rangeMs + this.gapMs);
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // Starting line: make sure NO tag is ranging. Stop every board, wait for
    // the airwaves to go quiet. This mirrors you clearing both boards by hand
    // before beginning.
    for (const slot of this.slots) {
      slot.source.sendCommand(this.stopCmd);
    }
    await sleep(this.gapMs);

    this._loopPromise = this._loop();
  }

  async _loop() {
    let i = 0;
    while (this.running) {
      const slot = this.slots[i];
      this.onTurn(slot.name);

      // 1. Belt-and-braces: make sure this board is stopped before we start
      //    it. Harmless if already stopped; clears any lingering session so
      //    `initf` starts clean.
      slot.source.sendCommand(this.stopCmd);
      await sleep(300);

      // 2. Clear the parser's round state so leftover counting from the old
      //    session can't swallow this one.
      if (typeof slot.source.resetParser === 'function') {
        slot.source.resetParser();
      }

      // 3. Give this tag the floor — exactly the command that works by hand.
      slot.source.sendCommand(this.startCmd);

      // 4. Let it collect SESSION_INFO_NTF rounds.
      await sleep(this.rangeMs);

      // 5. Take the floor back.
      slot.source.sendCommand(this.stopCmd);

      // 6. Quiet gap so the anchors drop their sync-lock and re-acquire the
      //    next tag.
      await sleep(this.gapMs);

      i = (i + 1) % this.slots.length;
    }
  }

  async stopAll() {
    this.running = false;
    if (this._loopPromise) await this._loopPromise;
    for (const slot of this.slots) {
      slot.source.sendCommand(this.stopCmd);
    }
  }
}

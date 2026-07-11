// ===========================================================================
// backend/roomTracker.js — nearest-anchor room detection with hysteresis
// ---------------------------------------------------------------------------
// Room = whichever anchor the tag is nearest to. One anchor per room.
//
// Decision rules, in order:
//   1. SLAM DUNK: within CLOSE_ENOUGH_M (1.0m) of an anchor -> that room,
//      immediately. Walking right up to an anchor always wins.
//   2. HYSTERESIS: otherwise only switch rooms if the new anchor is
//      SWITCH_MARGIN_M (0.8m) closer than the current room's anchor.
//      Kills doorway flip-flopping.
//   3. LOST ANCHOR: if the current room's anchor stops answering entirely
//      but another anchor IS answering, switch after LOST_ANCHOR_MS.
//      NOTE: 15000ms on purpose — with the round-robin scheduler each tag
//      is deliberately silent ~5s per cycle; this must stay LONGER than one
//      full scheduler cycle or people flicker to "lost" between turns.
// ===========================================================================

import { EventEmitter } from 'node:events';

// ⬇️  EDIT: anchor address -> room name (keys lowercase, matching what
//     serialSource emits). Address set on the anchor via: respf -MULTI -addr=N
export const ROOMS = {
  '0x0001': 'Room A', // anchor started with  respf -MULTI -addr=1
  '0x0002': 'Room B', // anchor started with  respf -MULTI -addr=2
};
// ⬆️  END OF THE PART YOU EDIT

const CLOSE_ENOUGH_M = 1.0;   // within 1m of an anchor -> definitely that room
const SWITCH_MARGIN_M = 0.8;  // else require 0.8m advantage to switch
const LOST_ANCHOR_MS = 15000; // must exceed one full scheduler cycle

export class RoomTracker extends EventEmitter {
  constructor() {
    super();
    this.currentRoom = null;
    this.enteredAt = null;
    this._lastSawCurrentAt = 0;
    this._warnedIds = new Set();
  }

  update({ distances, tagName }) {
    if (!Array.isArray(distances) || distances.length === 0) return null;

    // Keep only measurements from anchors we know about.
    const known = [];
    for (const d of distances) {
      const room = ROOMS[d.id];
      if (room) {
        known.push({ ...d, room });
      } else if (!this._warnedIds.has(d.id)) {
        this._warnedIds.add(d.id);
        console.log(
          `[rooms] seen UNKNOWN anchor ${d.id} at ${d.dist.toFixed(2)}m — ` +
          `add it to ROOMS in backend/roomTracker.js`
        );
      }
    }
    if (known.length === 0) return null;

    known.sort((a, b) => a.dist - b.dist);
    const nearest = known[0];
    const current = known.find((k) => k.room === this.currentRoom);
    const now = Date.now();
    if (current) this._lastSawCurrentAt = now;

    let shouldSwitch = false;
    if (this.currentRoom === null) {
      shouldSwitch = true; // first fix: nearest anchor wins
    } else if (nearest.room !== this.currentRoom) {
      if (nearest.dist <= CLOSE_ENOUGH_M) {
        shouldSwitch = true; // rule 1: within 1m — slam dunk
      } else if (current) {
        // rule 2: hysteresis
        shouldSwitch = nearest.dist + SWITCH_MARGIN_M < current.dist;
      } else {
        // rule 3: current room's anchor has gone silent
        shouldSwitch = now - this._lastSawCurrentAt > LOST_ANCHOR_MS;
      }
    }

    if (shouldSwitch && nearest.room !== this.currentRoom) {
      const previousRoom = this.currentRoom;
      const previousEnteredAt = this.enteredAt;
      const msInPrevious = previousEnteredAt ? now - previousEnteredAt : null;

      this.currentRoom = nearest.room;
      this.enteredAt = now;
      this._lastSawCurrentAt = now;

      const event = {
        type: 'room_entered',
        tagName,
        room: nearest.room,
        enteredAtIso: new Date(now).toISOString(),
        previousRoom,
        previousRoomEnteredIso: previousEnteredAt
          ? new Date(previousEnteredAt).toISOString()
          : null,
        leftPreviousAtIso: previousRoom ? new Date(now).toISOString() : null,
        previousRoomSeconds:
          msInPrevious != null ? Math.round(msInPrevious / 1000) : null,
        distanceM: Math.round(nearest.dist * 100) / 100,
        timestamp: now,
      };
      this.emit('room', event);
      return event;
    }

    return null;
  }
}

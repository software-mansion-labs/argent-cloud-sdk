/**
 * Client-side fallback for receivers that only understand legacy per-event
 * `TouchCommand`s (old simulator-servers, the WebRTC data channel): converts
 * consecutive touch-state snapshots into Down/Move/Up events.
 *
 * The device bridge models a gesture as one or two concurrent points sharing a
 * direction, so snapshots are capped at two pointers. A pointer-set change that
 * isn't a clean start or end of a gesture (e.g. a third finger replacing one of
 * the first two) is mapped as Up + Down — a glitch, but those transitions were
 * never expressible in the legacy protocol to begin with.
 */

import type { InputMessage, TouchPointer } from "./encoder.js";

function sameIds(a: readonly TouchPointer[], b: readonly TouchPointer[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i]?.id);
}

function event(action: "Down" | "Up" | "Move", pointers: readonly TouchPointer[]): InputMessage {
  const [first, second] = pointers;
  if (!first) throw new Error("touch event needs at least one pointer");
  return {
    type: "touch",
    action,
    x: first.x,
    y: first.y,
    secondX: second?.x,
    secondY: second?.y,
  };
}

/**
 * Diffs `prev` → `next` into legacy touch events. Both snapshots must be in
 * stable order (pointers keep their position while down). Returns the events
 * to send, and the (capped) snapshot to pass as `prev` next time.
 */
export function diffTouchStates(
  prev: readonly TouchPointer[],
  next: readonly TouchPointer[],
): { events: InputMessage[]; applied: TouchPointer[] } {
  const before = prev.slice(0, 2);
  const after = next.slice(0, 2);

  if (before.length === 0 && after.length === 0) {
    return { events: [], applied: [] };
  }
  if (before.length === 0) {
    return { events: [event("Down", after)], applied: after };
  }
  if (after.length === 0) {
    return { events: [event("Up", before)], applied: [] };
  }
  if (sameIds(before, after)) {
    return { events: [event("Move", after)], applied: after };
  }
  return { events: [event("Up", before), event("Down", after)], applied: after };
}

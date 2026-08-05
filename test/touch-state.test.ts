import { describe, expect, it } from "vitest";

import { diffTouchStates } from "../src/proto/touch-state.js";

const p = (id: number, x: number, y: number) => ({ id, x, y });

describe("diffTouchStates", () => {
  it("returns nothing for two empty snapshots", () => {
    expect(diffTouchStates([], []).events).toEqual([]);
  });

  it("maps a pointer appearing to Down", () => {
    const { events, applied } = diffTouchStates([], [p(1, 0.2, 0.3)]);
    expect(events).toEqual([
      { type: "touch", action: "Down", x: 0.2, y: 0.3, secondX: undefined, secondY: undefined },
    ]);
    expect(applied).toEqual([p(1, 0.2, 0.3)]);
  });

  it("maps a moved pointer to Move", () => {
    const { events } = diffTouchStates([p(1, 0.2, 0.3)], [p(1, 0.4, 0.5)]);
    expect(events[0]).toMatchObject({ action: "Move", x: 0.4, y: 0.5 });
  });

  it("maps a pointer disappearing to Up at its last position", () => {
    const { events, applied } = diffTouchStates([p(1, 0.4, 0.5)], []);
    expect(events[0]).toMatchObject({ action: "Up", x: 0.4, y: 0.5 });
    expect(applied).toEqual([]);
  });

  it("carries a second pointer through Down/Move/Up", () => {
    const down = diffTouchStates([], [p(1, 0.1, 0.1), p(2, 0.9, 0.9)]);
    expect(down.events[0]).toMatchObject({
      action: "Down",
      x: 0.1,
      y: 0.1,
      secondX: 0.9,
      secondY: 0.9,
    });

    const move = diffTouchStates(down.applied, [p(1, 0.2, 0.2), p(2, 0.8, 0.8)]);
    expect(move.events[0]).toMatchObject({ action: "Move", secondX: 0.8, secondY: 0.8 });

    const up = diffTouchStates(move.applied, []);
    expect(up.events[0]).toMatchObject({ action: "Up", x: 0.2, y: 0.2, secondX: 0.8 });
  });

  it("maps a pointer-set change mid-gesture to Up then Down", () => {
    const { events } = diffTouchStates([p(1, 0.1, 0.1)], [p(1, 0.1, 0.1), p(2, 0.9, 0.9)]);
    expect(events.map((e) => (e as { action: string }).action)).toEqual(["Up", "Down"]);
  });

  it("ignores pointers beyond the second", () => {
    const { events, applied } = diffTouchStates(
      [],
      [p(1, 0.1, 0.1), p(2, 0.2, 0.2), p(3, 0.3, 0.3)],
    );
    expect(events).toHaveLength(1);
    expect(applied).toHaveLength(2);

    // A third pointer appearing or vanishing must not produce events.
    const next = diffTouchStates(applied, [p(1, 0.1, 0.1), p(2, 0.2, 0.2)]);
    expect(next.events[0]).toMatchObject({ action: "Move" });
  });
});

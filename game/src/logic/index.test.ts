import { describe, expect, it } from "vitest";
import { createInitialState, update } from "./index.ts";

describe("game update", () => {
  it("advances physics and preserves pause handling", () => {
    const state = update(createInitialState(), 0.1, {
      left: false,
      right: true,
      jump: false,
      pause: false,
    });

    expect(state.elapsed).toBeCloseTo(0.1);
    expect(state.player.x).toBeGreaterThan(375);
    expect(state.player.velocityX).toBe(240);

    const paused = update(state, 1, {
      left: true,
      right: false,
      jump: true,
      pause: true,
    });
    expect(paused).toEqual({ ...state, paused: true });
  });

  it("launches and records a jump reaction", () => {
    const state = update(createInitialState(), 0.01, {
      left: false,
      right: false,
      jump: true,
      pause: false,
    });

    expect(state.player.velocityY).toBe(-700);
    expect(state.player.grounded).toBe(false);
    expect(state.squashEvent).toBe("jump");
    expect(state.squashTimer).toBe(0.1);
  });

  it("records landing after an airborne transition", () => {
    let state = update(createInitialState(), 0.01, {
      left: false,
      right: false,
      jump: true,
      pause: false,
    });
    for (let step = 0; step < 100 && !state.player.grounded; step += 1) {
      state = update(state, 0.02);
    }
    expect(state.player.grounded).toBe(true);
    expect(state.squashEvent).toBe("land");
  });
});

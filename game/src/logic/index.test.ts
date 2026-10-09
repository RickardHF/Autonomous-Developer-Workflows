import { describe, expect, it } from "vitest";
import { createInitialState, update } from "./index.ts";

describe("game update", () => {
  it("advances state deterministically for fixed delta steps", () => {
    let state = createInitialState();

    for (let step = 0; step < 10; step += 1) {
      state = update(state, 0.25);
    }

    expect(state.elapsed).toBeCloseTo(2.5);
    expect(state.shapeX).toBeCloseTo(600);
    expect(state.shapeY).toBe(225);
    expect(state.velocityX).toBe(80);
  });

  it("reflects the placeholder shape at the horizontal bounds", () => {
    const state = update(createInitialState(), 5);

    expect(state.shapeX).toBe(640);
    expect(state.velocityX).toBe(-80);
  });
});

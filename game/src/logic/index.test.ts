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

  it("changes direction when left or right is pressed", () => {
    const movingLeft = update(createInitialState(), 0.25, {
      left: true,
      right: false,
      jump: false,
      pause: false,
    });
    const movingRight = update(movingLeft, 0.25, {
      left: false,
      right: true,
      jump: false,
      pause: false,
    });

    expect(movingLeft.velocityX).toBe(-80);
    expect(movingLeft.shapeX).toBe(380);
    expect(movingRight.velocityX).toBe(80);
    expect(movingRight.shapeX).toBe(400);
  });

  it("keeps the current direction when left and right are pressed together", () => {
    const movingLeft = update(createInitialState(), 0.25, {
      left: true,
      right: false,
      jump: false,
      pause: false,
    });
    const movingBoth = update(movingLeft, 0.25, {
      left: true,
      right: true,
      jump: false,
      pause: false,
    });

    expect(movingBoth.velocityX).toBe(-80);
    expect(movingBoth.shapeX).toBe(360);
  });

  it.each([
    { direction: "left", boundary: 80, velocity: -80 },
    { direction: "right", boundary: 720, velocity: 80 },
  ])("clamps held $direction input without boundary jitter", ({ direction, boundary, velocity }) => {
    const actions = {
      left: direction === "left",
      right: direction === "right",
      jump: false,
      pause: false,
    };
    let state = update(createInitialState(), 5, actions);

    for (let frame = 0; frame < 5; frame += 1) {
      expect(state.shapeX).toBe(boundary);
      expect(state.velocityX).toBe(velocity);
      state = update(state, 0.1, actions);
    }

    const reversed = update(state, 0.1, {
      ...actions,
      left: !actions.left,
      right: !actions.right,
    });
    expect(reversed.shapeX).toBe(boundary - velocity * 0.1);
    expect(reversed.velocityX).toBe(-velocity);

    const released = update(state, 0.1);
    expect(released.shapeX).toBe(boundary - velocity * 0.1);
    expect(released.velocityX).toBe(-velocity);
  });

  it("propagates jump input to the updated state", () => {
    const state = update(createInitialState(), 0.25, {
      left: false,
      right: false,
      jump: true,
      pause: false,
    });

    expect(state.jumpRequested).toBe(true);
  });

  it("pauses without advancing elapsed time or position", () => {
    const beforePause = update(createInitialState(), 0.25);
    const paused = update(beforePause, 1, {
      left: true,
      right: false,
      jump: true,
      pause: true,
    });

    expect(paused.elapsed).toBe(beforePause.elapsed);
    expect(paused.shapeX).toBe(beforePause.shapeX);
    expect(paused.shapeY).toBe(beforePause.shapeY);
    expect(paused.paused).toBe(true);
    expect(paused.jumpRequested).toBe(true);
  });
});

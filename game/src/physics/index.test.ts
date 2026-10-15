import { describe, expect, it } from "vitest";
import {
  applyGravity,
  applyHorizontalMovement,
  GRAVITY,
  JUMP_IMPULSE,
  MAX_SPEED,
  resolveCollisions,
  tryJump,
  type PlayerBody,
  type Rect,
} from "./index.ts";

const solid: Rect = { x: 100, y: 100, width: 100, height: 100 };
const body = (overrides: Partial<PlayerBody>): PlayerBody => ({
  x: 120,
  y: 0,
  width: 20,
  height: 20,
  velocityX: 0,
  velocityY: 0,
  grounded: false,
  ...overrides,
});

describe("physics", () => {
  it("accumulates gravity", () => {
    const player = body({});
    applyGravity(player, 0.1);
    applyGravity(player, 0.1);
    expect(player.velocityY).toBeCloseTo(GRAVITY * 0.2);
  });

  it("only jumps while grounded", () => {
    const player = body({ grounded: true });
    expect(tryJump(player, true)).toBe(true);
    expect(player.velocityY).toBe(JUMP_IMPULSE);
    expect(player.grounded).toBe(false);
    expect(tryJump(player, true)).toBe(false);
    expect(player.velocityY).toBe(JUMP_IMPULSE);
  });

  it("accelerates, caps speed, and decelerates", () => {
    const player = body({});
    applyHorizontalMovement(player, { left: false, right: true }, 1);
    expect(player.velocityX).toBe(MAX_SPEED);
    applyHorizontalMovement(player, { left: false, right: false }, 0.1);
    expect(player.velocityX).toBe(40);
    applyHorizontalMovement(player, { left: false, right: false }, 0.1);
    expect(player.velocityX).toBe(0);
  });

  it.each([
    ["top", body({ x: 120, y: 70, velocityY: 40 }), 120, 80, true],
    ["bottom", body({ x: 120, y: 110, velocityY: -40 }), 120, 200, false],
    ["left", body({ x: 70, y: 120, velocityX: 40 }), 80, 120, false],
    ["right", body({ x: 210, y: 120, velocityX: -40 }), 200, 120, false],
  ])("resolves approach from %s", (_name, player, expectedX, expectedY, grounded) => {
    resolveCollisions(player, [solid], 1);
    expect(player.x).toBe(expectedX);
    expect(player.y).toBe(expectedY);
    expect(player.grounded).toBe(grounded);
    expect(player.x + player.width <= solid.x || player.x >= solid.x + solid.width ||
      player.y + player.height <= solid.y || player.y >= solid.y + solid.height).toBe(true);
  });
});

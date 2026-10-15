import type { PlayerBody, Rect } from "../physics/index.ts";

export const TEST_LEVEL = {
  width: 800,
  height: 450,
  solids: [
    { x: 0, y: 400, width: 800, height: 50 },
    { x: 80, y: 300, width: 180, height: 22 },
    { x: 360, y: 220, width: 180, height: 22 },
    { x: 620, y: 270, width: 28, height: 130 },
  ] satisfies readonly Rect[],
  playerStart: {
    x: 375,
    y: 318,
    width: 50,
    height: 82,
    velocityX: 0,
    velocityY: 0,
    grounded: true,
  } satisfies PlayerBody,
} as const;

export type Level = typeof TEST_LEVEL;

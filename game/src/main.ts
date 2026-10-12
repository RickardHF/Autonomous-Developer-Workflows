import { createInitialState, update } from "./logic/index.ts";
import { PLACEHOLDER_COLOR, render } from "./render/index.ts";

const MAX_DELTA_SECONDS = 0.1;

export { PLACEHOLDER_COLOR };

export function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("The game canvas does not provide a 2D rendering context.");
  }

  render(context, createInitialState());
}

export function bootGame(documentRoot: Document): void {
  const canvas = documentRoot.querySelector<HTMLCanvasElement>("#game-canvas");

  if (canvas === null) {
    throw new Error("The game canvas element was not found.");
  }

  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("The game canvas does not provide a 2D rendering context.");
  }

  let state = createInitialState();
  let previousTimestamp: number | undefined;

  const loop = (timestamp: number): void => {
    const deltaSeconds =
      previousTimestamp === undefined
        ? 0
        : Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
    previousTimestamp = timestamp;
    state = update(state, deltaSeconds);
    render(context, state);
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

if (typeof document !== "undefined") {
  bootGame(document);
}

import { createInitialState, update, type GameActions } from "./logic/index.ts";
import { createInputController } from "./input/index.ts";
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

export function bootGame(documentRoot: Document): () => void {
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
  const input = createInputController(documentRoot.defaultView ?? documentRoot);
  let animationFrame: number | undefined;

  const loop = (timestamp: number): void => {
    const deltaSeconds =
      previousTimestamp === undefined
        ? 0
        : Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
    previousTimestamp = timestamp;
    const actions: GameActions = {
      left: input.isActionActive("left"),
      right: input.isActionActive("right"),
      jump: input.isActionActive("jump"),
      pause: input.isActionActive("pause"),
    };
    state = update(state, deltaSeconds, actions);
    render(context, state);
    animationFrame = requestAnimationFrame(loop);
  };

  animationFrame = requestAnimationFrame(loop);

  return (): void => {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    input.dispose();
  };
}

if (typeof document !== "undefined") {
  bootGame(document);
}

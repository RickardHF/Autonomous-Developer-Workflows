import { createInitialState, update, type GameActions } from "./logic/index.ts";
import { createInputController } from "./input/index.ts";
import { PLACEHOLDER_COLOR, render } from "./render/index.ts";
import "./styles.css";

const MAX_DELTA_SECONDS = 0.1;

export { PLACEHOLDER_COLOR };

export function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("The game canvas does not provide a 2D rendering context.");
  }

  render(context, createInitialState());
}

export function resizeCanvas(canvas: HTMLCanvasElement, pixelRatio: number): void {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));

  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
}

export function bootGame(documentRoot: Document): () => void {
  const canvas = documentRoot.querySelector<HTMLCanvasElement>("#game-canvas");

  if (canvas === null) {
    throw new Error("The game canvas element was not found.");
  }

  const pauseButton = documentRoot.querySelector<HTMLButtonElement>("#preview-toggle");

  if (pauseButton === null) {
    throw new Error("The preview pause control was not found.");
  }

  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("The game canvas does not provide a 2D rendering context.");
  }

  const windowRoot = documentRoot.defaultView;
  if (windowRoot === null) {
    throw new Error("The game document does not have a browser window.");
  }

  const motionPreference = windowRoot.matchMedia("(prefers-reduced-motion: reduce)");
  let state = createInitialState();
  let paused = false;
  let previousTimestamp: number | undefined;
  let frameId: number;
  const input = createInputController(canvas);

  const updatePauseButton = (): void => {
    pauseButton.textContent = paused ? "Resume animation" : "Pause animation";
    pauseButton.setAttribute("aria-pressed", String(paused));
  };
  const togglePaused = (): void => {
    paused = !paused;
    updatePauseButton();
  };
  const handlePauseButtonClick = (): void => {
    togglePaused();
  };
  pauseButton.addEventListener("click", handlePauseButtonClick);

  const draw = (): void => {
    render(context, state, { reducedMotion: motionPreference.matches });
  };

  const resize = (): void => {
    resizeCanvas(canvas, windowRoot.devicePixelRatio);
    draw();
  };

  const loop = (timestamp: number): void => {
    const deltaSeconds =
      previousTimestamp === undefined
        ? 0
        : Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
    previousTimestamp = timestamp;
    if (input.consumeActionPress("pause")) {
      togglePaused();
    }
    const actions: GameActions = {
      left: input.isActionActive("left"),
      right: input.isActionActive("right"),
      jump: input.isActionActive("jump"),
      pause: paused,
    };
    state = update(state, deltaSeconds, actions);
    draw();
    frameId = windowRoot.requestAnimationFrame(loop);
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  windowRoot.addEventListener("resize", resize);
  resize();
  frameId = windowRoot.requestAnimationFrame(loop);

  return (): void => {
    windowRoot.cancelAnimationFrame(frameId);
    windowRoot.removeEventListener("resize", resize);
    resizeObserver.disconnect();
    input.dispose();
    pauseButton.removeEventListener("click", handlePauseButtonClick);
  };
}

if (typeof document !== "undefined") {
  bootGame(document);
}

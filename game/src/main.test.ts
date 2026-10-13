import { afterEach, describe, expect, it, vi } from "vitest";
import { bootGame, drawPlaceholder, PLACEHOLDER_COLOR, resizeCanvas } from "./main.ts";
import { createInitialState } from "./logic/index.ts";
import { render, SCENE_BACKGROUND } from "./render/index.ts";

vi.mock("./render/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render/index.ts")>();
  return { ...actual, render: vi.fn() };
});

function createBrowser() {
  const context = {};
  const bounds = { width: 640, height: 360 };
  let width = 800;
  let height = 450;
  const canvasHandlers = new Map<string, (event: Event) => void>();
  const windowHandlers = new Map<string, (event: Event) => void>();
  let onPauseClick: (() => void) | undefined;
  const element = {
    tabIndex: 0,
    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      height = value;
    },
    getContext: vi.fn(() => context),
    getBoundingClientRect: vi.fn(() => bounds),
    addEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
      canvasHandlers.set(type, handler);
    }),
    removeEventListener: vi.fn(),
  };
  const canvas = element as unknown as HTMLCanvasElement;
  const pauseButton = {
    textContent: "Pause animation",
    addEventListener: vi.fn((_type: string, handler: () => void) => {
      onPauseClick = handler;
    }),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
  } as unknown as HTMLButtonElement;
  const preference = { matches: false };
  const requestAnimationFrame = vi.fn((_callback: FrameRequestCallback) => 1);
  const windowRoot = {
    devicePixelRatio: 2,
    matchMedia: vi.fn(() => preference),
    requestAnimationFrame,
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
      windowHandlers.set(type, handler);
    }),
    press(type: "keydown" | "keyup", code: string) {
      windowHandlers.get(type)?.({ code, repeat: false, preventDefault: vi.fn() } as unknown as Event);
    },
    removeEventListener: vi.fn(),
  };
  const root = {
    querySelector: vi.fn((selector: string) =>
      selector === "#game-canvas" ? canvas : pauseButton,
    ),
    defaultView: windowRoot,
  };
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  let onResize: (() => void) | undefined;
  const ResizeObserverMock = vi.fn(function (callback: () => void) {
    onResize = callback;
    return observer;
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  return {
    canvas, context, element, bounds, preference, windowRoot, observer, pauseButton,
    documentRoot: root as unknown as Document,
    pressCanvas(type: "keydown" | "keyup", code: string) {
      canvasHandlers.get(type)?.({ code, repeat: false, preventDefault: vi.fn() } as unknown as Event);
    },
    clickPause: () => onPauseClick?.(),
    triggerResize: () => onResize?.(),
    frame: (timestamp: number) => {
      const callback = requestAnimationFrame.mock.lastCall?.[0];
      if (callback === undefined) {
        throw new Error("The test game has not scheduled an animation frame.");
      }
      callback(timestamp);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("game preview", () => {
  it("preserves the exported initial drawing helper and background alias", () => {
    const { canvas, context } = createBrowser();

    drawPlaceholder(canvas);

    expect(render).toHaveBeenCalledWith(context, createInitialState());
    expect(PLACEHOLDER_COLOR).toBe(SCENE_BACKGROUND);
  });

  it("draws immediately at display resolution and observes canvas resizing", () => {
    const { documentRoot, canvas, context, windowRoot, observer, pauseButton } = createBrowser();

    const stop = bootGame(documentRoot);

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(render).toHaveBeenCalledWith(context, createInitialState(), { reducedMotion: false });
    expect(windowRoot.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(observer.observe).toHaveBeenCalledWith(canvas);
    expect(canvas.tabIndex).toBe(0);
    expect(windowRoot.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(windowRoot.addEventListener).not.toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(pauseButton.textContent).toBe("Pause animation");
    expect(windowRoot.requestAnimationFrame).toHaveBeenCalledOnce();
    stop();
  });

  it("retains deterministic movement and the maximum frame delta", () => {
    const { documentRoot, context, frame } = createBrowser();
    const stop = bootGame(documentRoot);

    frame(0);
    frame(1000);

    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ elapsed: 0.1, shapeX: 408, shapeY: 225, velocityX: 80 }),
      { reducedMotion: false },
    );
    stop();
  });

  it("repaints resized buffers without resetting the simulation", () => {
    const { documentRoot, canvas, context, bounds, windowRoot, triggerResize, frame } = createBrowser();
    const stop = bootGame(documentRoot);
    frame(0);
    frame(100);
    bounds.width = 320;
    bounds.height = 180;
    windowRoot.devicePixelRatio = 3;

    triggerResize();

    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ elapsed: 0.1, shapeX: 408, shapeY: 225, velocityX: 80 }),
      { reducedMotion: false },
    );
    stop();
  });

  it("picks up changes in reduced-motion preference without changing movement", () => {
    const { documentRoot, context, preference, frame } = createBrowser();
    preference.matches = true;
    const stop = bootGame(documentRoot);
    frame(0);
    frame(100);

    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ elapsed: 0.1, shapeX: 408, shapeY: 225, velocityX: 80 }),
      { reducedMotion: true },
    );
    preference.matches = false;
    frame(200);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ elapsed: 0.2, shapeX: 416, shapeY: 225, velocityX: 80 }),
      { reducedMotion: false },
    );
    stop();
  });

  it("disconnects observers and cancels the pending frame on cleanup", () => {
    const { documentRoot, windowRoot, observer, pauseButton, element } = createBrowser();
    const stop = bootGame(documentRoot);

    stop();

    expect(windowRoot.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(windowRoot.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(element.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(pauseButton.removeEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("reports missing canvas, context, or browser window explicitly", () => {
    const missingCanvas = { querySelector: () => null } as unknown as Document;
    expect(() => bootGame(missingCanvas)).toThrow("The game canvas element was not found.");

    const missingContext = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => drawPlaceholder(missingContext)).toThrow("does not provide a 2D rendering context");
    expect(() => bootGame({
      querySelector: () => missingContext,
    } as unknown as Document)).toThrow("does not provide a 2D rendering context");

    const { canvas } = createBrowser();
    expect(() => bootGame({
      querySelector: () => canvas,
      defaultView: null,
    } as unknown as Document)).toThrow("does not have a browser window");
  });
});

describe("canvas sizing", () => {
  it("rounds fractional display dimensions at the current pixel ratio", () => {
    const { canvas, bounds } = createBrowser();
    bounds.width = 343.5;
    bounds.height = 193.21875;

    resizeCanvas(canvas, 1.5);

    expect(canvas.width).toBe(515);
    expect(canvas.height).toBe(290);
  });

  it("avoids resetting an already correctly sized backing buffer", () => {
    const { canvas } = createBrowser();
    canvas.width = 1280;
    canvas.height = 720;
    const widthSetter = vi.spyOn(canvas, "width", "set");
    const heightSetter = vi.spyOn(canvas, "height", "set");

    resizeCanvas(canvas, 2);

    expect(widthSetter).not.toHaveBeenCalled();
    expect(heightSetter).not.toHaveBeenCalled();
  });

  it("passes keyboard actions through the game loop and tears it down", () => {
    const { documentRoot, context, windowRoot, frame, pressCanvas, clickPause, pauseButton } =
      createBrowser();
    const stop = bootGame(documentRoot);
    frame(1000);

    windowRoot.press("keydown", "ArrowRight");
    windowRoot.press("keydown", "Space");
    frame(1025);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 402, jumpRequested: false }),
      { reducedMotion: false },
    );

    pressCanvas("keydown", "ArrowRight");
    pressCanvas("keydown", "Space");
    frame(1050);

    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, jumpRequested: true }),
      { reducedMotion: false },
    );

    pressCanvas("keydown", "KeyP");
    frame(1100);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, paused: true }),
      { reducedMotion: false },
    );
    expect(pauseButton.textContent).toBe("Resume animation");
    expect(pauseButton.setAttribute).toHaveBeenLastCalledWith("aria-pressed", "true");

    clickPause();
    expect(pauseButton.textContent).toBe("Pause animation");
    expect(pauseButton.setAttribute).toHaveBeenLastCalledWith("aria-pressed", "false");
    frame(1150);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 408, paused: false }),
      { reducedMotion: false },
    );

    clickPause();
    frame(1200);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 408, paused: true }),
      { reducedMotion: false },
    );
    expect(pauseButton.textContent).toBe("Resume animation");
    expect(pauseButton.setAttribute).toHaveBeenLastCalledWith("aria-pressed", "true");

    stop();
  });
});

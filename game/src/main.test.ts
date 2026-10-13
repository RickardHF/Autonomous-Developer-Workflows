import { afterEach, describe, expect, it, vi } from "vitest";
import * as logic from "./logic/index.ts";
import { bootGame, PLACEHOLDER_COLOR } from "./main.ts";
import * as renderer from "./render/index.ts";

function dispatchKey(
  target: EventTarget,
  type: "keydown" | "keyup",
  code: string,
  repeat = false,
): void {
  const event = new Event(type);
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: repeat });
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("game scaffold", () => {
  it("exposes the placeholder canvas color", () => {
    expect(PLACEHOLDER_COLOR).toBe("#7dd3fc");
  });

  it("passes keyboard actions through the game loop and tears it down", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      callbacks.set(id, callback);
      return id;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const target = new EventTarget();
    const removeListener = vi.spyOn(target, "removeEventListener");
    const context = {
      canvas: { width: 800, height: 450 },
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const documentRoot = {
      defaultView: target,
      querySelector: vi.fn(() => canvas),
    } as unknown as Document;
    const update = vi.spyOn(logic, "update");
    const render = vi.spyOn(renderer, "render");

    const dispose = bootGame(documentRoot);
    callbacks.get(1)?.(1000);

    dispatchKey(target, "keydown", "ArrowRight");
    dispatchKey(target, "keydown", "Space");
    callbacks.get(2)?.(1050);

    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ shapeX: 400 }),
      0.05,
      { left: false, right: true, jump: true, pause: false },
    );
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, jumpRequested: true }),
    );

    dispatchKey(target, "keydown", "KeyP");
    callbacks.get(3)?.(1100);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, elapsed: 0.05, paused: true }),
    );

    dispatchKey(target, "keydown", "KeyP", true);
    callbacks.get(4)?.(1150);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, elapsed: 0.05, paused: true }),
    );

    dispatchKey(target, "keyup", "KeyP");
    callbacks.get(5)?.(1200);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, elapsed: 0.05, paused: true }),
    );

    target.dispatchEvent(new Event("blur"));
    dispatchKey(target, "keydown", "KeyP");
    dispatchKey(target, "keyup", "KeyP");
    callbacks.get(6)?.(1250);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: true }),
      0.05,
      { left: false, right: false, jump: false, pause: false },
    );
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        shapeX: 408,
        elapsed: 0.1,
        jumpRequested: false,
        paused: false,
      }),
    );

    dispatchKey(target, "keydown", "ArrowLeft");
    callbacks.get(7)?.(1300);
    expect(render).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ shapeX: 404, velocityX: -80 }),
    );

    dispose();

    expect(cancelFrame).toHaveBeenCalledWith(8);
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("keyup", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("blur", expect.any(Function));
  });
});

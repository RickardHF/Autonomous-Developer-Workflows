import { afterEach, describe, expect, it, vi } from "vitest";
import * as logic from "./logic/index.ts";
import { bootGame, PLACEHOLDER_COLOR } from "./main.ts";
import * as renderer from "./render/index.ts";

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

    const rightDown = new Event("keydown");
    Object.defineProperty(rightDown, "code", { value: "ArrowRight" });
    target.dispatchEvent(rightDown);
    const jumpDown = new Event("keydown");
    Object.defineProperty(jumpDown, "code", { value: "Space" });
    target.dispatchEvent(jumpDown);
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

    dispose();

    expect(cancelFrame).toHaveBeenCalledWith(3);
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("keyup", expect.any(Function));
  });
});

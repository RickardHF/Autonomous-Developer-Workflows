import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../logic/index.ts";
import { PLACEHOLDER_COLOR, render } from "./index.ts";

describe("render", () => {
  it("draws the background, placeholder shape, and message", () => {
    const context = {
      canvas: { width: 800, height: 450 },
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      fillStyle: "",
      font: "",
      textAlign: "",
      textBaseline: "",
    } as unknown as CanvasRenderingContext2D;

    render(context, createInitialState());

    expect(context.fillStyle).toBe("#172554");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 800, 450);
    expect(context.ellipse).toHaveBeenCalledWith(400, 225, 42, 32, 0, 0, Math.PI * 2);
    expect(context.fillText).toHaveBeenCalledWith(
      "McSquishy is getting ready!",
      400,
      225,
    );
    expect(PLACEHOLDER_COLOR).toBe("#7dd3fc");
  });
});

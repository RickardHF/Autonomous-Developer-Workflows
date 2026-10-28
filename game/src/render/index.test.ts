import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../logic/index.ts";
import {
  PLACEHOLDER_COLOR,
  SCENE_BACKGROUND,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  render,
} from "./index.ts";

function createContext(width = SCENE_WIDTH, height = SCENE_HEIGHT) {
  const addColorStop = vi.fn();
  const drawing = {
    canvas: { width, height },
    createLinearGradient: vi.fn(() => ({ addColorStop })),
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    roundRect: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
  };
  return {
    drawing,
    addColorStop,
    context: drawing as unknown as CanvasRenderingContext2D,
  };
}

describe("render", () => {
  it("draws a layered meadow and expressive blob without placeholder text", () => {
    const { context, drawing, addColorStop } = createContext();
    render(context, createInitialState());

    expect(drawing.fillRect).toHaveBeenCalledWith(0, 0, 800, 450);
    expect(addColorStop).toHaveBeenCalledWith(0, SCENE_BACKGROUND);
    expect(addColorStop).toHaveBeenCalledWith(0.55, "#f58b7e");
    expect(drawing.bezierCurveTo).toHaveBeenCalled();
    expect(drawing.roundRect).toHaveBeenCalledWith(80, 300, 180, 22, 12);
    expect(drawing.translate).toHaveBeenCalledWith(400, 359);
    expect(drawing.ellipse).toHaveBeenCalledWith(-13, 3, 4.3, 6.3, 0, 0, Math.PI * 2);
    expect(drawing.quadraticCurveTo).toHaveBeenCalledWith(0, 20, 5, 14);
    expect(drawing.fillText).not.toHaveBeenCalled();
    expect(drawing.save.mock.calls.length).toBe(drawing.restore.mock.calls.length);
    expect(PLACEHOLDER_COLOR).toBe(SCENE_BACKGROUND);
  });

  it("uses logical coordinates and resets rather than accumulating DPI transforms", () => {
    const { context, drawing } = createContext(1600, 900);
    const state = Object.freeze(createInitialState());

    render(context, state);
    render(context, state);

    expect(drawing.setTransform.mock.calls).toEqual([
      [2, 0, 0, 2, 0, 0],
      [2, 0, 0, 2, 0, 0],
    ]);
    expect(drawing.translate).toHaveBeenCalledWith(400, 359);
    expect(state).toEqual(createInitialState());
  });

  it("adds time-based bobbing and squash without changing the state's position", () => {
    const { context, drawing } = createContext();
    const state = {
      ...createInitialState(),
      elapsed: 0.5,
      player: { ...createInitialState().player, x: 487 },
    };
    const wobble = Math.sin(1.5);

    render(context, state);

    expect(drawing.translate).toHaveBeenCalledWith(512, 359 + wobble * 2.5);
    expect(drawing.scale).toHaveBeenCalledWith(1 + wobble * 0.035, 1 - wobble * 0.045);
    expect(state.player.x).toBe(487);
    expect(state.player.y).toBe(318);
  });

  it("freezes decorative motion and blinking under reduced motion", () => {
    const first = createContext();
    const second = createContext();

    render(first.context, { ...createInitialState(), elapsed: 5.5 }, { reducedMotion: true });
    render(second.context, { ...createInitialState(), elapsed: 19 }, { reducedMotion: true });

    expect(first.drawing.translate.mock.calls).toEqual(second.drawing.translate.mock.calls);
    expect(first.drawing.scale.mock.calls).toEqual(second.drawing.scale.mock.calls);
    expect(first.drawing.ellipse.mock.calls).toEqual(second.drawing.ellipse.mock.calls);
    expect(first.drawing.translate).toHaveBeenCalledWith(400, 359);
    expect(first.drawing.scale).toHaveBeenCalledWith(1, 1);
    expect(first.drawing.ellipse).toHaveBeenCalledWith(-13, 3, 4.3, 6.3, 0, 0, Math.PI * 2);
  });

  it("keeps the current position and faces the movement direction under reduced motion", () => {
    const { context, drawing } = createContext();

    render(context, {
      ...createInitialState(),
      player: { ...createInitialState().player, x: 55, velocityX: -80 },
    }, { reducedMotion: true });

    expect(drawing.translate).toHaveBeenCalledWith(80, 359);
    expect(drawing.translate).toHaveBeenLastCalledWith(-4, 0);
  });

  it("draws a brief blink during the animation cycle", () => {
    const { context, drawing } = createContext();

    render(context, { ...createInitialState(), elapsed: 5.5 });

    expect(drawing.lineTo).toHaveBeenCalledWith(-10, 4);
    expect(drawing.lineTo).toHaveBeenCalledWith(16, 4);
    expect(drawing.ellipse).not.toHaveBeenCalledWith(-13, 3, 4.3, 6.3, 0, 0, Math.PI * 2);
  });
});

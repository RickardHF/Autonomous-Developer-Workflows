import type { GameState } from "../logic/index.ts";

export const PLACEHOLDER_COLOR = "#7dd3fc";
const SHAPE_COLOR = "#f97316";
const TEXT_COLOR = "#172554";

export function render(context: CanvasRenderingContext2D, state: GameState): void {
  const { width, height } = context.canvas;

  context.fillStyle = PLACEHOLDER_COLOR;
  context.fillRect(0, 0, width, height);

  context.fillStyle = SHAPE_COLOR;
  context.beginPath();
  context.ellipse(state.shapeX, state.shapeY, 42, 32, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = TEXT_COLOR;
  context.font = "24px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("McSquishy is getting ready!", width / 2, height / 2);
}

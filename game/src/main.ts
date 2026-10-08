export const PLACEHOLDER_COLOR = "#7dd3fc";

export function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("The game canvas does not provide a 2D rendering context.");
  }

  context.fillStyle = PLACEHOLDER_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#172554";
  context.font = "24px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("McSquishy is getting ready!", canvas.width / 2, canvas.height / 2);
}

export function bootGame(documentRoot: Document): void {
  const canvas = documentRoot.querySelector<HTMLCanvasElement>("#game-canvas");

  if (canvas === null) {
    throw new Error("The game canvas element was not found.");
  }

  drawPlaceholder(canvas);
}

if (typeof document !== "undefined") {
  bootGame(document);
}

import type { GameState } from "../logic/index.ts";
import { TEST_LEVEL } from "../levels/index.ts";

export const SCENE_WIDTH = 800;
export const SCENE_HEIGHT = 450;
export const SCENE_BACKGROUND = "#fff5e9";
export const PLACEHOLDER_COLOR = SCENE_BACKGROUND;

export interface RenderOptions {
  reducedMotion?: boolean;
}

function ellipse(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  color: string,
  rotation = 0,
): void {
  context.fillStyle = color;
  context.beginPath();
  context.ellipse(x, y, radiusX, radiusY, rotation, 0, Math.PI * 2);
  context.fill();
}

function cloud(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  ellipse(context, 0, 6, 42, 13, "#ffffffb8");
  ellipse(context, -16, 0, 17, 15, "#ffffffb8");
  ellipse(context, 7, -6, 22, 21, "#fffdf8");
  ellipse(context, 28, 4, 18, 12, "#fffdf8");
  context.restore();
}

function drawSky(context: CanvasRenderingContext2D, time: number): void {
  const sky = context.createLinearGradient(0, 0, 0, 290);
  sky.addColorStop(0, SCENE_BACKGROUND);
  sky.addColorStop(1, "#eae7f4");
  context.fillStyle = sky;
  context.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);

  ellipse(context, 652, 80, 57, 57, "#f5ddbc30");
  ellipse(context, 652, 80, 43, 43, "#f5ddbc45");
  ellipse(context, 652, 80, 30, 30, "#f5d7a6");
  ellipse(context, 644, 72, 22, 22, "#f9e2bb");

  cloud(context, 151 + Math.sin(time * 0.18) * 5, 63, 0.85);
  cloud(context, 399 + Math.sin(time * 0.15 + 2) * 7, 92, 1.1);
  cloud(context, 744 + Math.sin(time * 0.2 + 1) * 4, 136, 0.6);
  cloud(context, 53, 139, 0.42);

  context.fillStyle = "#d9d1e9";
  context.beginPath();
  context.moveTo(0, 245);
  context.bezierCurveTo(45, 245, 66, 130, 128, 138);
  context.bezierCurveTo(197, 143, 221, 245, 297, 241);
  context.bezierCurveTo(380, 239, 413, 137, 490, 151);
  context.bezierCurveTo(559, 161, 576, 224, 626, 219);
  context.bezierCurveTo(703, 217, 731, 163, 800, 184);
  context.lineTo(800, 320);
  context.lineTo(0, 320);
  context.closePath();
  context.fill();

  context.fillStyle = "#c6bedc";
  context.beginPath();
  context.moveTo(0, 273);
  context.bezierCurveTo(100, 239, 181, 176, 239, 200);
  context.bezierCurveTo(301, 225, 319, 256, 373, 261);
  context.bezierCurveTo(454, 268, 506, 197, 575, 210);
  context.bezierCurveTo(663, 226, 695, 258, 800, 235);
  context.lineTo(800, 340);
  context.lineTo(0, 340);
  context.closePath();
  context.fill();

  context.fillStyle = "#b6d8c7";
  context.beginPath();
  context.moveTo(0, 284);
  context.bezierCurveTo(114, 234, 180, 271, 292, 277);
  context.bezierCurveTo(400, 292, 433, 240, 527, 263);
  context.bezierCurveTo(638, 290, 716, 237, 800, 252);
  context.lineTo(800, 355);
  context.lineTo(0, 355);
  context.closePath();
  context.fill();
}

function platform(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height = 31,
): void {
  context.fillStyle = "#92809b12";
  context.beginPath();
  context.roundRect(x + 6, y + 10, width, 32, 13);
  context.fill();
  context.fillStyle = "#dfc4ac";
  context.beginPath();
  context.roundRect(x, y, width, height, 12);
  context.fill();
  context.fillStyle = "#a7cfb8";
  context.beginPath();
  context.roundRect(x - 3, y - 5, width + 6, 14, 7);
  context.fill();
  context.fillStyle = "#c9e7cf";
  context.beginPath();
  context.roundRect(x, y - 5, width, 5, 3);
  context.fill();
  ellipse(context, x + 23, y + 19, 3, 2, "#c0a58e");
  ellipse(context, x + width - 25, y + 20, 6, 2, "#c0a58e");
}

function sprig(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(0, 0);
  context.quadraticCurveTo(-3, -16, 1, -32);
  context.stroke();
  ellipse(context, -7, -13, 9, 4, color, 0.6);
  ellipse(context, 6, -23, 9, 4, color, -0.6);
  ellipse(context, 1, -34, 4, 7, color, 0.1);
  context.restore();
}

function flower(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.strokeStyle = "#739c80";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, 0);
  context.quadraticCurveTo(4, -9, 0, -20);
  context.stroke();
  ellipse(context, 5, -8, 6, 2.5, "#739c80", -0.6);
  for (let petal = 0; petal < 5; petal += 1) {
    const angle = (petal * Math.PI * 2) / 5 - Math.PI / 2;
    ellipse(context, Math.cos(angle) * 5, -24 + Math.sin(angle) * 5, 4, 4, color);
  }
  ellipse(context, 0, -24, 2.8, 2.8, "#f8d99c");
  context.restore();
}

function drawMeadow(context: CanvasRenderingContext2D): void {
  for (const solid of TEST_LEVEL.solids) {
    platform(context, solid.x, solid.y, solid.width, solid.height);
  }
  sprig(context, 96, 163, 0.42, "#7ca88a");
  flower(context, 689, 172, 0.55, "#fff8ec");

  const soil = context.createLinearGradient(0, 270, 0, SCENE_HEIGHT);
  soil.addColorStop(0, "#edcfaf");
  soil.addColorStop(1, "#f3dec2");
  context.fillStyle = soil;
  context.fillRect(0, 270, SCENE_WIDTH, 180);
  context.fillStyle = "#a8ceb1";
  context.fillRect(0, 267, SCENE_WIDTH, 13);
  context.fillStyle = "#d7e8bd";
  context.fillRect(0, 267, SCENE_WIDTH, 5);

  context.strokeStyle = "#dcb99855";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, 311);
  context.bezierCurveTo(155, 288, 226, 341, 399, 316);
  context.bezierCurveTo(563, 292, 654, 329, 800, 297);
  context.moveTo(0, 351);
  context.bezierCurveTo(200, 334, 275, 369, 478, 341);
  context.bezierCurveTo(651, 317, 725, 354, 800, 336);
  context.stroke();

  const stones: [number, number, number][] = [
    [122, 304, 3], [257, 322, 4], [380, 291, 2],
    [506, 327, 3], [687, 309, 4], [746, 347, 2],
  ];
  for (const [x, y, radius] of stones) {
    ellipse(context, x, y, radius, 1.5, "#c3a78b60");
  }

  sprig(context, 31, 267, 0.85, "#6d9b80");
  sprig(context, 765, 267, 0.7, "#6d9b80");
  flower(context, 54, 267, 0.62, "#fff8ef");
  flower(context, 742, 267, 0.7, "#f5a295");

  context.fillStyle = "#b5d1ac";
  context.beginPath();
  context.moveTo(0, 374);
  context.bezierCurveTo(156, 325, 218, 443, 390, 403);
  context.bezierCurveTo(559, 360, 639, 336, 800, 378);
  context.lineTo(800, 450);
  context.lineTo(0, 450);
  context.closePath();
  context.fill();

  context.fillStyle = "#93b998";
  context.beginPath();
  context.moveTo(0, 419);
  context.bezierCurveTo(149, 351, 260, 426, 423, 432);
  context.bezierCurveTo(616, 440, 678, 358, 800, 414);
  context.lineTo(800, 450);
  context.lineTo(0, 450);
  context.closePath();
  context.fill();

  sprig(context, 85, 409, 1.35, "#6b977b");
  sprig(context, 709, 398, 1.1, "#6b977b");
  flower(context, 130, 405, 0.85, "#fff6e6");
  flower(context, 663, 403, 0.72, "#f3b0a0");
  flower(context, 689, 412, 0.95, "#fff6e6");
  ellipse(context, 231, 411, 14, 6, "#82a989", -0.1);
  ellipse(context, 565, 416, 11, 5, "#82a989", 0.1);
}

function drawBlob(
  context: CanvasRenderingContext2D,
  state: GameState,
  time: number,
  reducedMotion: boolean,
): void {
  const wobble = Math.sin(time * 3);
  const bob = Math.sin(time * 3) * 2.5;
  const { player } = state;
  const centerX = player.x + player.width / 2;
  const centerY = player.y + player.height / 2;
  const facing = player.velocityX < 0 ? -1 : 1;
  const reaction = state.squashTimer > 0 && state.squashEvent !== null
    ? state.squashTimer / 0.1
    : 0;
  const reactionX = state.squashEvent === "jump" ? 1 - reaction * 0.16 : 1 + reaction * 0.2;
  const reactionY = state.squashEvent === "jump" ? 1 + reaction * 0.2 : 1 - reaction * 0.16;

  ellipse(context, centerX, player.y + player.height + 5, 39 - bob, 6, "#5a5f5630");
  ellipse(context, centerX, player.y + player.height + 5, 26, 3, "#5a5f5620");
  context.save();
  context.translate(centerX, centerY + bob);
  context.scale((1 + wobble * 0.035) * reactionX, (1 - wobble * 0.045) * reactionY);

  const jelly = context.createLinearGradient(-20, -40, 24, 36);
  jelly.addColorStop(0, "#ffb29b");
  jelly.addColorStop(0.55, "#f58b7e");
  jelly.addColorStop(1, "#dd706e");
  context.fillStyle = jelly;
  context.strokeStyle = "#ce68695c";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(0, -41);
  context.bezierCurveTo(-26, -44, -37, -24, -43, -3);
  context.bezierCurveTo(-51, 22, -47, 38, -28, 37);
  context.bezierCurveTo(-18, 36, -10, 33, 0, 36);
  context.bezierCurveTo(15, 41, 22, 34, 32, 36);
  context.bezierCurveTo(49, 40, 51, 23, 44, 1);
  context.bezierCurveTo(37, -22, 27, -39, 0, -41);
  context.closePath();
  context.fill();
  context.stroke();

  ellipse(context, -21, -23, 13, 6, "#ffe4c5b3", -0.75);
  ellipse(context, -31, -9, 3.5, 5, "#ffe4c570", 0.15);
  ellipse(context, 28, 25, 10, 4, "#ca626833", -0.4);
  context.translate(facing * 4, 0);
  ellipse(context, -22, 14, 8, 4.5, "#e967754d");
  ellipse(context, 22, 14, 8, 4.5, "#e967754d");

  const blinking = !reducedMotion && time % 5.6 > 5.43;
  if (blinking) {
    context.strokeStyle = "#393044";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(-16, 4);
    context.lineTo(-10, 4);
    context.moveTo(10, 4);
    context.lineTo(16, 4);
    context.stroke();
  } else {
    ellipse(context, -13, 3, 4.3, 6.3, "#393044");
    ellipse(context, 13, 3, 4.3, 6.3, "#393044");
    ellipse(context, -14, 1, 1.4, 1.8, "#fffcf3");
    ellipse(context, 12, 1, 1.4, 1.8, "#fffcf3");
  }

  context.strokeStyle = "#713c4a";
  context.lineWidth = 2.4;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(-5, 14);
  context.quadraticCurveTo(0, 20, 5, 14);
  context.stroke();
  context.restore();
}

export function render(
  context: CanvasRenderingContext2D,
  state: GameState,
  options: RenderOptions = {},
): void {
  context.setTransform(
    context.canvas.width / SCENE_WIDTH,
    0,
    0,
    context.canvas.height / SCENE_HEIGHT,
    0,
    0,
  );
  const reducedMotion = options.reducedMotion ?? false;
  const time = reducedMotion ? 0 : state.elapsed;
  drawSky(context, time);
  drawMeadow(context);
  drawBlob(context, state, time, reducedMotion);
}

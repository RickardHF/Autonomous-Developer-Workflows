export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerBody extends Rect {
  velocityX: number;
  velocityY: number;
  grounded: boolean;
}

export interface HorizontalActions {
  left: boolean;
  right: boolean;
}

export const GRAVITY = 1800;
export const JUMP_IMPULSE = -700;
export const MAX_SPEED = 320;
export const HORIZONTAL_ACCELERATION = 2400;
export const HORIZONTAL_DECELERATION = 2800;

export function applyGravity(body: PlayerBody, deltaSeconds: number): void {
  body.velocityY += GRAVITY * deltaSeconds;
}

export function applyHorizontalMovement(
  body: PlayerBody,
  actions: HorizontalActions,
  deltaSeconds: number,
): void {
  const direction = Number(actions.right) - Number(actions.left);
  if (direction !== 0) {
    body.velocityX = Math.max(
      -MAX_SPEED,
      Math.min(MAX_SPEED, body.velocityX + direction * HORIZONTAL_ACCELERATION * deltaSeconds),
    );
    return;
  }

  const amount = HORIZONTAL_DECELERATION * deltaSeconds;
  if (Math.abs(body.velocityX) <= amount) {
    body.velocityX = 0;
  } else {
    body.velocityX -= Math.sign(body.velocityX) * amount;
  }
}

export function tryJump(body: PlayerBody, jumpPressed: boolean): boolean {
  if (!jumpPressed || !body.grounded) {
    return false;
  }

  body.velocityY = JUMP_IMPULSE;
  body.grounded = false;
  return true;
}

function overlapsOnAxis(
  firstStart: number,
  firstSize: number,
  secondStart: number,
  secondSize: number,
): boolean {
  return firstStart < secondStart + secondSize && firstStart + firstSize > secondStart;
}

function crossedBoundary(
  previousStart: number,
  currentStart: number,
  size: number,
  boundary: number,
): boolean {
  return (
    (previousStart + size <= boundary && currentStart + size >= boundary) ||
    (previousStart >= boundary && currentStart <= boundary)
  );
}

export function resolveCollisions(
  body: PlayerBody,
  solids: readonly Rect[],
  deltaSeconds = 1,
): void {
  const previousX = body.x;
  body.x += body.velocityX * deltaSeconds;
  for (const solid of solids) {
    if (body.velocityX === 0) {
      continue;
    }
    const crossedX = crossedBoundary(previousX, body.x, body.width, solid.x) ||
      crossedBoundary(previousX, body.x, body.width, solid.x + solid.width);
    if (
      !overlapsOnAxis(body.y, body.height, solid.y, solid.height) ||
      (!overlapsOnAxis(body.x, body.width, solid.x, solid.width) && !crossedX)
    ) {
      continue;
    }
    if (body.velocityX > 0) {
      body.x = solid.x - body.width;
    } else {
      body.x = solid.x + solid.width;
    }
    body.velocityX = 0;
  }

  const previousY = body.y;
  body.grounded = false;
  body.y += body.velocityY * deltaSeconds;
  for (const solid of solids) {
    const crossedY = crossedBoundary(previousY, body.y, body.height, solid.y) ||
      crossedBoundary(previousY, body.y, body.height, solid.y + solid.height);
    if (
      !overlapsOnAxis(body.x, body.width, solid.x, solid.width) ||
      (!overlapsOnAxis(body.y, body.height, solid.y, solid.height) && !crossedY)
    ) {
      continue;
    }
    if (body.velocityY > 0 || (body.velocityY === 0 && previousY < solid.y)) {
      body.y = solid.y - body.height;
      body.grounded = true;
    } else {
      body.y = solid.y + solid.height;
    }
    body.velocityY = 0;
  }
}

export function stepBody(
  body: PlayerBody,
  actions: HorizontalActions,
  jumpPressed: boolean,
  deltaSeconds: number,
  solids: readonly Rect[],
): boolean {
  applyGravity(body, deltaSeconds);
  applyHorizontalMovement(body, actions, deltaSeconds);
  const jumped = tryJump(body, jumpPressed);
  resolveCollisions(body, solids, deltaSeconds);
  return jumped;
}

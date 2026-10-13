export interface GameState {
  elapsed: number;
  shapeX: number;
  shapeY: number;
  velocityX: number;
  jumpRequested: boolean;
  paused: boolean;
}

export interface GameActions {
  left: boolean;
  right: boolean;
  jump: boolean;
  pause: boolean;
}

const SHAPE_MIN_X = 80;
const SHAPE_MAX_X = 720;

export function createInitialState(): GameState {
  return {
    elapsed: 0,
    shapeX: 400,
    shapeY: 225,
    velocityX: 80,
    jumpRequested: false,
    paused: false,
  };
}

export function update(
  state: GameState,
  deltaSeconds: number,
  actions: GameActions = {
    left: false,
    right: false,
    jump: false,
    pause: false,
  },
): GameState {
  if (actions.pause) {
    return {
      ...state,
      paused: true,
      jumpRequested: actions.jump,
    };
  }

  const inputVelocity =
    actions.left === actions.right
      ? state.velocityX
      : actions.left
        ? -Math.abs(state.velocityX)
        : Math.abs(state.velocityX);
  const elapsed = state.elapsed + deltaSeconds;
  let shapeX = state.shapeX + inputVelocity * deltaSeconds;
  let velocityX = inputVelocity;

  while (shapeX > SHAPE_MAX_X || shapeX < SHAPE_MIN_X) {
    if (shapeX > SHAPE_MAX_X) {
      shapeX = SHAPE_MAX_X - (shapeX - SHAPE_MAX_X);
      velocityX = -Math.abs(velocityX);
    } else {
      shapeX = SHAPE_MIN_X + (SHAPE_MIN_X - shapeX);
      velocityX = Math.abs(velocityX);
    }
  }

  return {
    elapsed,
    shapeX,
    shapeY: state.shapeY,
    velocityX,
    jumpRequested: actions.jump,
    paused: false,
  };
}

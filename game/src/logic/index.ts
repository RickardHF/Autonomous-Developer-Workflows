export interface GameState {
  elapsed: number;
  shapeX: number;
  shapeY: number;
  velocityX: number;
}

const SHAPE_MIN_X = 80;
const SHAPE_MAX_X = 720;

export function createInitialState(): GameState {
  return {
    elapsed: 0,
    shapeX: 400,
    shapeY: 225,
    velocityX: 80,
  };
}

export function update(state: GameState, deltaSeconds: number): GameState {
  const elapsed = state.elapsed + deltaSeconds;
  let shapeX = state.shapeX + state.velocityX * deltaSeconds;
  let velocityX = state.velocityX;

  if (shapeX > SHAPE_MAX_X) {
    shapeX = SHAPE_MAX_X - (shapeX - SHAPE_MAX_X);
    velocityX = -Math.abs(velocityX);
  } else if (shapeX < SHAPE_MIN_X) {
    shapeX = SHAPE_MIN_X + (SHAPE_MIN_X - shapeX);
    velocityX = Math.abs(velocityX);
  }

  return {
    elapsed,
    shapeX,
    shapeY: state.shapeY,
    velocityX,
  };
}

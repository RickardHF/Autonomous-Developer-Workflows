import { TEST_LEVEL } from "../levels/index.ts";
import { stepBody, type PlayerBody } from "../physics/index.ts";

export type SquashEvent = "jump" | "land";

export interface GameState {
  elapsed: number;
  player: PlayerBody;
  squashEvent: SquashEvent | null;
  squashTimer: number;
  paused: boolean;
}

export interface GameActions {
  left: boolean;
  right: boolean;
  jump: boolean;
  pause: boolean;
}

const SQUASH_DURATION = 0.1;

export function createInitialState(): GameState {
  return {
    elapsed: 0,
    player: { ...TEST_LEVEL.playerStart },
    squashEvent: null,
    squashTimer: 0,
    paused: false,
  };
}

export function update(
  state: GameState,
  deltaSeconds: number,
  actions: GameActions = { left: false, right: false, jump: false, pause: false },
): GameState {
  if (actions.pause) {
    return { ...state, paused: true };
  }

  const player = { ...state.player };
  const wasGrounded = player.grounded;
  const jumped = stepBody(
    player,
    { left: actions.left, right: actions.right },
    actions.jump,
    deltaSeconds,
    TEST_LEVEL.solids,
  );
  const landed = !wasGrounded && player.grounded;
  const squashEvent = jumped ? "jump" : landed ? "land" : state.squashEvent;
  const squashTimer = jumped || landed
    ? SQUASH_DURATION
    : Math.max(0, state.squashTimer - deltaSeconds);

  return {
    elapsed: state.elapsed + deltaSeconds,
    player,
    squashEvent: squashTimer > 0 ? squashEvent : null,
    squashTimer,
    paused: false,
  };
}

export { SQUASH_DURATION };

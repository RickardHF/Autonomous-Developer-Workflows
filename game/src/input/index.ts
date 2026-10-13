export type InputAction = "left" | "right" | "jump" | "pause";

export const DEFAULT_KEY_BINDINGS: Readonly<
  Record<InputAction, readonly string[]>
> = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  jump: ["ArrowUp", "KeyW", "Space"],
  pause: ["KeyP"],
};

const PREVENT_DEFAULT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "Space"]);

export interface InputController {
  isActionActive(action: InputAction): boolean;
  dispose(): void;
}

export function createInputController(
  target: EventTarget = window,
): InputController {
  const pressedKeys = new Set<string>();
  const keyToAction = new Map<string, InputAction>();

  for (const action of Object.keys(DEFAULT_KEY_BINDINGS) as InputAction[]) {
    for (const key of DEFAULT_KEY_BINDINGS[action]) {
      keyToAction.set(key, action);
    }
  }

  const handleKeyDown = (event: Event): void => {
    if (!("code" in event)) {
      return;
    }

    const code = (event as KeyboardEvent).code;
    if (!keyToAction.has(code)) {
      return;
    }

    pressedKeys.add(code);
    if (PREVENT_DEFAULT_KEYS.has(code)) {
      event.preventDefault();
    }
  };

  const handleKeyUp = (event: Event): void => {
    if (!("code" in event)) {
      return;
    }

    const code = (event as KeyboardEvent).code;
    if (keyToAction.has(code)) {
      pressedKeys.delete(code);
    }
  };

  target.addEventListener("keydown", handleKeyDown);
  target.addEventListener("keyup", handleKeyUp);

  return {
    isActionActive(action: InputAction): boolean {
      return DEFAULT_KEY_BINDINGS[action].some((key) => pressedKeys.has(key));
    },
    dispose(): void {
      target.removeEventListener("keydown", handleKeyDown);
      target.removeEventListener("keyup", handleKeyUp);
      pressedKeys.clear();
    },
  };
}

import { describe, expect, it } from "vitest";
import {
  createInputController,
  DEFAULT_KEY_BINDINGS,
  type InputAction,
} from "./index.ts";

function dispatch(
  target: EventTarget,
  type: "keydown" | "keyup",
  code: string,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "code", { value: code });
  target.dispatchEvent(event);
  return event;
}

describe("keyboard input controller", () => {
  it("activates and clears each mapped action", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    for (const action of Object.keys(DEFAULT_KEY_BINDINGS) as InputAction[]) {
      for (const key of DEFAULT_KEY_BINDINGS[action]) {
        dispatch(target, "keydown", key);
        expect(controller.isActionActive(action)).toBe(true);
        dispatch(target, "keyup", key);
        expect(controller.isActionActive(action)).toBe(false);
      }
    }

    controller.dispose();
  });

  it("keeps an action active while another bound key remains pressed", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    dispatch(target, "keydown", "ArrowLeft");
    dispatch(target, "keydown", "KeyA");
    dispatch(target, "keyup", "ArrowLeft");

    expect(controller.isActionActive("left")).toBe(true);

    dispatch(target, "keyup", "KeyA");
    expect(controller.isActionActive("left")).toBe(false);
    controller.dispose();
  });

  it("prevents default behavior for arrow and space keys only", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    expect(dispatch(target, "keydown", "ArrowUp").defaultPrevented).toBe(true);
    expect(dispatch(target, "keydown", "Space").defaultPrevented).toBe(true);
    expect(dispatch(target, "keydown", "KeyA").defaultPrevented).toBe(false);
    expect(dispatch(target, "keydown", "Tab").defaultPrevented).toBe(false);

    controller.dispose();
  });

  it("removes listeners when disposed", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    controller.dispose();
    dispatch(target, "keydown", "KeyP");

    expect(controller.isActionActive("pause")).toBe(false);
  });
});

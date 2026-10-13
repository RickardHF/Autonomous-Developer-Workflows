import { describe, expect, it, vi } from "vitest";
import {
  createInputController,
  DEFAULT_KEY_BINDINGS,
  type InputAction,
} from "./index.ts";

function dispatch(
  target: EventTarget,
  type: "keydown" | "keyup",
  code: string,
  repeat = false,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: repeat });
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
    const removeListener = vi.spyOn(target, "removeEventListener");
    const controller = createInputController(target);

    dispatch(target, "keydown", "KeyP");
    controller.dispose();
    dispatch(target, "keydown", "KeyP");

    expect(controller.isActionActive("pause")).toBe(false);
    expect(controller.consumeActionPress("pause")).toBe(false);
    for (const type of ["keydown", "keyup", "blur"]) {
      expect(removeListener).toHaveBeenCalledWith(type, expect.any(Function));
    }
    removeListener.mockRestore();
  });

  it("reports each press once, ignoring held keys and auto-repeat", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    dispatch(target, "keydown", "KeyP");
    expect(controller.consumeActionPress("pause")).toBe(true);
    expect(controller.consumeActionPress("pause")).toBe(false);

    dispatch(target, "keydown", "KeyP");
    dispatch(target, "keydown", "KeyP", true);
    expect(controller.consumeActionPress("pause")).toBe(false);

    dispatch(target, "keyup", "KeyP");
    dispatch(target, "keydown", "KeyP");
    dispatch(target, "keyup", "KeyP");
    expect(controller.isActionActive("pause")).toBe(false);
    expect(controller.consumeActionPress("pause")).toBe(true);
    controller.dispose();
  });

  it("clears all held keys and pending presses when focus is lost", () => {
    const target = new EventTarget();
    const controller = createInputController(target);

    for (const keys of Object.values(DEFAULT_KEY_BINDINGS)) {
      for (const key of keys) {
        dispatch(target, "keydown", key);
      }
    }
    target.dispatchEvent(new Event("blur"));

    for (const action of Object.keys(DEFAULT_KEY_BINDINGS) as InputAction[]) {
      expect(controller.isActionActive(action)).toBe(false);
      expect(controller.consumeActionPress(action)).toBe(false);
    }

    dispatch(target, "keydown", "KeyP", true);
    expect(controller.consumeActionPress("pause")).toBe(false);
    dispatch(target, "keyup", "KeyP");
    dispatch(target, "keydown", "KeyP");
    expect(controller.consumeActionPress("pause")).toBe(true);
    dispatch(target, "keydown", "ArrowRight");
    expect(controller.isActionActive("right")).toBe(true);
    controller.dispose();
  });
});

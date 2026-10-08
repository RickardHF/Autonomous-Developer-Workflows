import { describe, expect, it } from "vitest";
import { PLACEHOLDER_COLOR } from "./main.ts";

describe("game scaffold", () => {
  it("exposes the placeholder canvas color", () => {
    expect(PLACEHOLDER_COLOR).toBe("#7dd3fc");
  });
});

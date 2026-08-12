import { describe, it, expect } from "vitest";
import { isMotionRisingEdge } from "./motion-edge.js";

describe("isMotionRisingEdge", () => {
  it("fires on the first poll when the alarm is already active", () => {
    expect(isMotionRisingEdge(undefined, true)).toBe(true);
  });

  it("does not fire on the first poll when there is no alarm", () => {
    expect(isMotionRisingEdge(undefined, false)).toBe(false);
  });

  it("fires on a false -> true transition", () => {
    expect(isMotionRisingEdge(false, true)).toBe(true);
  });

  it("does not fire while the alarm stays true across repeated polls", () => {
    expect(isMotionRisingEdge(true, true)).toBe(false);
  });

  it("does not fire on the falling edge (true -> false)", () => {
    expect(isMotionRisingEdge(true, false)).toBe(false);
  });

  it("does not fire while the alarm stays false across repeated polls", () => {
    expect(isMotionRisingEdge(false, false)).toBe(false);
  });
});

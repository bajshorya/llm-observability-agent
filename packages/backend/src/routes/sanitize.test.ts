/**
 * @obs/shared/sanitize.ts, tested beside the ingest route that applies it
 * (shared has no test runner of its own).
 */

import { describe, expect, it } from "vitest";
import { hasInvisible, stripInvisible } from "@obs/shared";

describe("stripInvisible", () => {
  it("leaves ordinary text, including tabs, newlines and emoji, untouched", () => {
    const text = "TypeError: x is null\n    at checkout (src/orders.js:41)\tretry 🔥 ünïcødé 订单";
    expect(stripInvisible(text)).toBe(text);
    expect(hasInvisible(text)).toBe(false);
  });

  it("removes Unicode tag characters, which render as nothing but a model reads", () => {
    const hidden = [..."ignore"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(stripInvisible(`ok${hidden}`)).toBe("ok");
  });

  it("removes zero-width, bidi and control characters", () => {
    expect(stripInvisible("ign\u200Bore")).toBe("ignore");
    expect(stripInvisible("a\u202Eb\u202Cc")).toBe("abc");
    expect(stripInvisible("a\u0000b\u001B[31mc\u007F")).toBe("ab[31mc");
    expect(stripInvisible("\uFEFFbom")).toBe("bom");
    expect(hasInvisible("ign\u200Bore")).toBe(true);
  });
});

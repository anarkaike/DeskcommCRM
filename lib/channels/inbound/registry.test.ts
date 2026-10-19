import { describe, expect, it } from "vitest";
import { getInboundDriver, supportsInbound } from "./registry";

describe("registro de drivers inbound", () => {
  it("resolve Telegram pelo provider e falha fechado para provider sem driver", () => {
    expect(supportsInbound("telegram")).toBe(true);
    expect(getInboundDriver("telegram").provider).toBe("telegram");
    expect(supportsInbound("waha")).toBe(false);
    expect(() => getInboundDriver("waha")).toThrow("inbound_driver_not_configured: waha");
  });
});

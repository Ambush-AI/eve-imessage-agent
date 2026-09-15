import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { timezoneFromPhone } from "./area-codes.ts";

describe("timezoneFromPhone", () => {
  it("maps Canadian and US area codes", () => {
    assert.equal(timezoneFromPhone("+16478088104"), "America/Toronto");
    assert.equal(timezoneFromPhone("+14155551234"), "America/Los_Angeles");
    assert.equal(timezoneFromPhone("+13125551234"), "America/Chicago");
    assert.equal(timezoneFromPhone("+16045551234"), "America/Vancouver");
  });
  it("returns null outside NANP or for unknown codes", () => {
    assert.equal(timezoneFromPhone("+447700900123"), null);
    assert.equal(timezoneFromPhone("+19995551234"), null);
  });
});

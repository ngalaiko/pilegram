import { describe, expect, test } from "bun:test";
import { nextCronRun } from "./cron.ts";

describe("nextCronRun", () => {
  test("runs at the next matching minute", () => {
    const next = nextCronRun("30 8 * * *", "UTC", new Date("2026-08-08T08:29:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-08-08T08:30:00.000Z");
  });

  test("skips to the following day after today's matching time", () => {
    const next = nextCronRun("30 8 * * *", "UTC", new Date("2026-08-08T08:30:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-08-09T08:30:00.000Z");
  });

  test("supports day-of-week ranges", () => {
    const next = nextCronRun("0 9 * * 1-5", "UTC", new Date("2026-08-08T08:00:00Z")); // Saturday
    expect(new Date(next).toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  test("calculates in the requested timezone", () => {
    const next = nextCronRun("0 9 * * *", "Europe/Stockholm", new Date("2026-01-01T07:59:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  test("rejects invalid expressions", () => {
    expect(() => nextCronRun("not cron", "UTC")).toThrow("cron must have 5 fields");
    expect(() => nextCronRun("99 * * * *", "UTC")).toThrow("invalid cron field");
  });
});

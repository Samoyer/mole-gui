import { describe, expect, it } from "vitest";
import {
  assessMoCompatibility,
  isMoCompatibilityBlocked,
  parseMoVersion,
  validateAnalyzePayload,
} from "../moCompatibility";

describe("Mole version contract", () => {
  it("parses the real Mole version banner", () => {
    const output = [
      "Mole version 1.66.0",
      "macOS: 26.6.2",
      "Architecture: arm64",
      "Kernel: 25.6.0",
    ].join("\n");
    expect(parseMoVersion(output)).toBe("1.66.0");
    expect(assessMoCompatibility(output)).toEqual({
      status: "supported",
      version: "1.66.0",
    });
  });

  it("accepts patches of the tested minor release", () => {
    expect(assessMoCompatibility("Mole version 1.66.4").status).toBe("supported");
  });

  it("blocks older output contracts", () => {
    expect(assessMoCompatibility("Mole version 1.65.9")).toEqual({
      status: "unsupported",
      version: "1.65.9",
    });
  });

  it("labels newer 1.x releases as untested", () => {
    expect(assessMoCompatibility("Mole version 1.67.0")).toEqual({
      status: "untested",
      version: "1.67.0",
    });
  });

  it("blocks a major-version output change", () => {
    expect(assessMoCompatibility("mo 2.0.0").status).toBe("unsupported");
  });

  it("reports unknown output instead of guessing", () => {
    expect(assessMoCompatibility("command not found")).toEqual({
      status: "unknown",
      version: null,
    });
  });

  it("blocks missing, unknown and unsupported contracts", () => {
    expect(isMoCompatibilityBlocked(null)).toBe(true);
    expect(isMoCompatibilityBlocked({ status: "missing", version: null })).toBe(true);
    expect(isMoCompatibilityBlocked({ status: "unknown", version: null })).toBe(true);
    expect(isMoCompatibilityBlocked({ status: "unsupported", version: "2.0.0" })).toBe(true);
    expect(isMoCompatibilityBlocked({ status: "untested", version: "1.67.0" })).toBe(false);
    expect(isMoCompatibilityBlocked({ status: "supported", version: "1.66.0" })).toBe(false);
  });
});

describe("analyze JSON contract", () => {
  it("accepts the fields consumed by the GUI", () => {
    expect(
      validateAnalyzePayload({
        scan_status: "complete",
        path: "/",
        overview: true,
        entries: [
          {
            scan_status: "complete",
            name: "Applications",
            path: "/Applications",
            size: 10,
            is_dir: true,
          },
        ],
        large_files: [{ name: "disk.dmg", path: "/tmp/disk.dmg", size: 20 }],
      }),
    ).toEqual([]);
  });

  it("reports missing and mistyped fields", () => {
    const issues = validateAnalyzePayload({
      scan_status: "complete",
      overview: true,
      entries: [{ name: "Applications", size: "10GB" }],
    });
    expect(issues).toContain("path");
    expect(issues).toContain("entries[0].size");
    expect(issues).toContain("entries[0].is_dir");
  });
});

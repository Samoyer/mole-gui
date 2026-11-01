import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatRate,
  parseCleanPreview,
  parseJson,
  uninstallRunFailed,
} from "../mole";

describe("formatBytes", () => {
  it("returns -- for invalid input", () => {
    expect(formatBytes(NaN)).toBe("--");
    expect(formatBytes(-1)).toBe("--");
  });
  it("returns 0B for sub-byte", () => {
    expect(formatBytes(0.5)).toBe("0B");
  });
  it("formats B/KB/MB/GB/TB", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(1048576)).toBe("1.0MB");
    expect(formatBytes(1073741824)).toBe("1.0GB");
    expect(formatBytes(1099511627776)).toBe("1.0TB");
  });
  it("promotes MB to GB when >= 100", () => {
    expect(formatBytes(1500 * 1024 * 1024)).toBe("1.5GB");
  });
});

describe("formatRate", () => {
  it("uses MB/s for >= 1", () => {
    expect(formatRate(1.5)).toBe("1.5 MB/s");
  });
  it("uses KB/s below 1", () => {
    expect(formatRate(0.5)).toBe("512 KB/s");
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("parseCleanPreview", () => {
  it("parses categories and items", () => {
    const text = [
      "Free space: 81.49GB",
      "➤ User Caches",
      "  → Browser cache · 5 items · 1.5GB",
      "  ✓ Nothing to clean",
      "  ◎ Protected · skipped",
    ].join("\n");
    const report = parseCleanPreview(text);
    expect(report.freeSpace).toBe("81.49GB");
    expect(report.sudoNote).toBe(false);
    expect(report.categories.length).toBe(1);
    expect(report.categories[0].name).toBe("User Caches");
    expect(report.categories[0].items.length).toBe(3);
    expect(report.categories[0].items[0].mark).toBe("clean");
    expect(report.categories[0].items[0].name).toContain("Browser cache");
    expect(report.totalBytes).toBeCloseTo(1.5 * 1024 * 1024 * 1024);
    expect(report.cleanableCount).toBe(1);
  });

  it("sets sudoNote on need sudo line", () => {
    const text = "need sudo\n➤ Root\n  → System cache · 1GB";
    const report = parseCleanPreview(text);
    expect(report.sudoNote).toBe(true);
  });

  it("takes the last size when a line has multiple", () => {
    const text = "➤ Cat\n  → Cache (1.5GB) · clean · 2.3MB";
    const report = parseCleanPreview(text);
    expect(report.categories[0].items[0].sizeText).toBe("2.3MB");
    expect(report.totalBytes).toBeCloseTo(2.3 * 1024 * 1024);
  });

  it("returns empty report for empty input", () => {
    const report = parseCleanPreview("");
    expect(report.categories).toEqual([]);
    expect(report.totalBytes).toBe(0);
  });
});

describe("uninstallRunFailed", () => {
  it("detects mo's interactive-terminal refusal as failure", () => {
    expect(
      uninstallRunFailed(
        "Matched 1 app(s): 1. 腾讯元宝\nUninstall confirmation needs an interactive terminal; no apps were removed.",
      ),
    ).toBe(true);
  });
  it("detects unreadable confirmation as failure", () => {
    expect(uninstallRunFailed("Could not read the uninstall confirmation; no apps were removed.")).toBe(true);
  });
  it("treats a normal completed run as success", () => {
    expect(uninstallRunFailed("✓ /Applications/Foo.app removed to Trash")).toBe(false);
  });
});

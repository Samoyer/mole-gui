export type MoCompatibilityStatus =
  | "supported"
  | "untested"
  | "unsupported"
  | "unknown"
  | "missing";

export interface MoCompatibility {
  status: MoCompatibilityStatus;
  version: string | null;
}

export const TESTED_MO_VERSION = "1.66.0";

const VERSION_PATTERNS = [
  /\bMole version\s+v?(\d+)\.(\d+)\.(\d+)/i,
  /(?:^|\n)\s*mo\s+v?(\d+)\.(\d+)\.(\d+)/i,
];

type ParsedVersion = [number, number, number];

function parseVersionTuple(output: string): ParsedVersion | null {
  for (const pattern of VERSION_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    }
  }
  return null;
}

function compareVersion(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function parseMoVersion(output: string): string | null {
  const parsed = parseVersionTuple(output);
  return parsed ? parsed.join(".") : null;
}

/**
 * The GUI has contract tests for Mole 1.66.x output.
 * Older or major-version changes are blocked from being presented as supported;
 * newer 1.x releases are allowed but clearly marked as untested.
 */
export function assessMoCompatibility(output: string): MoCompatibility {
  const parsed = parseVersionTuple(output);
  if (!parsed) return { status: "unknown", version: null };

  const version = parsed.join(".");
  const tested = TESTED_MO_VERSION.split(".").map(Number) as ParsedVersion;

  if (parsed[0] !== tested[0]) {
    return { status: "unsupported", version };
  }
  if (parsed[1] === tested[1]) {
    return { status: "supported", version };
  }
  if (compareVersion(parsed, tested) < 0) {
    return { status: "unsupported", version };
  }
  return { status: "untested", version };
}

export function missingMoCompatibility(): MoCompatibility {
  return { status: "missing", version: null };
}

export function isMoCompatibilityBlocked(
  compatibility: MoCompatibility | null | undefined,
): boolean {
  return (
    !compatibility ||
    compatibility.status === "missing" ||
    compatibility.status === "unknown" ||
    compatibility.status === "unsupported"
  );
}

/** Validate the stable top-level and entry fields consumed by AnalyzeView. */
export function validateAnalyzePayload(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["payload"];

  const data = value as Record<string, unknown>;
  const issues: string[] = [];

  if (typeof data.scan_status !== "string") issues.push("scan_status");
  if (typeof data.path !== "string") issues.push("path");
  if (typeof data.overview !== "boolean") issues.push("overview");
  if (!Array.isArray(data.entries)) {
    issues.push("entries");
  } else {
    for (const [index, entry] of data.entries.entries()) {
      if (!entry || typeof entry !== "object") {
        issues.push(`entries[${index}]`);
        continue;
      }
      const row = entry as Record<string, unknown>;
      if (typeof row.scan_status !== "string") issues.push(`entries[${index}].scan_status`);
      if (typeof row.name !== "string") issues.push(`entries[${index}].name`);
      if (typeof row.path !== "string") issues.push(`entries[${index}].path`);
      if (typeof row.size !== "number") issues.push(`entries[${index}].size`);
      if (typeof row.is_dir !== "boolean") issues.push(`entries[${index}].is_dir`);
    }
  }

  if (data.large_files !== undefined) {
    if (!Array.isArray(data.large_files)) {
      issues.push("large_files");
    } else {
      for (const [index, file] of data.large_files.entries()) {
        if (!file || typeof file !== "object") {
          issues.push(`large_files[${index}]`);
          continue;
        }
        const row = file as Record<string, unknown>;
        if (typeof row.name !== "string") issues.push(`large_files[${index}].name`);
        if (typeof row.path !== "string") issues.push(`large_files[${index}].path`);
        if (typeof row.size !== "number") issues.push(`large_files[${index}].size`);
      }
    }
  }

  return issues;
}

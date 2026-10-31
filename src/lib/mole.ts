import { invoke } from "@tauri-apps/api/core";

/* ---------- Backend commands ---------- */

export const moVersion = () => invoke<string>("mo_version");
export const moStatus = () => invoke<string>("mo_status");
export const moStatusWatchStart = () => invoke<void>("mo_status_watch_start");
export const moStatusWatchStop = () => invoke<void>("mo_status_watch_stop");
export const moCleanPreview = (id: number) => invoke<string>("mo_clean_preview", { id });
export const moCleanRun = (id: number) => invoke<string>("mo_clean_run", { id });
export const moUninstallList = (id: number) => invoke<string>("mo_uninstall_list", { id });
export const moUninstallPreview = (name: string, id: number) =>
  invoke<string>("mo_uninstall_preview", { name, id });
export const moUninstallRun = (name: string, permanent: boolean, id: number) =>
  invoke<string>("mo_uninstall_run", { name, permanent, id });
export const moAnalyze = (path: string | undefined, id: number) =>
  invoke<string>("mo_analyze", { path: path ?? null, id });
export const moJobCancel = (id: number) => invoke<void>("mo_job_cancel", { id });
export const moCacheRead = (name: string) =>
  invoke<string | null>("mo_cache_read", { name });
export const moCacheWrite = (name: string, content: string) =>
  invoke<void>("mo_cache_write", { name, content });

// 重型任务 id：同一毫秒内自增保证唯一，用于「取消自己的任务」
let jobCounter = 0;
export function nextJobId(): number {
  return Date.now() * 1000 + (jobCounter++ % 1000);
}

export function isCancelError(e: unknown): boolean {
  return String(e).includes("已取消");
}

/* ---------- Shared types ---------- */

export interface Hardware {
  model: string;
  cpu_model: string;
  total_ram: string;
  disk_size: string;
  os_version: string;
}

export interface StatusData {
  host: string;
  uptime: string;
  procs: number;
  hardware: Hardware;
  health_score: number;
  health_score_msg: string;
  cpu: {
    usage: number;
    per_core: number[];
    load1: number;
    load5: number;
    load15: number;
    core_count: number;
  };
  memory: {
    used: number;
    total: number;
    available: number;
    used_percent: number;
    swap_used: number;
  };
  disks: {
    mount: string;
    used: number;
    total: number;
    used_percent: number;
    external: boolean;
    smart_status: string;
  }[];
  disk_io: { read_rate: number; write_rate: number };
  network: { name: string; rx_rate_mbs: number; tx_rate_mbs: number; ip: string }[];
  thermal: { system_power: number; fan_speed: number };
  top_processes: {
    pid: number;
    name: string;
    cpu: number;
    memory: number;
  }[];
  trash_size: number;
}

export interface AppEntry {
  name: string;
  bundle_id: string;
  source: string;
  uninstall_name: string;
  path: string;
  size: string;
}

export interface AnalyzeEntry {
  scan_status: string;
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
}

export interface AnalyzeData {
  scan_status: string;
  path: string;
  overview: boolean;
  entries: AnalyzeEntry[];
  large_files: { name: string; path: string; size: number }[];
  total_size?: number;
  total_files?: number;
}

/* ---------- Formatters ---------- */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes < 1) return "0B";
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const text = v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return `${text}${UNITS[u]}`;
}

export function formatRate(mbs: number): string {
  if (mbs >= 1) return `${mbs.toFixed(1)} MB/s`;
  return `${(mbs * 1024).toFixed(0)} KB/s`;
}

export function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/* ---------- Clean preview text parser ---------- */

export interface CleanItem {
  mark: "clean" | "ok" | "skip" | "info";
  name: string;
  bytes: number | null;
  sizeText: string | null;
}

export interface CleanCategory {
  name: string;
  items: CleanItem[];
}

export interface CleanReport {
  freeSpace: string | null;
  sudoNote: boolean;
  categories: CleanCategory[];
  totalBytes: number;
  cleanableCount: number;
}

const SIZE_RE = /([\d.]+)\s*(B|KB|MB|GB|TB)\b/i;

function sizeToBytes(value: string, unit: string): number {
  const v = parseFloat(value);
  const idx = UNITS.findIndex((u) => u.toLowerCase() === unit.toLowerCase());
  return v * Math.pow(1024, idx < 0 ? 0 : idx);
}

export function parseCleanPreview(text: string): CleanReport {
  const report: CleanReport = {
    freeSpace: null,
    sudoNote: false,
    categories: [],
    totalBytes: 0,
    cleanableCount: 0,
  };
  let current: CleanCategory | null = null;

  for (const line of text.split("\n")) {
    if (line.includes("need sudo")) {
      report.sudoNote = true;
      continue;
    }
    const freeMatch = line.match(/Free space:\s*([\d.]+\s*\w+)/);
    if (freeMatch) {
      report.freeSpace = freeMatch[1].replace(/\s+/g, "");
      continue;
    }
    if (line.startsWith("➤ ")) {
      current = { name: line.slice(2).trim(), items: [] };
      report.categories.push(current);
      continue;
    }
    const itemMatch = line.match(/^ {2}(→|✓|◎|⊙)\s+(.*)$/);
    if (!itemMatch || !current) continue;

    const mark =
      itemMatch[1] === "→"
        ? "clean"
        : itemMatch[1] === "✓"
          ? "ok"
          : itemMatch[1] === "◎"
            ? "skip"
            : "info";

    let rest = itemMatch[2].trim();
    let bytes: number | null = null;
    let sizeText: string | null = null;
    const sizeMatch = rest.match(SIZE_RE);
    if (sizeMatch) {
      bytes = sizeToBytes(sizeMatch[1], sizeMatch[2]);
      sizeText = `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}`;
      rest = rest.replace(sizeMatch[0], "").trim();
      rest = rest.replace(/[\s,·]+dry\s*$/, "").replace(/[\s,·]+$/, "").trim();
    }
    if (mark === "clean" && bytes !== null) {
      report.totalBytes += bytes;
      report.cleanableCount++;
    }
    if (mark === "clean" && bytes === null) {
      report.cleanableCount++;
    }
    current.items.push({ mark, name: rest, bytes, sizeText });
  }
  return report;
}

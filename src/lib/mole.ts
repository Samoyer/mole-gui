import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

// mo 卸载失败时退出码是 0，只能从输出文本判断（如交互确认被拒绝），
// 匹配到这些标记就不能当成功处理
export function uninstallRunFailed(text: string): boolean {
  return /no apps were removed|nothing was changed|needs an interactive terminal|could not read the uninstall confirmation/i.test(
    text,
  );
}
export const moAnalyze = (path: string | undefined, id: number) =>
  invoke<string>("mo_analyze", { path: path ?? null, id });
export const moJobCancel = (id: number) => invoke<void>("mo_job_cancel", { id });
export const moCacheRead = (name: string) =>
  invoke<string | null>("mo_cache_read", { name });
export const moCacheWrite = (name: string, content: string) =>
  invoke<void>("mo_cache_write", { name, content });

// 重型任务 id：严格单调递增（时间戳推进时跟随毫秒，同一毫秒内 +1），
// 永不回绕、永不碰撞。数值上限远在 Number.MAX_SAFE_INTEGER 之内。
let lastJobId = 0;
export function nextJobId(): number {
  lastJobId = Math.max(lastJobId + 1, Date.now() * 1000);
  return lastJobId;
}

export function isCancelError(e: unknown): boolean {
  return String(e).includes("已取消");
}

/* ---------- 扫描进度事件 ----------
 * mo clean 按分类渐进输出（"➤ 分类名"），Rust 侧逐行解析后发事件；
 * analyze 没有任何流式输出，收不到事件就保持诚实的等待计时显示。 */
export interface MoProgress {
  id: number;
  done: number;
  total: number;
  label: string;
}

export function onMoProgress(handler: (p: MoProgress) => void) {
  return listen<MoProgress>("mole://progress", (e) => handler(e.payload));
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

/* ---------- 卸载预览解析：技术输出 → 自然语言要素 ---------- */

export interface UninstallPreview {
  appName: string;
  appSize: string | null;
  lastUsedRaw: string | null;
  files: { path: string; size: string | null }[];
  reviewOnly: string[];
  kept: string[];
  raw: string;
}

const UNINSTALL_SIZE_RE = /([\d.]+)\s*(B|KB|MB|GB|TB)\b/i;

export function parseUninstallPreview(text: string, appName: string): UninstallPreview {
  const preview: UninstallPreview = {
    appName,
    appSize: null,
    lastUsedRaw: null,
    files: [],
    reviewOnly: [],
    kept: [],
    raw: text,
  };
  let section: "none" | "remove" | "review" | "kept" = "none";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Matched \d+ app/i.test(trimmed)) {
      const size = trimmed.match(UNINSTALL_SIZE_RE);
      if (size) preview.appSize = `${size[1]}${size[2].toUpperCase()}`;
      const last = trimmed.match(/Last:\s*\S+\s+ago/i);
      preview.lastUsedRaw = last ? last[0] : null;
      continue;
    }
    if (/^Files to be removed/i.test(trimmed)) {
      section = "remove";
      continue;
    }
    if (/^Review only/i.test(trimmed)) {
      section = "review";
      continue;
    }
    if (/^Personal data kept/i.test(trimmed)) {
      section = "kept";
      continue;
    }
    if (/^(choose personal data|Run mo uninstall|Uninstall confirmation|no apps were removed)/i.test(trimmed)) {
      section = "none";
      continue;
    }
    if (section === "remove") {
      // "✓ /Applications/X.app , 156.6MB" / "◎ 组名 , 156.6MB"（组名非路径，跳过）
      const m = trimmed.match(/^[✓◎✗]\s+(.+?)(?:\s*,\s*([\d.]+\s*\w+))?$/);
      if (m && m[1].startsWith("/")) {
        const sz = m[2]?.match(UNINSTALL_SIZE_RE);
        preview.files.push({
          path: m[1].trim(),
          size: sz ? `${sz[1]}${sz[2].toUpperCase()}` : null,
        });
      }
    } else if (section === "review") {
      const m = trimmed.match(/^[⊙✓◎]\s+(.+)$/);
      if (m) preview.reviewOnly.push(m[1].trim());
    } else if (section === "kept") {
      const m = trimmed.match(/^[⊙✓◎]\s+(.+)$/);
      if (m) preview.kept.push(m[1].trim());
    }
  }
  return preview;
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
    // 用 matchAll 取最后一个尺寸（通常是实际大小），避免行内多个尺寸取错
    // matchAll 需要全局正则，SIZE_RE 带 i 不带 g，这里用带 g 的副本
    const sizeMatches = [...rest.matchAll(new RegExp(SIZE_RE.source, "gi"))];
    if (sizeMatches.length > 0) {
      const last = sizeMatches[sizeMatches.length - 1];
      bytes = sizeToBytes(last[1], last[2]);
      sizeText = `${last[1]}${last[2].toUpperCase()}`;
      // 移除所有尺寸匹配，避免残留在名称里
      rest = rest.replace(new RegExp(SIZE_RE.source, "gi"), " ").trim();
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

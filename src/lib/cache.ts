import { moCacheRead, moCacheWrite, type AnalyzeData, type AppEntry, type CleanReport, type StatusData } from "./mole";

// 跨标签共享的缓存：切换视图时挂载/卸载会丢组件状态，
// 模块级缓存让来回切换零等待、零重复进程
let statusCache: StatusData | null = null;
let appsCache: { apps: AppEntry[]; at: number } | null = null;

export const APPS_CACHE_TTL = 30 * 60 * 1000;

export function getStatusCache(): StatusData | null {
  return statusCache;
}

export function setStatusCache(d: StatusData): void {
  statusCache = d;
}

export function getAppsCache(): { apps: AppEntry[]; at: number } | null {
  return appsCache;
}

export function setAppsCache(apps: AppEntry[]): void {
  appsCache = { apps, at: Date.now() };
}

/* ---------- 磁盘分析缓存 ---------- */

// 内存缓存：本次运行内共享，切换标签/目录零等待
const analyzeCache = new Map<string, { data: AnalyzeData; at: number }>();
export const ANALYZE_CACHE_TTL = 5 * 60 * 1000;
export const analyzeOverviewKey = "__overview__";

export function getAnalyzeCached(key: string): { data: AnalyzeData; at: number } | null {
  return analyzeCache.get(key) ?? null;
}

export function setAnalyzeCached(key: string, data: AnalyzeData): void {
  analyzeCache.set(key, { data, at: Date.now() });
}

// 磁盘持久缓存（gdu / GrandPerspective 的思路）：扫描结果落盘，
// 下次启动 App 即使还没扫完也能先展示上次的结果
const ANALYZE_PERSIST_TTL = 24 * 60 * 60 * 1000;

export async function readAnalyzePersist(key: string): Promise<{ data: AnalyzeData; at: number } | null> {
  try {
    const raw = await moCacheRead(`analyze-${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: AnalyzeData; at: number };
    if (!parsed?.data?.entries || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > ANALYZE_PERSIST_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistAnalyze(key: string, data: AnalyzeData): void {
  moCacheWrite(`analyze-${key}`, JSON.stringify({ data, at: Date.now() })).catch(() => {});
}

/* ---------- 状态总览缓存 ---------- */

const STATUS_PERSIST_TTL = 6 * 60 * 60 * 1000;

export async function readStatusPersist(): Promise<{ data: StatusData; at: number } | null> {
  try {
    const raw = await moCacheRead("status-last");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: StatusData; at: number };
    if (!parsed?.data?.hardware || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > STATUS_PERSIST_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistStatus(data: StatusData): void {
  moCacheWrite("status-last", JSON.stringify({ data, at: Date.now() })).catch(() => {});
}

/* ---------- 深度清理缓存 ---------- */

// 本次运行内的内存缓存（跨标签共享）
let cleanCache: { report: CleanReport; at: number } | null = null;
export const CLEAN_CACHE_TTL = 10 * 60 * 1000;

export function getCleanCached(): { report: CleanReport; at: number } | null {
  return cleanCache;
}

export function setCleanCached(report: CleanReport): void {
  cleanCache = { report, at: Date.now() };
}

const CLEAN_PERSIST_TTL = 60 * 60 * 1000;

export async function readCleanPersist(): Promise<{ report: CleanReport; at: number } | null> {
  try {
    const raw = await moCacheRead("clean-preview");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { report: CleanReport; at: number };
    if (!parsed?.report?.categories || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > CLEAN_PERSIST_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistClean(report: CleanReport): void {
  moCacheWrite("clean-preview", JSON.stringify({ report, at: Date.now() })).catch(() => {});
}

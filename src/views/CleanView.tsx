import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  moCleanPreview,
  moCleanTargets,
  moCleanRun,
  moJobCancel,
  nextJobId,
  isCancelError,
  formatBytes,
  parseCleanPreview,
  isPathWithin,
  selectableCleanTargets,
  selectedCleanBytes,
  type CleanReport,
  type CleanTarget,
} from "../lib/mole";
import { ConfirmSheet, ScanProgress, IconSparkle } from "../components";
import { navigate, consumeNavParams } from "../lib/nav";
import {
  cleanTargetLabel,
  translateCategory,
  translateItemName,
} from "../i18n/zh-CN";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CLEAN_CACHE_TTL,
  getCleanCached,
  setCleanCached,
  readCleanPersist,
  persistClean,
} from "../lib/cache";
import {
  isMoCompatibilityBlocked,
  type MoCompatibility,
} from "../lib/moCompatibility";

type InitPhase = "init" | "scanning" | "preview" | "confirm" | "running" | "done";

const MARK_TEXT = { clean: "↳", ok: "✓", skip: "◎", info: "i" } as const;
const FULL_DISK_ACCESS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";

// 扫描/清理状态放在模块级 store：切到其他 tab 时 CleanView 卸载，
// 但任务在后台继续跑，回来时进度和结果都还在。
// 之前卸载时的 moJobCancel 会把后台扫描甚至正在执行的真实清理杀掉。
type CleanState = {
  phase: InitPhase;
  report: CleanReport | null;
  output: string;
  error: string | null;
  scanDone: boolean;
  scanId: number;
  scanStartedAt: number;
  scanInFlight: boolean;
  refreshing: boolean;
  hasContent: boolean;
  selectedPaths: string[];
  selectionInitialized: boolean;
  cleanStage: "idle" | "verifying" | "cleaning";
};

const cleanStore = {
  state: {
    phase: "init",
    report: null,
    output: "",
    error: null,
    scanDone: false,
    scanId: 0,
    scanStartedAt: 0,
    scanInFlight: false,
    refreshing: false,
    hasContent: false,
    selectedPaths: [],
    selectionInitialized: false,
    cleanStage: "idle",
  } as CleanState,
  listeners: new Set<() => void>(),
};

function setClean(patch: Partial<CleanState>) {
  cleanStore.state = { ...cleanStore.state, ...patch };
  cleanStore.listeners.forEach((l) => l());
}

function subscribeClean(fn: () => void) {
  cleanStore.listeners.add(fn);
  return () => {
    cleanStore.listeners.delete(fn);
  };
}

const getCleanSnapshot = () => cleanStore.state;

let cacheInitialized = false;

function defaultSelectedPaths(report: CleanReport): string[] {
  // 默认不勾选：清理属于不可逆操作，应该由用户明确选择本次要处理的目标。
  void report;
  return [];
}

function applyCachedReport(report: CleanReport) {
  const patch: Partial<CleanState> = {
    report,
    hasContent: true,
    phase: cleanStore.state.phase === "init" ? "preview" : cleanStore.state.phase,
  };
  if (!cleanStore.state.selectionInitialized) {
    patch.selectedPaths = defaultSelectedPaths(report);
    patch.selectionInitialized = true;
  }
  setClean(patch);
}

async function hydrateCachedReport(report: CleanReport): Promise<CleanReport> {
  if (report.targets?.length) return report;
  try {
    const targets = await moCleanTargets();
    return targets.length > 0 ? { ...report, targets } : report;
  } catch {
    return report;
  }
}

async function startScan(force = false) {
  if (cleanStore.state.scanInFlight) return;
  if (!force) {
    const hit = getCleanCached();
    if (hit && Date.now() - hit.at < CLEAN_CACHE_TTL) {
      const hydrated = await hydrateCachedReport(hit.report);
      if (hydrated !== hit.report) {
        setCleanCached(hydrated);
        persistClean(hydrated);
      }
      applyCachedReport(hydrated);
      return;
    }
    if (!hit && !cleanStore.state.hasContent) {
      const disk = await readCleanPersist();
      if (disk) {
        const hydrated = await hydrateCachedReport(disk.report);
        setCleanCached(hydrated);
        persistClean(hydrated);
        applyCachedReport(hydrated);
      }
    }
  }
  const id = nextJobId();
  if (cleanStore.state.hasContent) {
    setClean({ scanId: id, scanStartedAt: Date.now(), scanInFlight: true, refreshing: true, error: null });
  } else {
    setClean({ scanId: id, scanStartedAt: Date.now(), scanInFlight: true, scanDone: false, phase: "scanning", error: null });
  }
  try {
    const result = await moCleanPreview(id);
    const parsed: CleanReport = {
      ...parseCleanPreview(result.output),
      targets: result.targets,
    };
    setCleanCached(parsed);
    persistClean(parsed);
    // 扫描成功：进度条推到 100%，短暂展示后收起（冷启动路径再切结果页）
    setClean({
      report: parsed,
      hasContent: true,
      scanDone: true,
      scanInFlight: false,
      selectedPaths: defaultSelectedPaths(parsed),
      selectionInitialized: true,
    });
    window.setTimeout(() => {
      const cur = cleanStore.state;
      if (cur.scanId === id && cur.scanDone) {
        if (cur.phase === "scanning") setClean({ phase: "preview" });
        setClean({ refreshing: false, scanDone: false });
      }
    }, 600);
  } catch (e) {
    if (!isCancelError(e)) {
      const msg = String(e);
      setClean({ error: msg, scanInFlight: false, refreshing: false });
      if (!cleanStore.state.report) {
        setClean({ output: msg, phase: "done" });
      }
    } else {
      // 用户主动取消：有旧结果回结果页，没有则回起始页
      setClean({ scanInFlight: false, refreshing: false, scanDone: false });
      if (!cleanStore.state.hasContent) setClean({ phase: "init" });
    }
  }
}

function cancelCleanScan() {
  if (cleanStore.state.scanInFlight) {
    moJobCancel(cleanStore.state.scanId).catch(() => {});
  }
}

async function runCleanAction() {
  const selectedPaths = cleanStore.state.selectedPaths;
  if (selectedPaths.length === 0) return;
  const id = nextJobId();
  const targets = cleanStore.state.report?.targets ?? [];
  const selectable = selectableCleanTargets(targets);
  const allSelected = selectedPaths.length === selectable.length;
  setClean({
    phase: "running",
    output: "",
    scanId: id,
    scanInFlight: true,
    cleanStage: allSelected ? "cleaning" : "verifying",
  });
  try {
    const text = await moCleanRun(id, selectedPaths);
    setClean({
      output: text,
      phase: "done",
      scanInFlight: false,
      cleanStage: "idle",
    });
  } catch (e) {
    setClean({
      output: String(e),
      phase: "done",
      scanInFlight: false,
      cleanStage: "idle",
    });
  }
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      className="selection-checkbox"
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={onChange}
    />
  );
}

export default function CleanView({
  compatibility,
}: {
  compatibility: MoCompatibility | null;
}) {
  const snap = useSyncExternalStore(subscribeClean, getCleanSnapshot);
  const [focus, setFocus] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const blocked = isMoCompatibilityBlocked(compatibility);
  const beginScan = () => {
    if (!blocked) startScan(true);
  };
  const openFullDiskAccess = async () => {
    setPermissionError(null);
    try {
      await openUrl(FULL_DISK_ACCESS_URL);
    } catch (error) {
      console.error("[opener] failed to open Full Disk Access settings", error);
      setPermissionError(
        "未能自动打开系统设置，请手动前往「系统设置 → 隐私与安全性 → 完全磁盘访问」。",
      );
    }
  };

  // 任务链入口：其他页面带 focus 参数跳来时，只显示对应分类
  useEffect(() => {
    const params = consumeNavParams();
    if (params?.focus) {
      setFocus(params.focus);
    }
  }, []);

  useEffect(() => {
    if (cacheInitialized) return;
    cacheInitialized = true;
    (async () => {
      const hit = getCleanCached();
      if (hit) {
        const hydrated = await hydrateCachedReport(hit.report);
        if (hydrated !== hit.report) {
          setCleanCached(hydrated);
          persistClean(hydrated);
        }
        applyCachedReport(hydrated);
        return;
      }
      const disk = await readCleanPersist();
      if (disk && !cleanStore.state.hasContent) {
        const hydrated = await hydrateCachedReport(disk.report);
        setCleanCached(hydrated);
        persistClean(hydrated);
        applyCachedReport(hydrated);
      }
    })();
  }, []);

  if (snap.phase === "scanning")
    return <ScanProgress label="正在扫描可清理的项目…" done={snap.scanDone} jobId={snap.scanId} onCancel={cancelCleanScan} startedAt={snap.scanStartedAt || undefined} />;
  if (snap.error && !snap.report)
    return (
      <div className="error-box">
        {snap.error}
        <button className="btn ghost sm" style={{ marginLeft: 12 }} onClick={beginScan} disabled={blocked}>
          重试
        </button>
      </div>
    );
  if (snap.phase === "init" && !snap.report) {
    return (
      <div className="clean-empty-center" data-drag>
        <div className="clean-hero-empty">
          <div className="empty-icon"><IconSparkle size={26} /></div>
          <div className="empty-title">尚未扫描</div>
          <div className="desc">扫描缓存、日志和临时文件，找出可安全清理的内容</div>
          <button className="btn primary" onClick={beginScan} disabled={blocked}>开始扫描</button>
        </div>
      </div>
    );
  }
  if (!snap.report) return null;

  const report = snap.report;
  const phase = snap.phase;
  const showHero = phase === "preview" || phase === "confirm";
  const targets = report.targets ?? [];
  const selectableTargets = selectableCleanTargets(targets);
  const selectedSet = new Set(snap.selectedPaths);
  const selectedTargets = selectableTargets.filter((target) => selectedSet.has(target.path));
  const selectedBytes = selectedCleanBytes(targets, snap.selectedPaths);
  const selectedHasUnknown = selectedTargets.some((target) => !target.sizeKnown);
  const allSelected =
    selectableTargets.length > 0 && selectedTargets.length === selectableTargets.length;
  const selectedSize =
    selectedTargets.length === 0
      ? "未选择"
      : selectedHasUnknown
        ? `${selectedBytes > 0 ? formatBytes(selectedBytes) : ""}${selectedBytes > 0 ? "+" : "大小未知"}`
        : formatBytes(selectedBytes);

  const matchesFocus = (name: string) => {
    if (!focus) return true;
    const normalized = name.toLowerCase();
    if (focus === "cache") return normalized.includes("cache");
    if (focus === "logs") return normalized.includes("log");
    if (focus === "trash") return normalized.includes("trash");
    return true;
  };
  const visibleCategories = focus
    ? report.categories.filter((cat) => {
        return matchesFocus(cat.name);
      })
    : report.categories;
  const targetGroups = Array.from(
    targets.reduce((groups, target) => {
      const items = groups.get(target.section) ?? [];
      items.push(target);
      groups.set(target.section, items);
      return groups;
    }, new Map<string, CleanTarget[]>()),
  ).filter(([section]) => matchesFocus(section));
  const skippedItems = visibleCategories.flatMap((category) =>
    category.items
      .filter((item) => item.mark === "skip")
      .map((item) => ({ category: category.name, item })),
  );

  const setSelection = (paths: string[]) => {
    setClean({ selectedPaths: paths, selectionInitialized: true });
  };
  const toggleTarget = (path: string) => {
    setSelection(
      selectedSet.has(path)
        ? snap.selectedPaths.filter((selected) => selected !== path)
        : [...snap.selectedPaths, path],
    );
  };
  const toggleGroup = (items: CleanTarget[]) => {
    const paths = items.map((target) => target.path);
    const groupAllSelected = paths.every((path) => selectedSet.has(path));
    setSelection(
      groupAllSelected
        ? snap.selectedPaths.filter((path) => !paths.includes(path))
        : Array.from(new Set([...snap.selectedPaths, ...paths])),
    );
  };

  return (
    <>
      {focus && (
        <div className="notice-box" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>正在按来源页面的意图筛选清理项</span>
          <button className="inline-link-btn" onClick={() => setFocus(null)}>取消筛选</button>
        </div>
      )}

      {snap.refreshing && (
        <div style={{ marginBottom: 14 }}>
          <ScanProgress
            label="正在重新扫描…"
            jobId={snap.scanId}
            startedAt={snap.scanStartedAt || undefined}
            onCancel={cancelCleanScan}
          />
        </div>
      )}

      {showHero && (
        <section className="panel clean-hero" data-drag>
          <div>
            <div className="big">{selectedSize}</div>
            <div className="desc">
              已选 {selectedTargets.length} 个清理目标
              {selectedTargets.length > 0 ? ` · ${formatBytes(selectedBytes)}${selectedHasUnknown ? "+" : ""}` : ""}
              {report.freeSpace ? ` · 当前剩余 ${report.freeSpace}` : ""}
              {getCleanCached()
                ? ` · 扫描于 ${new Date(getCleanCached()!.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
                : ""}
              {snap.refreshing ? " · 正在重新扫描…" : ""}
            </div>
          </div>
          <div className="hero-actions">
            <button className="btn ghost sm" onClick={() => navigate("analyze", { focus: "large" })}>
              查看大文件
            </button>
            <button
              key={allSelected ? "clear-selection" : "select-all"}
              className="btn ghost sm"
              style={{ whiteSpace: "nowrap" }}
              onClick={() =>
                setSelection(allSelected ? [] : selectableTargets.map((target) => target.path))
              }
              disabled={phase !== "preview" || snap.refreshing || selectableTargets.length === 0}
            >
              {allSelected ? "取消全选" : "全选"}
            </button>
            <button className="btn ghost sm" onClick={beginScan} disabled={blocked || phase !== "preview" || snap.refreshing}>
              重新扫描
            </button>
            <button
              className="btn primary sm"
              onClick={() => setClean({ phase: "confirm" })}
              disabled={
                blocked ||
                phase !== "preview" ||
                snap.refreshing ||
                selectedTargets.length === 0
              }
            >
              清理已选
            </button>
          </div>
        </section>
      )}

      {targets.length === 0 && (phase === "preview" || phase === "confirm") && (
        <div className="notice-box">
          当前结果来自旧版缓存。请重新扫描一次，才能按项目勾选并只清理所选内容。
        </div>
      )}

      {(phase === "preview" || phase === "confirm") &&
        targetGroups.map(([section, items]) => {
          const actionable = selectableCleanTargets(items);
          const selectedInGroup = actionable.filter((target) => selectedSet.has(target.path)).length;
          const groupChecked = actionable.length > 0 && selectedInGroup === actionable.length;
          return (
            <div key={section} style={{ marginTop: 18 }}>
              <div className="clean-group-head">
                <label className="clean-group-label">
                  <SelectionCheckbox
                    checked={groupChecked}
                    indeterminate={selectedInGroup > 0 && !groupChecked}
                    label={`选择${translateCategory(section)}中的全部项目`}
                    onChange={() => toggleGroup(actionable)}
                  />
                  <span>{translateCategory(section)}</span>
                </label>
                <span className="hint">
                  已选 {selectedInGroup}/{actionable.length}
                </span>
              </div>
              <section className="panel panel-pad clean-target-panel">
                <div className="row-list">
                  {actionable.map((target) => {
                    const checked = selectedSet.has(target.path);
                    const nestedCount = targets.filter(
                      (candidate) =>
                        candidate.path !== target.path &&
                        isPathWithin(candidate.path, target.path),
                    ).length;
                    return (
                      <label
                        className={`mrow clean-target-row${checked ? " picked" : ""}`}
                        key={target.path}
                        title={target.path}
                      >
                        <SelectionCheckbox
                          checked={checked}
                          label={`选择${cleanTargetLabel(target.path)}`}
                          onChange={() => toggleTarget(target.path)}
                        />
                        <div className="grow">
                          <div className="name">{cleanTargetLabel(target.path)}</div>
                          <div className="sub">
                            {nestedCount > 0
                              ? `包含 ${nestedCount} 个细分目标`
                              : target.itemCount > 1
                                ? `包含 ${target.itemCount} 个项目`
                                : "缓存目标"}
                          </div>
                        </div>
                        <span className="num">
                          {target.sizeText ?? (target.sizeKnown ? formatBytes(target.bytes ?? 0) : "大小未知")}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            </div>
          );
        })}

      {(phase === "preview" || phase === "confirm") && skippedItems.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="clean-group-head">
            <span className="clean-group-label">未能预览的项目</span>
          </div>
          <section className="panel panel-pad">
            <div className="row-list">
              {skippedItems.map(({ category, item }, index) => (
                <div className="mrow" key={`${category}-${item.name}-${index}`}>
                  <span className="clean-skip-mark">{MARK_TEXT.skip}</span>
                  <div className="grow">
                    <div className="name">{translateItemName(item.name)}</div>
                    {report.sudoNote && (
                      <div className="skip-reason">
                        需要管理员权限，未能预览。{" "}
                        <button
                          className="inline-link-btn"
                          onClick={() => void openFullDiskAccess()}
                        >
                          去授权
                        </button>
                        {permissionError && <div className="permission-error">{permissionError}</div>}
                      </div>
                    )}
                  </div>
                  <span className="pill warn">已跳过</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {phase === "running" && (
        <ScanProgress
          label={
            snap.cleanStage === "verifying"
              ? "正在核对所选项目的清理范围…"
              : "正在清理所选项目，请稍候…"
          }
          jobId={snap.scanId}
          startedAt={snap.scanStartedAt || undefined}
          onCancel={cancelCleanScan}
        />
      )}

      {phase === "done" && (
        <>
          <div className="section-title" style={{ margin: "22px 0 12px" }}>清理已结束</div>
          <section className="panel panel-pad">
            <div className="desc">本次仅处理清理前勾选的项目；未选中的项目未被加入清理范围。</div>
            <details className="technical-details">
              <summary>查看 Mole 执行记录</summary>
              <pre className="pre-output">{snap.output || "（无输出）"}</pre>
            </details>
          </section>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={beginScan} disabled={blocked}>重新扫描</button>
          </div>
        </>
      )}

      {phase === "confirm" && (
        <ConfirmSheet
          title="确认清理"
          body={
            <>
              将清理已选中的 <b>{selectedTargets.length}</b> 个清理目标，约{" "}
              <b>{selectedSize}</b>。未选中的项目会保留。清理操作会直接删除文件
              <b>（不经过废纸篓）</b>，请确认不需要这些内容。
            </>
          }
          confirmLabel="清理已选"
          destructive
          onConfirm={() => {
            if (!blocked) runCleanAction();
          }}
          onCancel={() => setClean({ phase: "preview" })}
        />
      )}
    </>
  );
}

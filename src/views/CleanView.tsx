import { useEffect, useState, useSyncExternalStore } from "react";
import {
  moCleanPreview,
  moCleanRun,
  moJobCancel,
  nextJobId,
  isCancelError,
  formatBytes,
  parseCleanPreview,
  type CleanReport,
} from "../lib/mole";
import { ConfirmSheet, ScanProgress, IconSparkle } from "../components";
import { navigate, consumeNavParams } from "../lib/nav";
import { translateCategory, translateItemName } from "../i18n/zh-CN";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CLEAN_CACHE_TTL,
  getCleanCached,
  setCleanCached,
  readCleanPersist,
  persistClean,
} from "../lib/cache";

type InitPhase = "init" | "scanning" | "preview" | "confirm" | "running" | "done";

const MARK_TEXT = { clean: "↳", ok: "✓", skip: "◎", info: "i" } as const;

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

async function startScan(force = false) {
  if (cleanStore.state.scanInFlight) return;
  if (!force) {
    const hit = getCleanCached();
    if (hit && Date.now() - hit.at < CLEAN_CACHE_TTL) {
      setClean({ report: hit.report, hasContent: true, phase: "preview" });
      return;
    }
    if (!hit && !cleanStore.state.hasContent) {
      const disk = await readCleanPersist();
      if (disk) {
        setCleanCached(disk.report);
        setClean({ report: disk.report, hasContent: true, phase: "preview" });
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
    const text = await moCleanPreview(id);
    const parsed = parseCleanPreview(text);
    setCleanCached(parsed);
    persistClean(parsed);
    // 扫描成功：进度条推到 100%，短暂展示后收起（冷启动路径再切结果页）
    setClean({ report: parsed, hasContent: true, scanDone: true, scanInFlight: false });
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
  const id = nextJobId();
  setClean({ phase: "running", output: "", scanId: id, scanInFlight: true });
  try {
    const text = await moCleanRun(id);
    setClean({ output: text, phase: "done", scanInFlight: false });
  } catch (e) {
    setClean({ output: String(e), phase: "done", scanInFlight: false });
  }
}

export default function CleanView() {
  const snap = useSyncExternalStore(subscribeClean, getCleanSnapshot);
  const [focus, setFocus] = useState<string | null>(null);

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
        setClean({ report: hit.report, hasContent: true });
        if (cleanStore.state.phase === "init") setClean({ phase: "preview" });
        return;
      }
      const disk = await readCleanPersist();
      if (disk && !cleanStore.state.hasContent) {
        setCleanCached(disk.report);
        setClean({ report: disk.report, hasContent: true });
        if (cleanStore.state.phase === "init") setClean({ phase: "preview" });
      }
    })();
  }, []);

  if (snap.phase === "scanning")
    return <ScanProgress label="正在扫描可清理的项目…" done={snap.scanDone} jobId={snap.scanId} onCancel={cancelCleanScan} startedAt={snap.scanStartedAt || undefined} />;
  if (snap.error && !snap.report)
    return (
      <div className="error-box">
        {snap.error}
        <button className="btn ghost sm" style={{ marginLeft: 12 }} onClick={() => startScan(true)}>
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
          <button className="btn primary" onClick={() => startScan(true)}>开始扫描</button>
        </div>
      </div>
    );
  }
  if (!snap.report) return null;

  const report = snap.report;
  const phase = snap.phase;
  const showHero = phase === "preview" || phase === "confirm";
  const visibleCategories = focus
    ? report.categories.filter((cat) => {
        const n = cat.name.toLowerCase();
        if (focus === "cache") return n.includes("cache");
        if (focus === "logs") return n.includes("log");
        if (focus === "trash") return n.includes("trash");
        return true;
      })
    : report.categories;

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
          <ScanProgress label="正在重新扫描…" jobId={snap.scanId} startedAt={snap.scanStartedAt || undefined} />
        </div>
      )}

      {showHero && (
        <section className="panel clean-hero" data-drag>
          <div>
            <div className="big">{formatBytes(report.totalBytes)}</div>
            <div className="desc">
              可清理空间 · {report.cleanableCount} 个项目
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
            <button className="btn ghost sm" onClick={() => startScan(true)} disabled={phase !== "preview" || snap.refreshing}>
              重新扫描
            </button>
            <button
              className="btn primary sm"
              onClick={() => setClean({ phase: "confirm" })}
              disabled={phase !== "preview" || snap.refreshing}
            >
              立即清理
            </button>
          </div>
        </section>
      )}

      {(phase === "preview" || phase === "confirm") &&
        visibleCategories.map((cat) => (
          <div key={cat.name} style={{ marginTop: 18 }}>
            <div className="section-title" style={{ margin: "0 0 10px" }}>
              {translateCategory(cat.name)}
              <span className="hint">
                {cat.items.filter((i) => i.mark === "clean" && i.bytes !== null && i.bytes > 0).length} 项可清理
              </span>
            </div>
            <section className="panel panel-pad">
              <div className="row-list">
                {cat.items.map((item, idx) => (
                  <div className="mrow" key={idx}>
                    <span style={{ color: item.mark === "clean" ? "var(--success)" : item.mark === "skip" ? "var(--warning)" : item.mark === "ok" ? "var(--success)" : "var(--accent)", width: 16, textAlign: "center", flex: "none" }}>
                      {MARK_TEXT[item.mark]}
                    </span>
                    <div className="grow">
                      <div className="name">{translateItemName(item.name)}</div>
                    {item.mark === "skip" && report.sudoNote && (
                      <div className="skip-reason">
                        需要管理员权限，未能预览。{" "}
                        <button
                          className="inline-link-btn"
                          onClick={() => openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").catch(() => {})}
                        >
                          去授权
                        </button>
                      </div>
                    )}
                    </div>
                    {item.sizeText && <span className="num">{item.sizeText}</span>}
                    {item.mark === "clean" && <span className="pill info">可清理</span>}
                    {item.mark === "skip" && <span className="pill warn">已跳过</span>}
                    {item.mark === "ok" && <span className="pill ok">无需处理</span>}
                    {item.mark === "info" && <span className="pill idle">信息</span>}
                  </div>
                ))}
              </div>
            </section>
          </div>
        ))}

      {phase === "running" && (
        <ScanProgress
          label="正在清理，请稍候…"
          jobId={snap.scanId}
          startedAt={snap.scanStartedAt || undefined}
          onCancel={cancelCleanScan}
        />
      )}

      {phase === "done" && (
        <>
          <div className="section-title" style={{ margin: "22px 0 12px" }}>执行结果</div>
          <section className="panel panel-pad">
            <pre className="pre-output" style={{ margin: 0, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{snap.output || "（无输出）"}</pre>
          </section>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={() => startScan(true)}>重新扫描</button>
          </div>
        </>
      )}

      {phase === "confirm" && (
        <ConfirmSheet
          title="确认清理"
          body={
            <>
              将清理约 <b>{formatBytes(report.totalBytes)}</b>{" "}
              的缓存、日志和临时文件。清理操作会直接删除文件
              <b>（不经过废纸篓）</b>，请确认不需要这些内容。
            </>
          }
          confirmLabel="清理"
          destructive
          onConfirm={runCleanAction}
          onCancel={() => setClean({ phase: "preview" })}
        />
      )}
    </>
  );
}

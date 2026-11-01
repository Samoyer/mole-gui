import { useCallback, useEffect, useRef, useState } from "react";
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
import { ConfirmSheet, ScanProgress } from "../components";
import {
  CLEAN_CACHE_TTL,
  getCleanCached,
  setCleanCached,
  readCleanPersist,
  persistClean,
} from "../lib/cache";

type InitPhase = "init" | "scanning" | "preview" | "confirm" | "running" | "done";

const MARK_TEXT = { clean: "↳", ok: "✓", skip: "◎", info: "i" } as const;

export default function CleanView() {
  const [phase, setPhase] = useState<InitPhase>("init");
  const [report, setReport] = useState<CleanReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [scanDone, setScanDone] = useState(false);
  const mounted = useRef(true);
  const scanId = useRef(0);
  const scanInFlight = useRef(false);
  const hasContent = useRef(false);

  const scan = useCallback(async (force = false) => {
    if (!force) {
      const hit = getCleanCached();
      if (hit && Date.now() - hit.at < CLEAN_CACHE_TTL) {
        setReport(hit.report);
        setPhase("preview");
        return;
      }
      if (!hit) {
        const disk = await readCleanPersist();
        if (!mounted.current) return;
        if (disk) {
          setCleanCached(disk.report);
          hasContent.current = true;
          setReport(disk.report);
          setPhase("preview");
        }
      }
    }
    const id = nextJobId();
    scanId.current = id;
    scanInFlight.current = true;
    if (hasContent.current) {
      setRefreshing(true);
    } else {
      setScanDone(false);
      setPhase("scanning");
    }
    setError(null);
    let errored = false;
    try {
      const text = await moCleanPreview(id);
      if (!mounted.current) return;
      const parsed = parseCleanPreview(text);
      setCleanCached(parsed);
      persistClean(parsed);
      hasContent.current = true;
      setReport(parsed);
      // 扫描成功：先把进度条推到 100%，短暂展示后切换到结果页
      setScanDone(true);
      window.setTimeout(() => {
        if (mounted.current) setPhase("preview");
      }, 600);
    } catch (e) {
      if (mounted.current && !isCancelError(e)) {
        errored = true;
        setError(String(e));
        if (!report) {
          setOutput(String(e));
          setPhase("done");
        }
      }
    } finally {
      scanInFlight.current = false;
      if (mounted.current) {
        setRefreshing(false);
        // 出错时保留错误页面，不能把 phase 重置回 init 把错误吞掉
        if (!errored && !hasContent.current && !report) setPhase("init");
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    hasContent.current = !!getCleanCached();
    if (hasContent.current) {
      const hit = getCleanCached()!;
      setReport(hit.report);
      setPhase("preview");
      return;
    }
    readCleanPersist().then((disk) => {
      if (!mounted.current || !disk) return;
      setCleanCached(disk.report);
      hasContent.current = true;
      setReport(disk.report);
      setPhase("preview");
    });
    return () => {
      mounted.current = false;
      if (scanInFlight.current) moJobCancel(scanId.current).catch(() => {});
    };
  }, []);

  const runClean = async () => {
    setPhase("running");
    setOutput("");
    const id = nextJobId();
    scanId.current = id;
    scanInFlight.current = true;
    try {
      const text = await moCleanRun(id);
      if (mounted.current) {
        setOutput(text);
        setPhase("done");
      }
    } catch (e) {
      if (mounted.current) {
        setOutput(String(e));
        setPhase("done");
      }
    } finally {
      scanInFlight.current = false;
    }
  };

  if (phase === "scanning") return <ScanProgress label="正在扫描可清理的项目…" done={scanDone} jobId={scanId.current} />;
  if (error && !report)
    return (
      <div className="error-box">
        {error}
        <button className="btn ghost sm" style={{ marginLeft: 12 }} onClick={() => scan(true)}>
          重试
        </button>
      </div>
    );
  if (phase === "init" && !report) {
    return (
      <section className="panel clean-hero" data-drag>
        <div className="clean-hero-empty">
          <div className="big">{formatBytes(0)}</div>
          <div className="desc">点击开始扫描，查找可清理的缓存、日志和临时文件</div>
          <button className="btn primary" onClick={() => scan(true)}>开始扫描</button>
        </div>
      </section>
    );
  }
  if (!report) return null;

  const showHero = phase === "preview" || phase === "confirm";

  return (
    <>
      {report.sudoNote && (
        <div className="notice-box">
          部分系统缓存需要管理员权限才能预览，本次仅显示用户空间可清理的内容。
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
              {refreshing ? " · 正在重新扫描…" : ""}
            </div>
          </div>
          <div className="hero-actions">
            <button className="btn ghost sm" onClick={() => scan(true)} disabled={phase !== "preview" || refreshing}>
              重新扫描
            </button>
            <button
              className="btn primary sm"
              onClick={() => setPhase("confirm")}
              disabled={phase !== "preview" || refreshing}
            >
              立即清理
            </button>
          </div>
        </section>
      )}

      {(phase === "preview" || phase === "confirm") &&
        report.categories.map((cat) => (
          <div key={cat.name} style={{ marginTop: 18 }}>
            <div className="section-title" style={{ margin: "0 0 10px" }}>
              {cat.name}
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
                      <div className="name">{item.name}</div>
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
          jobId={scanId.current}
          onCancel={() => moJobCancel(scanId.current).catch(() => {})}
        />
      )}

      {phase === "done" && (
        <>
          <div className="section-title" style={{ margin: "22px 0 12px" }}>执行结果</div>
          <section className="panel panel-pad">
            <pre className="pre-output" style={{ margin: 0, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{output || "（无输出）"}</pre>
          </section>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={() => scan(true)}>重新扫描</button>
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
          onConfirm={runClean}
          onCancel={() => setPhase("preview")}
        />
      )}
    </>
  );
}

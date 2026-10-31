import { useCallback, useEffect, useRef, useState } from "react";
import {
  moAnalyze,
  moJobCancel,
  nextJobId,
  isCancelError,
  parseJson,
  formatBytes,
  type AnalyzeData,
} from "../lib/mole";
import {
  ANALYZE_CACHE_TTL,
  analyzeOverviewKey,
  getAnalyzeCached,
  setAnalyzeCached,
  readAnalyzePersist,
  persistAnalyze,
} from "../lib/cache";
import { IconFile, IconFolder, IconReveal, ScanProgress } from "../components";
import Treemap from "../components/Treemap";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

interface Crumb {
  label: string;
  path: string | null;
}

function formatAgo(at: number): string {
  const m = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

type InitPhase = "init" | "scanning" | "ready" | "refreshing";

export default function AnalyzeView() {
  const [data, setData] = useState<AnalyzeData | null>(null);
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ label: "概览", path: null }]);
  const [phase, setPhase] = useState<InitPhase>("init");
  const [error, setError] = useState<string | null>(null);
  const [scanDone, setScanDone] = useState(false);
  const mounted = useRef(true);
  const jobId = useRef(0);
  const jobInFlight = useRef(false);
  const hasContent = useRef(false);

  const load = useCallback(async (path: string | null, force = false) => {
    const key = path ?? analyzeOverviewKey;
    if (!force) {
      const hit = getAnalyzeCached(key);
      if (hit && Date.now() - hit.at < ANALYZE_CACHE_TTL) {
        setData(hit.data);
        setStaleAt(null);
        setPhase("ready");
        setError(null);
        return;
      }
      if (!hit) {
        const disk = await readAnalyzePersist(key);
        if (!mounted.current) return;
        if (disk) {
          setAnalyzeCached(key, disk.data);
          hasContent.current = true;
          setStaleAt(disk.at);
          setData(disk.data);
          setPhase("ready");
        }
      }
    }
    const id = nextJobId();
    jobId.current = id;
    jobInFlight.current = true;
    setScanDone(false);
    if (!hasContent.current) setPhase("scanning");
    else setPhase("refreshing");
    setError(null);
    try {
      const raw = await moAnalyze(path ?? undefined, id);
      if (!mounted.current) return;
      const parsed = parseJson<AnalyzeData>(raw);
      setAnalyzeCached(key, parsed);
      persistAnalyze(key, parsed);
      setStaleAt(null);
      hasContent.current = true;
      setData(parsed);
      // 扫描成功：先把进度条推到 100%，短暂展示后切换到结果页
      setScanDone(true);
      window.setTimeout(() => {
        if (mounted.current) setPhase("ready");
      }, 600);
    } catch (e) {
      if (mounted.current && !isCancelError(e)) {
        setError(String(e));
        if (!hasContent.current) setPhase("init");
      }
    } finally {
      jobInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    hasContent.current = !!getAnalyzeCached(analyzeOverviewKey);
    if (hasContent.current) {
      const hit = getAnalyzeCached(analyzeOverviewKey)!;
      setData(hit.data);
      setPhase("ready");
      return;
    }
    // 没有内存缓存：异步读磁盘缓存，不阻塞首帧
    readAnalyzePersist(analyzeOverviewKey).then((disk) => {
      if (!mounted.current || !disk) return;
      setAnalyzeCached(analyzeOverviewKey, disk.data);
      hasContent.current = true;
      setStaleAt(disk.at);
      setData(disk.data);
      setPhase("ready");
    });
    return () => {
      mounted.current = false;
      if (jobInFlight.current) moJobCancel(jobId.current).catch(() => {});
    };
  }, []);

  const drill = (path: string, label: string) => {
    setCrumbs((c) => [...c, { label, path }]);
    load(path);
  };

  const jump = (idx: number) => {
    const target = crumbs[idx];
    setCrumbs(crumbs.slice(0, idx + 1));
    load(target.path);
  };

  const entries = data?.entries ?? [];
  const max = Math.max(1, ...entries.map((e) => e.size));

  const reveal = (ev: { stopPropagation?: () => void }, path: string) => {
    ev.stopPropagation?.();
    revealItemInDir(path).catch(() => {});
  };

  return (
    <>
      <div className="crumbs" style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 14, fontSize: 13 }}>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span className="sep" style={{ color: "var(--muted)" }}>›</span>}
            <button onClick={() => jump(i)} style={{ background: "none", border: 0, color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0 }}>{c.label}</button>
          </span>
        ))}
        {data && (
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            {data.scan_status === "complete" ? "扫描完成" : "部分结果"}
            {data.total_size ? ` · 共 ${formatBytes(data.total_size)}` : ""}
            {staleAt ? ` · 上次扫描${formatAgo(staleAt)}` : ""}
            {phase === "refreshing" ? " · 正在刷新…" : ""}
          </span>
        )}
        <button
          className="btn ghost sm"
          style={{ marginLeft: 10 }}
          onClick={() => load(crumbs[crumbs.length - 1].path, true)}
          disabled={phase === "scanning" || phase === "refreshing"}
        >
          刷新
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {phase === "scanning" && <ScanProgress label="正在扫描磁盘占用…" done={scanDone} />}

      {phase === "init" && !data && (
        <section className="panel" data-drag>
          <div className="clean-hero-empty">
            <div className="big">尚未扫描过磁盘</div>
            <div className="desc">扫描需要几十秒，开始后可以逐级查看各目录的占用</div>
            <button className="btn primary" onClick={() => load(null)}>开始扫描</button>
          </div>
        </section>
      )}

      {phase !== "scanning" && phase !== "init" && data && (
        <>
          {entries.length > 0 && (
            <>
              <div className="section-title" style={{ margin: "18px 0 12px" }}>
                空间分布
                <span className="hint">方块大小代表占用 · 点击文件夹下钻</span>
              </div>
              <Treemap
                items={entries.map((e) => ({
                  name: e.name,
                  path: e.path,
                  size: e.size,
                  isDir: e.is_dir,
                }))}
                onPick={drill}
              />
            </>
          )}

          {data.large_files && data.large_files.length > 0 && (
            <>
              <div className="section-title" style={{ margin: "22px 0 12px" }}>
                大文件
                <span className="hint">当前范围内最大的文件 · 点眼睛在访达中查看</span>
              </div>
              <section className="panel panel-pad">
                <div className="row-list">
                  {data.large_files.slice(0, 5).map((f) => (
                    <div className="mrow" key={f.path}>
                      <span style={{ color: "var(--muted)", display: "grid", placeItems: "center", flex: "none" }}><IconFile size={15} /></span>
                      <div className="grow">
                        <div className="name">{f.name}</div>
                        <div className="sub">{f.path}</div>
                      </div>
                      <div className="row-right">
                        <span className="num">{formatBytes(f.size)}</span>
                        <span></span>
                        <button className="icon-btn" title="在访达中显示" onClick={(e) => reveal(e, f.path)}>
                          <IconReveal size={14} />
                        </button>
                        <span></span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          <div className="section-title" style={{ margin: "22px 0 12px" }}>
            {data.overview ? "存储占用概览" : "目录内容"}
            <span className="hint">{entries.length} 项 · 点击文件夹可深入</span>
          </div>
          <section className="panel panel-pad">
            <div className="row-list">
              {entries.length === 0 && <div style={{ padding: "24px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>这个目录是空的</div>}
              {entries.map((e) => (
                <div
                  className={`mrow ${e.is_dir ? "clickable" : ""}`}
                  key={e.path}
                  style={e.is_dir ? { cursor: "pointer" } : undefined}
                  onClick={() => e.is_dir && drill(e.path, e.name)}
                >
                  <span style={{ color: e.is_dir ? "var(--accent)" : "var(--muted)", display: "grid", placeItems: "center", flex: "none" }}>
                    {e.is_dir ? <IconFolder size={15} /> : <IconFile size={15} />}
                  </span>
                  <div className="grow">
                    <div className="name">{e.name}</div>
                  </div>
                  <div className="row-right">
                    <div className="progress-wrap">
                      <div className="progress-track"><i className={e.size / max > 0.85 ? "orange" : ""} style={{ width: `${Math.max(1.5, (e.size / max) * 100)}%` }} /></div>
                    </div>
                    <span className="num">{formatBytes(e.size)}</span>
                    <button className="icon-btn" title="在访达中显示" onClick={(ev) => reveal(ev, e.path)}>
                      <IconReveal size={14} />
                    </button>
                    {e.scan_status !== "complete" ? (
                      <span className={`pill ${e.scan_status === "partial" ? "warn" : "idle"}`}>
                        {e.scan_status === "partial" ? "部分" : "不可用"}
                      </span>
                    ) : <span></span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import {
  moUninstallList,
  moUninstallPreview,
  moUninstallRun,
  moJobCancel,
  nextJobId,
  uninstallRunFailed,
  isCancelError,
  parseJson,
  type AppEntry,
  parseUninstallPreview,
  type UninstallPreview,
} from "../lib/mole";
import { getAppsCache, setAppsCache } from "../lib/cache";
import { navigate } from "../lib/nav";
import { formatLastUsedZh } from "../i18n/zh-CN";
import { ConfirmSheet, IconSearch } from "../components";

type Phase = "loading" | "ready" | "confirm" | "running";

const previewCache = new Map<string, { text: string; at: number }>();
const PREVIEW_CACHE_TTL = 10 * 60 * 1000;

export default function UninstallView() {
  const [apps, setApps] = useState<AppEntry[]>(() => getAppsCache()?.apps ?? []);
  const [phase, setPhase] = useState<Phase>(() => (getAppsCache() ? "ready" : "loading"));
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AppEntry | null>(null);
  const [preview, setPreview] = useState<UninstallPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [result, setResult] = useState("");
  const [runFailed, setRunFailed] = useState(false);
  const [dropError, setDropError] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [lastRun, setLastRun] = useState<{ name: string; permanent: boolean; size: string } | null>(null);
  const mounted = useRef(true);
  const appsRef = useRef<AppEntry[]>([]);
  const previewReq = useRef(0);
  const previewId = useRef(0);
  const previewInFlight = useRef(false);
  const listId = useRef(0);
  const listInFlight = useRef(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  useEffect(() => {
    const win = getCurrentWindow();
    const onDrop = (paths: string[]) => {
      setDropError("");
      const appPath = paths.find((p) => p.endsWith(".app"));
      if (!appPath) {
        // 拖入的不是应用就把操作挡在 UI 层，不能拿任意路径名去碰 mo uninstall
        setDropError("只能拖入 .app 应用");
        return;
      }
      if (!appPath) return;
      const base = appPath.split("/").filter(Boolean).pop() ?? "";
      const name = base.endsWith(".app") ? base.slice(0, -4) : base;
      if (!name) return;
      const known = appsRef.current.find(
        (a) => a.path === appPath || a.name === name || a.uninstall_name === name,
      );
      pick(known ?? { name, bundle_id: "", source: "拖拽", uninstall_name: name, path: appPath, size: "" });
    };
    let pending: Promise<() => void> | null = null;
    pending = win.onDragDropEvent((e: { payload: DragDropEvent }) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDropActive(true);
      else if (p.type === "leave") setDropActive(false);
      else if (p.type === "drop") {
        setDropActive(false);
        onDrop(p.paths);
      }
    });
    return () => {
      pending?.then((un) => un()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (previewInFlight.current) moJobCancel(previewId.current).catch(() => {});
      if (listInFlight.current) moJobCancel(listId.current).catch(() => {});
    };
  }, []);

  const refresh = async () => {
    const id = nextJobId();
    runIdRef.current = id;
    listId.current = id;
    listInFlight.current = true;
    try {
      const raw = await moUninstallList(id);
      const list = parseJson<AppEntry[]>(raw);
      setAppsCache(list);
      if (!mounted.current) return;
      setApps(list);
      setError(null);
    } catch (e) {
      if (mounted.current && !isCancelError(e) && getAppsCache() === null) setError(String(e));
    } finally {
      listInFlight.current = false;
      if (mounted.current) setPhase("ready");
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.bundle_id.toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q),
    );
  }, [apps, query]);

  const pick = async (app: AppEntry) => {
    setSelected(app);
    setResult("");
    setPreviewError(null);
    const cached = previewCache.get(app.uninstall_name);
    if (cached && Date.now() - cached.at < PREVIEW_CACHE_TTL) {
      setPreview(parseUninstallPreview(cached.text, app.name));
      setPreviewLoading(false);
      return;
    }
    setPreview(null);
    setPreviewLoading(true);
    const req = ++previewReq.current;
    const jid = nextJobId();
    previewId.current = jid;
    previewInFlight.current = true;
    try {
      const text = await moUninstallPreview(app.uninstall_name, jid);
      previewCache.set(app.uninstall_name, { text, at: Date.now() });
      if (mounted.current && req === previewReq.current)
        setPreview(parseUninstallPreview(text, app.name));
    } catch (e) {
      if (mounted.current && req === previewReq.current && !isCancelError(e))
        setPreviewError(String(e));
    } finally {
      previewInFlight.current = false;
      if (mounted.current && req === previewReq.current) setPreviewLoading(false);
    }
  };

  const run = async () => {
    if (!selected) return;
    setPhase("running");
    const ran = selected;
    const id = nextJobId();
    try {
      const text = await moUninstallRun(selected.uninstall_name, permanent, id);
      if (!mounted.current) return;
      const failed = uninstallRunFailed(text);
      setRunFailed(failed);
      setResult(text);
      // 失败时不能显示"已删除"横幅，也不能假装列表是最新的
      if (!failed) {
        setLastRun({ name: ran.name, permanent, size: ran.size });
        const raw = await moUninstallList(nextJobId());
        const list = parseJson<AppEntry[]>(raw);
        setAppsCache(list);
        if (mounted.current) setApps(list);
      }
    } catch (e) {
      if (mounted.current) setResult(String(e));
    } finally {
      if (mounted.current) {
        setPhase("ready");
        setSelected(null);
      }
    }
  };

  if (phase === "loading") {
    return (
      <section className="panel" data-drag>
        <div className="clean-hero-empty">
          <div className="big">尚未读取应用列表</div>
          <div className="desc">读取需要几秒钟，之后可搜索并卸载应用</div>
          <button className="btn primary" onClick={() => { setPhase("ready"); refresh(); }}>读取应用列表</button>
        </div>
      </section>
    );
  }

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div className="split-view">
        <div style={{ position: "relative", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", display: "grid" }}>
                <IconSearch size={13} />
              </span>
              <input
                className="input"
                placeholder="搜索应用名称、路径…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingLeft: 32, width: "100%" }}
              />
            </div>
            <button className="btn ghost sm" onClick={() => refresh()} disabled={listInFlight.current}>刷新</button>
          </div>

          <section className="panel panel-pad" data-drag style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
            <div className="row-list">
              {filtered.length === 0 && (
                <div style={{ padding: "24px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>没有匹配的应用</div>
              )}
              {filtered.map((app) => (
                <div
                  className={`mrow clickable ${selected?.path === app.path ? "selected" : ""}`}
                  key={app.path}
                  style={{
                    cursor: "pointer",
                    background: selected?.path === app.path ? "var(--mat-active-bg)" : undefined,
                    borderRadius: `calc(12px * var(--corner-scale, 1))`,
                    padding: "10px 12px",
                    margin: "-1px -1px",
                    border: "1px solid transparent",
                  }}
                  onClick={() => pick(app)}
                >
                  <div className="grow">
                    <div className="name">{app.name}</div>
                    <div className="ios-row-sub">{app.size || "大小未知"}</div>
                  </div>
                  <span className={`pill ${app.source === "App Store" ? "info" : app.source === "拖拽" ? "warn" : "idle"}`}>{app.source}</span>
                </div>
              ))}
            </div>
          </section>

          <div style={{ marginTop: 10, paddingLeft: 2, fontSize: 11.5, color: "var(--muted)" }}>
            共 {apps.length} 个应用{query && `，匹配 ${filtered.length} 个`}
          </div>

          {dropActive && (
            <div style={{ position: "absolute", inset: 0, borderRadius: `calc(var(--mat-radius, 22px) * var(--corner-scale, 1))`, border: "2px dashed var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, transparent)", display: "grid", placeItems: "center", zIndex: 10 }}>
              <div style={{ color: "var(--accent)", fontWeight: 650, fontSize: 14 }}>松开以卸载该应用</div>
            </div>
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          {!selected && !result && (
            <section className="panel panel-pad" data-drag>
              <div className="clean-hero-empty">
                <div className="big" style={{ fontSize: 15 }}>在左侧选择一个应用</div>
                <div className="desc">或把 .app 从访达拖进窗口，选中后会显示卸载预览</div>
              {dropError && <div className="error-box" style={{ marginTop: 10 }}>{dropError}</div>}
              </div>
            </section>
          )}

          {selected && (
            <section className="panel panel-pad" data-drag>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.015em" }}>{selected.name}</div>
                <span className={`pill ${selected.source === "App Store" ? "info" : "idle"}`}>{selected.bundle_id || selected.source}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontFamily: "ui-monospace, Consolas, monospace", wordBreak: "break-all", marginBottom: 14 }}>
                {selected.path}
              </div>

              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>卸载预览</div>
              {previewLoading ? (
                <div className="stat-label" style={{ padding: "12px 0" }}>正在生成卸载预览…</div>
              ) : previewError ? (
                <div className="error-box">{previewError}</div>
              ) : preview ? (
                <div className="uninst-nl">
                  <div className="nl-section">预览模式：不会删除任何文件</div>
                  <div className="nl-section">
                    将移除 <b>{preview.appName}</b>
                    {preview.appSize && <> 本体（{preview.appSize}）</>}
                    {(() => {
                      const support = preview.files.filter((f) => !f.path.endsWith(".app"));
                      if (support.length === 0) return null;
                      const sizes = support.map((f) => f.size).filter(Boolean) as string[];
                      return (
                        <>
                          {" "}及支持文件（{support.length} 处{sizes.length > 0 ? `，约 ${sizes.join(" + ")}` : ""}）
                        </>
                      );
                    })()}
                    {preview.lastUsedRaw && (() => {
                      const zh = formatLastUsedZh(preview.lastUsedRaw);
                      return zh ? <>，最近使用：{zh}</> : null;
                    })()}
                  </div>
                  {preview.kept.length > 0 && (
                    <div className="nl-section">
                      你的项目、录音等个人数据将保留
                      <div style={{ marginTop: 4 }}>
                        {preview.kept.slice(0, 8).map((k) => (
                          <div key={k} className="path-mono" data-break="path" title={k} style={{ maxWidth: 420 }}>
                            {k}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {preview.reviewOnly.length > 0 && (
                    <div className="nl-section">
                      以下内容仅审查，不会删除：
                      <div style={{ marginTop: 4 }}>
                        {preview.reviewOnly.slice(0, 6).map((k) => (
                          <div key={k} className="path-mono" data-break="path" title={k} style={{ maxWidth: 420 }}>
                            {k}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <details className="tech-details">
                    <summary>技术详情（原始输出）</summary>
                    <pre className="pre-output" style={{ maxHeight: 240, overflow: "auto", marginTop: 8 }}>{preview.raw}</pre>
                  </details>
                </div>
              ) : (
                <div className="stat-label" style={{ padding: "12px 0" }}>（预览无内容）</div>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  margin: "14px 0",
                  fontSize: 12.5,
                  color: "var(--text-2)",
                  cursor: "default",
                }}
              >
                <input
                  type="checkbox"
                  checked={permanent}
                  onChange={(e) => setPermanent(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                彻底删除（跳过废纸篓，不可恢复）
              </label>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  className="btn ghost sm"
                  disabled={phase === "running"}
                  onClick={() => setSelected(null)}
                >
                  取消
                </button>
                <button
                  className="btn sm"
                  disabled={phase === "running"}
                  onClick={() => setPhase("confirm")}
                  style={{ color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 32%, var(--line))" }}
                >
                  {permanent ? "彻底删除" : "移到废纸篓"}
                </button>
              </div>
            </section>
          )}

          {result && !selected && (
            <>
              {lastRun && (
                <section
                  className="panel panel-pad"
                  style={{
                    marginBottom: 12,
                    borderLeft: `3px solid ${lastRun.permanent ? "var(--danger)" : "var(--success)"}`,
                  }}
                >
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-2)" }}>
                    <b style={{ color: "var(--text)" }}>{lastRun.name}</b>{" "}
                    {lastRun.permanent
                      ? "已彻底删除，文件不可恢复。"
                      : "已移到废纸篓 — 如需恢复，打开废纸篓右键「放回原处」。"}
                    {lastRun.size && <span> 已释放 {lastRun.size}。</span>}
                    <div style={{ marginTop: 10 }}>
                      <button className="btn ghost sm" onClick={() => navigate("status")}>返回状态总览</button>
                    </div>
                  </div>
                </section>
              )}
              <section className="panel panel-pad" style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: runFailed ? "var(--danger)" : undefined }}>
                  {runFailed ? "卸载未执行" : "执行结果"}
                </div>
                <pre style={{
                  margin: 0,
                  fontFamily: "ui-monospace, Consolas, monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: "var(--text-2)",
                }}>
                  {result}
                </pre>
              </section>
              <button className="btn ghost sm" onClick={() => { setResult(""); setRunFailed(false); }}>关闭</button>
            </>
          )}
        </div>
      </div>

      {phase === "running" && (
        <div className="empty-state" style={{ padding: "48px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          <div className="spinner" style={{ margin: "0 auto 12px" }} />
          <div>正在卸载 {selected?.name}…</div>
          <button
            className="btn ghost sm"
            style={{ marginTop: 12 }}
            onClick={() => moJobCancel(runIdRef.current).catch(() => {})}
          >
            取消
          </button>
        </div>
      )}

      {phase === "confirm" && selected && (
        <ConfirmSheet
          title={permanent ? "彻底删除应用" : "卸载应用"}
          body={
            <>
              将卸载 <b>{selected.name}</b> 及其关联文件。
              {permanent
                ? "文件会被立即删除，不可恢复。"
                : "文件会移到废纸篓，可从废纸篓恢复。"}
            </>
          }
          confirmLabel={permanent ? "彻底删除" : "移到废纸篓"}
          destructive
          onConfirm={run}
          onCancel={() => setPhase("ready")}
        />
      )}
    </>
  );
}

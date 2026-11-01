import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  moStatus,
  moStatusWatchStart,
  parseJson,
  formatBytes,
  formatRate,
  type StatusData,
} from "../lib/mole";
import {
  getStatusCache,
  setStatusCache,
  readStatusPersist,
  persistStatus,
  getCleanCached,
  readCleanPersist,
  getAnalyzeCached,
  readAnalyzePersist,
  analyzeOverviewKey,
} from "../lib/cache";
import { navigate } from "../lib/nav";
import { mountName, smartLabel, ifaceName } from "../i18n/zh-CN";
import { Spinner, pctClass } from "../components";

// mo 在权限受限（TCC 被拒等）时会输出 null 字段而不是空数组，
// 任何一处直接 .map/.toFixed 都会崩掉整棵 React 树把窗口变白屏，
// 所以所有数据入口必须先过这一层兜底
function normalizeStatus(s: StatusData): StatusData {
  return {
    ...s,
    cpu: s.cpu ?? { usage: 0, load1: 0, load5: 0, load15: 0, core_count: 0 },
    memory: s.memory ?? { used: 0, total: 0, available: 0, used_percent: 0, swap_used: 0 },
    disks: s.disks ?? [],
    disk_io: s.disk_io ?? { read_rate: 0, write_rate: 0 },
    network: s.network ?? [],
    thermal: s.thermal ?? { system_power: 0, fan_speed: 0 },
    top_processes: s.top_processes ?? [],
  };
}

const SYSTEM_PROCS = new Set([
  "windowserver", "kernel_task", "launchd", "loginwindow", "bluetoothd",
  "coreaudiod", "mds", "mds_stores", "powerd", "hidd", "configd",
  "distnoted", "airportd", "dock", "finder", "spotlight", "spotlightui",
  "systemuiserver", "cfprefsd", "securityd", "sysmond", "logd",
]);

function isSystemProc(name: string): boolean {
  return SYSTEM_PROCS.has(name.toLowerCase().replace(/\s+/g, ""));
}

export default function StatusView() {
  const [data, setData] = useState<StatusData | null>(() => {
    const cached = getStatusCache();
    return cached ? normalizeStatus(cached) : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(() => !!getStatusCache());
  const [cleanable, setCleanable] = useState<number | null>(() => getCleanCached()?.report.totalBytes ?? null);
  const [bigFiles, setBigFiles] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // 可清理空间：先内存缓存，再磁盘持久缓存
    if (cleanable === null) {
      readCleanPersist().then((disk) => {
        if (alive && disk) setCleanable(disk.report.totalBytes);
      });
    }
    // 大文件提醒：磁盘分析缓存里 >1GB 的项目数
    const hit = getAnalyzeCached(analyzeOverviewKey);
    if (hit) {
      setBigFiles((hit.data.large_files ?? []).filter((f) => f.size > 1024 ** 3).length);
    } else {
      readAnalyzePersist(analyzeOverviewKey).then((disk) => {
        if (alive && disk) {
          setBigFiles((disk.data.large_files ?? []).filter((f) => f.size > 1024 ** 3).length);
        }
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    if (!getStatusCache()) {
      readStatusPersist().then((disk) => {
        if (!alive || !disk || getStatusCache()) return;
        const norm = normalizeStatus(disk.data);
        setStatusCache(norm);
        setData(norm);
      });
    }
    let pollTimer: number | null = null;
    let safetyTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let lastRef = getStatusCache();
    let lastFrameAt = lastRef ? Date.now() : 0;
    let lastHardwareAt = lastRef?.hardware?.model ? Date.now() : 0;
    let polling = false;

    const applyRaw = (raw: string) => {
      const next = parseJson<StatusData>(raw);
      if (lastRef) {
        if (next.hardware?.model) {
          lastHardwareAt = Date.now();
        } else if (lastRef.hardware && Date.now() - lastHardwareAt < 120000) {
          next.hardware = lastRef.hardware;
        }
        if ((!next.top_processes || next.top_processes.length === 0) && lastRef.top_processes) {
          next.top_processes = lastRef.top_processes;
        }
      }
      lastFrameAt = Date.now();
      const norm = normalizeStatus(next);
      lastRef = norm;
      setStatusCache(norm);
      persistStatus(norm);
      setData(norm);
      setLive(true);
    };

    const stopPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const raw = await moStatus();
        if (!alive) return;
        applyRaw(raw);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        polling = false;
      }
    };

    const startPolling = () => {
      if (pollTimer === null) {
        poll();
        pollTimer = window.setInterval(poll, 5000);
      }
    };

    (async () => {
      try {
        await moStatusWatchStart();
        unlisten = await listen<string>("mole://status", (ev) => {
          if (!alive) return;
          try {
            applyRaw(ev.payload);
            setError(null);
            stopPolling();
          } catch {
          }
        });
      } catch (e) {
        if (alive) setError(String(e));
        startPolling();
      }
    })();

    if (!lastRef) {
      poll();
      safetyTimer = window.setTimeout(() => {
        if (alive && !lastRef) startPolling();
      }, 6000);
    }

    heartbeatTimer = window.setInterval(() => {
      if (alive && !polling && Date.now() - lastFrameAt > 10000) {
        moStatusWatchStart().catch(() => {});
      }
    }, 5000);

    return () => {
      alive = false;
      if (unlisten) unlisten();
      stopPolling();
      if (safetyTimer !== null) window.clearTimeout(safetyTimer);
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    };
  }, []);

  if (error && !data) return <div className="error-box">{error}</div>;
  if (!data) return <Spinner label="正在读取系统状态…" />;

  const mainDisk = data.disks.find((d) => d.mount === "/") ?? data.disks[0];
  const externalDisks = data.disks.filter((d) => d.external);
  const diskPct = mainDisk ? Math.round(mainDisk.used_percent) : null;
  const health = mainDisk?.smart_status === "verified" ? "good" : mainDisk?.smart_status ? "warn" : "unknown";
  const healthText = smartLabel(mainDisk?.smart_status);
  const cpuPct = Math.round(data.cpu.usage);
  const memPct = Math.round(data.memory.used_percent);

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div className="dash-grid">
        <section className="dash-card" data-drag>
          <div className="dash-title">存储健康</div>
          <div className="dash-main">
            <span className="stat-num-lg">
              {diskPct !== null ? <>{diskPct}<em>%</em></> : "--"}
            </span>
            <span className="stat-label">Macintosh HD 已使用</span>
          </div>
          <div className="progress-track"><i className={diskPct !== null ? pctClass(diskPct) : ""} style={{ width: `${diskPct ?? 0}%` }} /></div>
          <div className="dash-sub">
            <span className={`health-dot ${health}`} />
            磁盘状况：{healthText}
            {mainDisk && (
              <span className="tip" title={`SMART: ${mainDisk.smart_status ?? "unknown"}`}>
                {" "}· 剩余 {formatBytes(mainDisk.total - mainDisk.used)}
              </span>
            )}
          </div>
          {externalDisks.map((d) => (
            <div className="dash-sub" key={d.mount}>
              <span className="tip" title={d.mount}>{mountName(d.mount)}</span>
              {" "}· 已用 {formatBytes(d.used)} / {formatBytes(d.total)}
            </div>
          ))}
        </section>

        <section className="dash-card" data-drag>
          <div className="dash-title">可清理空间</div>
          <div className="dash-main">
            {cleanable !== null && cleanable > 0 ? (
              <span className="stat-num-lg num-key">{formatBytes(cleanable)}</span>
            ) : (
              <span className="stat-num-lg">--</span>
            )}
          </div>
          <div className="dash-sub">
            {cleanable !== null && cleanable > 0
              ? "来自上次深度清理扫描的预估"
              : "还未扫描过，去深度清理页开始第一次扫描"}
          </div>
          <div className="dash-actions">
            <button className="btn primary sm" onClick={() => navigate("clean")}>去清理</button>
          </div>
        </section>

        <section className="dash-card" data-drag>
          <div className="dash-title">大文件提醒</div>
          <div className="dash-main">
            <span className="stat-num-lg">{bigFiles === null ? "--" : bigFiles}<em> 个</em></span>
          </div>
          <div className="dash-sub">
            {bigFiles === null
              ? "完成一次磁盘分析后，这里会提醒大文件"
              : bigFiles > 0
                ? "发现大于 1GB 的项目，可去磁盘分析确认"
                : "当前没有大于 1GB 的项目"}
          </div>
          <div className="dash-actions">
            <button className="btn ghost sm" disabled={bigFiles === null} onClick={() => navigate("analyze")}>
              查看
            </button>
          </div>
        </section>
      </div>

      <details className="pro-mode" style={{ marginTop: 20 }}>
        <summary>专业模式（实时指标、存储、网络、进程）</summary>
        <div className="pro-body">
          <div className="stat-strip three" style={{ marginBottom: 4 }}>
            <div className="panel stat-tile">
              <span className="stat-label">CPU 占用</span>
              <b className="stat-num-md">{cpuPct}<em>%</em></b>
              <div className="progress-track"><i className={pctClass(cpuPct)} style={{ width: `${cpuPct}%` }} /></div>
              <small className="stat-label">负载 {data.cpu.load1.toFixed(1)} · {data.cpu.core_count} 核</small>
            </div>
            <div className="panel stat-tile">
              <span className="stat-label">内存</span>
              <b className="stat-num-md">{memPct}<em>%</em></b>
              <div className="progress-track"><i className={pctClass(memPct)} style={{ width: `${memPct}%` }} /></div>
              <small className="stat-label">已用 {formatBytes(data.memory.used)} / {formatBytes(data.memory.total)}</small>
            </div>
            <div className="panel stat-tile">
              <span className="stat-label">磁盘读写</span>
              <b className="stat-num-md">{formatRate(data.disk_io.read_rate)}</b>
              <small className="stat-label">写入 {formatRate(data.disk_io.write_rate)} · {live ? "每 2 秒自动刷新" : "正在连接实时数据…"}</small>
            </div>
          </div>

          <div className="split-view">
            <section className="ios-group">
              <div className="ios-head">存储</div>
              {data.disks.map((d) => (
                <div className="mrow" key={d.mount}>
                  <div className="grow">
                    <div className="name">
                      <span className="tip" title={d.mount}>{mountName(d.mount)}</span>
                    </div>
                    <div className="ios-row-sub">{d.external ? "外置磁盘" : "内置磁盘"}</div>
                  </div>
                  <span className="ios-row-value">{formatBytes(d.used)} / {formatBytes(d.total)}</span>
                </div>
              ))}
            </section>

            <section className="ios-group">
              <div className="ios-head">网络与功耗</div>
              {data.network.slice(0, 4).map((n) => (
                <div className="mrow" key={n.name}>
                  <div className="grow">
                    <div className="name">
                      <span className="tip" title={`${n.name}${n.ip ? ` · ${n.ip}` : ""}`}>{ifaceName(n.name)}</span>
                    </div>
                    <div className="ios-row-sub">{n.ip}</div>
                  </div>
                  <span className="ios-row-value" style={{ fontSize: 14 }}>{formatRate(n.rx_rate_mbs)} ↓</span>
                </div>
              ))}
              <div className="mrow">
                <div className="grow"><div className="name">功耗</div></div>
                <span className="ios-row-value">{data.thermal.system_power.toFixed(1)} W</span>
              </div>
            </section>
          </div>

          <section className="ios-group">
            <div className="ios-head">占用最高的进程</div>
            {data.top_processes.slice(0, 8).map((p) => (
              <div className="mrow" key={p.pid}>
                <div className="grow">
                  <div className="name">
                    {p.name}
                    {isSystemProc(p.name) && <span className="badge-sys">系统</span>}
                  </div>
                </div>
                <span className="ios-row-value" style={{ fontSize: 14 }}>
                  CPU {p.cpu.toFixed(1)}% · 内存 {p.memory.toFixed(1)}%
                </span>
              </div>
            ))}
          </section>
        </div>
      </details>
    </>
  );
}

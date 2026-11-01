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
import { getStatusCache, setStatusCache, readStatusPersist, persistStatus } from "../lib/cache";
import { Ring, Spinner, pctClass } from "../components";

export default function StatusView() {
  const [data, setData] = useState<StatusData | null>(() => getStatusCache());
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(() => !!getStatusCache());

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    if (!getStatusCache()) {
      readStatusPersist().then((disk) => {
        if (!alive || !disk || getStatusCache()) return;
        setStatusCache(disk.data);
        setData(disk.data);
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
        // 硬件信息只在 2 分钟内从上一帧接力：mo 输出格式变化导致字段
        // 永久缺失时，宁可显示未知也不能把旧机器信息无限期展示下去
        if (next.hardware?.model) {
          lastHardwareAt = Date.now();
        } else if (lastRef.hardware && Date.now() - lastHardwareAt < 120000) {
          next.hardware = lastRef.hardware;
        }
        if ((!next.top_processes || next.top_processes.length === 0) && lastRef.top_processes) {
          next.top_processes = lastRef.top_processes;
        }
      }
      lastRef = next;
      lastFrameAt = Date.now();
      setStatusCache(next);
      persistStatus(next);
      setData(next);
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

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <Spinner label="正在读取系统状态…" />;

  const hw = data.hardware;
  const cpuPct = Math.round(data.cpu.usage);
  const memPct = Math.round(data.memory.used_percent);
  const mainDisk = data.disks.find((d) => d.mount === "/") ?? data.disks[0];

  return (
    <>
      <section className="panel" data-drag>
        <div className="hero-strip">
          <Ring value={data.health_score} />
          <div className="hero-info">
            <div className="hero-kv"><div className="k">机型</div><div className="v">{hw.model}</div></div>
            <div className="hero-kv"><div className="k">芯片</div><div className="v">{hw.cpu_model}</div></div>
            <div className="hero-kv"><div className="k">内存</div><div className="v">{hw.total_ram}</div></div>
            <div className="hero-kv"><div className="k">系统</div><div className="v">{hw.os_version}</div></div>
            <div className="hero-kv"><div className="k">已运行</div><div className="v">{data.uptime}</div></div>
            <div className="hero-kv"><div className="k">评分</div><div className="v" style={{ color: "var(--success)" }}>{data.health_score_msg}</div></div>
          </div>
        </div>
      </section>

      <div className="section-title" style={{ margin: "22px 0 12px" }}>
        实时指标
        <span className="hint">{live ? "每 2 秒自动刷新" : "正在连接实时数据…"}</span>
      </div>

      <div className="stat-strip three" style={{ marginBottom: 22 }}>
        <div className="panel stat-tile">
          <span>CPU 占用</span>
          <b style={{ fontSize: 23, fontWeight: 740 }}>{cpuPct}<em>%</em></b>
          <div className="progress-track"><i className={pctClass(cpuPct)} style={{ width: `${cpuPct}%` }} /></div>
          <small>负载 {data.cpu.load1.toFixed(1)} / {data.cpu.load5.toFixed(1)} / {data.cpu.load15.toFixed(1)} · {data.cpu.core_count} 核</small>
        </div>
        <div className="panel stat-tile">
          <span>内存</span>
          <b style={{ fontSize: 23, fontWeight: 740 }}>{memPct}<em>%</em></b>
          <div className="progress-track"><i className={pctClass(memPct)} style={{ width: `${memPct}%` }} /></div>
          <small>已用 {formatBytes(data.memory.used)} / {formatBytes(data.memory.total)}</small>
        </div>
        <div className="panel stat-tile">
          <span>磁盘{mainDisk?.external ? `（${mainDisk.mount}）` : ""}</span>
          <b style={{ fontSize: 23, fontWeight: 740 }}>{mainDisk ? Math.round(mainDisk.used_percent) : "--"}<em>%</em></b>
          <div className="progress-track"><i className={mainDisk ? pctClass(mainDisk.used_percent) : ""} style={{ width: `${mainDisk?.used_percent ?? 0}%` }} /></div>
          <small>SMART：{mainDisk?.smart_status === "verified" ? "正常" : (mainDisk?.smart_status ?? "--")}</small>
        </div>
      </div>

      <div className="section-title" style={{ margin: "22px 0 12px" }}>磁盘与网络</div>
      <div className="split-view" style={{ marginBottom: 22 }}>
        <section className="panel panel-pad">
          <header className="panel-head"><div><h2>存储</h2></div></header>
          <div className="row-list">
            {data.disks.map((d) => (
              <div className="mrow" key={d.mount}>
                <div className="grow">
                  <div className="name">{d.mount}</div>
                  <div className="sub">{d.external ? "外置磁盘" : "内置磁盘"} · 剩余 {formatBytes(d.total - d.used)}</div>
                </div>
                <span className="num">{Math.round(d.used_percent)}%</span>
              </div>
            ))}
            <div className="mrow">
              <div className="grow"><div className="name">磁盘读写</div></div>
              <span className="num">{formatRate(data.disk_io.read_rate)} ↓ · {formatRate(data.disk_io.write_rate)} ↑</span>
            </div>
          </div>
        </section>
        <section className="panel panel-pad">
          <header className="panel-head"><div><h2>网络与功耗</h2></div></header>
          <div className="row-list">
            {data.network.slice(0, 4).map((n) => (
              <div className="mrow" key={n.name}>
                <div className="grow">
                  <div className="name">{n.name}{n.ip ? ` · ${n.ip}` : ""}</div>
                </div>
                <span className="num">{formatRate(n.rx_rate_mbs)} ↓ · {formatRate(n.tx_rate_mbs)} ↑</span>
              </div>
            ))}
            <div className="mrow">
              <div className="grow"><div className="name">功耗</div></div>
              <span className="num">{data.thermal.system_power.toFixed(1)} W</span>
            </div>
          </div>
        </section>
      </div>

      <div className="section-title" style={{ margin: "22px 0 12px" }}>占用最高的进程</div>
      <section className="panel panel-pad">
        <div className="row-list">
          {data.top_processes.slice(0, 6).map((p) => (
            <div className="mrow" key={p.pid}>
              <div className="grow">
                <div className="name">{p.name}</div>
                <div className="sub">PID {p.pid}</div>
              </div>
              <span className="num">CPU {p.cpu.toFixed(1)}% · 内存 {p.memory.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { onMoProgress } from "./lib/mole";

/* ---------- Icons (24x24 stroke, SF-Symbol-like weights) ---------- */

type IconProps = { size?: number };

const base = (size = 17) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconGauge = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M12 20a8 8 0 1 1 8-8" />
    <path d="M12 12l4.2-3.4" />
    <path d="M20 15.5a8 8 0 0 1-1.6 2.9" />
  </svg>
);

export const IconSparkle = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M11 4l1.7 4.6L17.5 10l-4.8 1.4L11 16l-1.7-4.6L4.5 10l4.8-1.4L11 4z" />
    <path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </svg>
);

export const IconTrash = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M5 7h14" />
    <path d="M9.5 7V5.4c0-.8.7-1.4 1.5-1.4h2c.8 0 1.5.6 1.5 1.4V7" />
    <path d="M6.5 7l.8 12c.05.9.8 1.6 1.7 1.6h5.9c.9 0 1.65-.7 1.7-1.6l.8-12" />
    <path d="M10 11.5v5.5M14 11.5v5.5" />
  </svg>
);

export const IconDisk = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
    <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </svg>
);

export const IconSearch = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <circle cx="10.5" cy="10.5" r="6.2" />
    <path d="M15.3 15.3L20 20" />
  </svg>
);

export const IconFolder = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M4 7c0-1.1.9-2 2-2h3.6c.6 0 1.1.3 1.5.7l.9 1c.4.5.9.7 1.5.7H18c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V7z" />
  </svg>
);

export const IconFile = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M13.5 3.5H7c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V9l-5.5-5.5z" />
    <path d="M13.5 3.5V9H19" />
  </svg>
);

export const IconChip = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <rect x="10.2" y="10.2" width="3.6" height="3.6" rx="0.8" />
    <path d="M9 3.5V7M15 3.5V7M9 17v3.5M15 17v3.5M3.5 9H7M3.5 15H7M17 9h3.5M17 15h3.5" />
  </svg>
);

export const IconReveal = ({ size }: IconProps = {}) => (
  <svg {...base(size)}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

/* ---------- Health ring ---------- */

export function Ring({
  value,
  size = 104,
  stroke = 8,
}: {
  value: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const color = pct >= 80 ? "var(--success)" : pct >= 55 ? "var(--warning)" : "var(--danger)";
  const trackColor = "color-mix(in srgb, var(--muted) 20%, transparent)";
  return (
    <div className="health-ring">
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={trackColor}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            style={{ transition: "stroke-dashoffset 0.7s ease, stroke 0.4s ease" }}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            textAlign: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.6 }}>{pct}</div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>健康分</div>
          </div>
        </div>
      </div>
      <div className="ring-label">系统健康分</div>
    </div>
  );
}

/* ---------- Confirm sheet (native dialog) ---------- */

export function ConfirmSheet({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // 打开原生 dialog：showModal() 让浏览器接管模态、ESC 关闭、焦点管理
  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    return () => {
      if (dlg && dlg.open) dlg.close();
    };
  }, []);

  const handleCancel = () => {
    dialogRef.current?.close();
    onCancel();
  };
  const handleConfirm = () => {
    dialogRef.current?.close();
    onConfirm();
  };

  return (
    <dialog ref={dialogRef} className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
      <h3>{title}</h3>
      <div style={{ margin: "0 0 18px", fontSize: 13, lineHeight: 1.7, color: "var(--text-2)" }}>{body}</div>
      <div className="sheet-actions">
        <button className="btn ghost sm" onClick={handleCancel}>取消</button>
        <button
          className={destructive ? "btn ghost sm" : "btn primary sm"}
          onClick={handleConfirm}
          autoFocus
          style={destructive ? { color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 32%, var(--line))" } : undefined}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/* ---------- Small helpers ---------- */

export function Spinner({ label }: { label?: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="empty-state" style={{ padding: "48px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
      <div className="spinner" style={{ margin: "0 auto 12px" }} />
      <div>
        {label ?? "加载中…"}
        {sec >= 3 ? `（已等待 ${sec} 秒，可先去其他页面）` : ""}
      </div>
    </div>
  );
}

/* ---------- 扫描进度条 ----------
 * mo clean 会按分类渐进输出，jobId 匹配的进度事件到达时显示真实百分比；
 * analyze 没有任何流式输出，收不到事件就显示不定态进度条 + 真实等待秒数，
 * 不伪造百分比。 */
export function ScanProgress({ label, done, jobId }: { label: string; done?: boolean; jobId?: number }) {
  const [sec, setSec] = useState(0);
  const [real, setReal] = useState<{ done: number; total: number; label: string } | null>(null);
  const startedAt = useRef<number>(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => {
      setSec(Math.round((Date.now() - startedAt.current) / 1000));
    }, 300);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let un: (() => void) | null = null;
    onMoProgress((p) => {
      if (p.id === jobId) setReal({ done: p.done, total: p.total, label: p.label });
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, [jobId]);
  const pct = done ? 100 : real ? Math.min(95, (real.done / real.total) * 100) : null;
  const head = done ? "扫描完成" : real ? `正在扫描 ${real.done}/${real.total} 类 · ${real.label || "…"}` : label;
  return (
    <div className="panel scan-progress" data-drag style={{ opacity: done ? 0.6 : 1, transition: "opacity .4s ease" }}>
      <div className="scan-progress-head">
        <span>{head}</span>
        <span className="scan-elapsed">{pct !== null ? `${Math.round(pct)}%` : `已等待 ${sec}s`}</span>
      </div>
      <div className="scan-progress-bar">
        {pct === null ? (
          <div className="scan-progress-fill indeterminate" />
        ) : (
          <div className="scan-progress-fill" style={{ width: `${pct}%`, opacity: done ? 0.4 : 1 }} />
        )}
      </div>
      <div className="scan-progress-foot">扫描过程中可先去其他页面，结果完成后自动回来</div>
    </div>
  );
}

export function pctClass(pct: number): string {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "";
}

import { useMemo } from "react";
import { formatBytes } from "../lib/mole";

export interface TreemapItem {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  rank: number;
}

// 条带内最差长宽比（squarified treemap 的核心度量）
function worstRatio(areas: number[], side: number): number {
  const s = areas.reduce((a, b) => a + b, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = s * s;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

function squarify(
  nodes: { name: string; path: string; size: number; isDir: boolean; area: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
  out: Rect[],
) {
  if (nodes.length === 0 || w <= 1 || h <= 1) return;
  const horiz = w >= h; // 条带沿长边排
  const side = horiz ? h : w; // 条带厚度
  let row: typeof nodes = [];
  let rest = nodes;
  while (rest.length > 0) {
    const next = rest[0];
    const curWorst = row.length ? worstRatio(row.map((n) => n.area), side) : Infinity;
    const newWorst = worstRatio([...row.map((n) => n.area), next.area], side);
    if (row.length === 0 || newWorst <= curWorst) {
      row.push(next);
      rest = rest.slice(1);
    } else {
      break;
    }
    // 条带塞满整条边就停
    const rowArea = row.reduce((s, n) => s + n.area, 0);
    if (rowArea / side >= (horiz ? w : h)) break;
  }
  const rowArea = row.reduce((s, n) => s + n.area, 0);
  const rowLen = rowArea / side;
  let off = 0;
  for (const n of row) {
    const len = n.area / side;
    out.push({
      ...(horiz
        ? { x: x + off, y, w: len, h: side }
        : { x, y: y + off, w: side, h: len }),
      name: n.name,
      path: n.path,
      size: n.size,
      isDir: n.isDir,
      rank: 0,
    });
    off += len;
  }
  if (horiz) squarify(rest, x + rowLen, y, w - rowLen, h, out);
  else squarify(rest, x, y + rowLen, w, h - rowLen, out);
}

// 颜色改为 CSS class（.tm-0 ~ .tm-5）：跟随外观系统的 accent/accent-2，
// 切换明暗/配色时自动更新，不再写死 HSL。
function colorClass(rank: number): string {
  return `tm-${Math.min(5, Math.max(0, rank))}`;
}

export default function Treemap({
  items,
  onPick,
}: {
  items: TreemapItem[];
  onPick: (path: string, name: string) => void;
}) {
  const W = 1000;
  const H = 230;

  const rects = useMemo(() => {
    const total = items.reduce((s, i) => s + i.size, 0);
    if (total <= 0) return [];
    const nodes = items
      .filter((i) => i.size > 0)
      .map((i) => ({ ...i, area: (i.size / total) * W * H }))
      .sort((a, b) => b.area - a.area);
    const out: Rect[] = [];
    squarify(nodes, 0, 0, W, H, out);
    out.forEach((r, i) => (r.rank = i));
    return out;
  }, [items]);

  if (rects.length === 0) return null;

  return (
    <div className="panel panel-pad" data-drag>
      <div className="treemap-wrap" data-no-drag>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", width: "100%", height: "auto", borderRadius: 8 }}
      >
        {rects.map((r) => {
          const big = r.w > 70 && r.h > 26;
          return (
            <g
              key={r.path}
              style={{ cursor: r.isDir ? "pointer" : "default" }}
              onClick={() => r.isDir && onPick(r.path, r.name)}
            >
              <rect
                x={r.x + 1}
                y={r.y + 1}
                width={Math.max(0, r.w - 2)}
                height={Math.max(0, r.h - 2)}
                rx={5}
                className={colorClass(r.rank)}
                style={{ transition: "fill .3s var(--ease), opacity .12s ease" }}
              />
              <title>{`${r.name} — ${formatBytes(r.size)}`}</title>
              {big && (
                <>
                  <text x={r.x + 8} y={r.y + 17} fontSize={12.5} fill="#fff" fontWeight={600}>
                    {r.name.length > 22 ? r.name.slice(0, 21) + "…" : r.name}
                  </text>
                  <text x={r.x + 8} y={r.y + 32} fontSize={11} fill="rgba(255,255,255,.82)">
                    {formatBytes(r.size)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

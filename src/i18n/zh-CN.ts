// 文案翻译层：后端 CLI 的英文原文一律不直接上界面。
// 查不到的字符串 fallback 显示原文并 console.warn，不允许静默透出。

/* ---------- 清理分类 ---------- */

const CATEGORY_MAP: Record<string, string> = {
  "User essentials": "用户基础项",
  "User app cache": "应用缓存",
  "User app logs": "应用日志",
  Trash: "废纸篓",
  "App caches": "应用缓存",
};

export function translateCategory(name: string): string {
  const hit = CATEGORY_MAP[name];
  if (!hit) {
    console.warn(`[i18n] 未映射的清理分类：${name}`);
    return name;
  }
  return hit;
}

// 条目级查找：不告警（条目名很多是路径别名，逐条告警会刷屏）
export function peekCategory(name: string): string | null {
  return CATEGORY_MAP[name] ?? null;
}

// 清理条目名：'User app cache · 27 items' → '应用缓存 · 27 项'；
// 'Trash · skipped, grant Full Disk Access...' → '废纸篓 · 已跳过：需要完全磁盘访问授权'
export function translateItemName(name: string): string {
  const [head, ...rest] = name.split(" · ");
  const headZh = peekCategory(head.trim()) ?? head.trim();
  const restZh = rest
    .map((part) => {
      const items = part.match(/^(\d+)\s+items?$/i);
      if (items) return `${items[1]} 项`;
      if (/skipped.*full disk access/i.test(part)) return "已跳过：需要完全磁盘访问授权";
      if (/^skipped$/i.test(part)) return "已跳过";
      return part;
    })
    .join(" · ");
  return restZh ? `${headZh} · ${restZh}` : headZh;
}

/* ---------- 通用 UI 词条 ---------- */

const UI_MAP: Record<string, string> = {
  "DRY RUN MODE, No app files or settings will be modified":
    "预览模式：不会删除任何文件或设置",
  "Files to be removed:": "将移除以下文件：",
  "Review only:": "仅审查（不删除）：",
  "Personal data kept:": "将保留的个人数据：",
  skipped: "已跳过",
  "grant Full Disk Access to your terminal":
    "请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中为终端授权后重试",
};

export function t(text: string): string {
  const hit = UI_MAP[text];
  if (!hit) {
    console.warn(`[i18n] 未映射的后端文案：${text}`);
    return text;
  }
  return hit;
}

/* ---------- 扫描进度的人话描述 ---------- */

// mo clean 的进度事件会给出分类名或目录路径，统一转成用户能懂的说法
const PROGRESS_PATH_MAP: [RegExp, string][] = [
  [/User essentials/i, "用户基础项"],
  [/User app cache/i, "应用缓存"],
  [/User app logs/i, "应用日志"],
  [/trash/i, "废纸篓"],
  [/Caches/i, "应用缓存"],
  [/Logs/i, "日志"],
];

export function translateScanLabel(label: string): string {
  const hit = CATEGORY_MAP[label];
  if (hit) return hit;
  for (const [re, name] of PROGRESS_PATH_MAP) {
    if (re.test(label)) return name;
  }
  // 路径类标签只保留最后一段，避免长路径刷屏
  if (label.includes("/")) {
    const seg = label.split("/").filter(Boolean).pop() ?? label;
    return seg;
  }
  return label || "…";
}

/* ---------- 挂载点 / 磁盘 ---------- */

const MOUNT_MAP: Record<string, string> = {
  "/": "Macintosh HD",
  "/Volumes/External HD": "外置磁盘",
};

export function mountName(mount: string): string {
  const hit = MOUNT_MAP[mount];
  if (hit) return hit;
  if (mount.startsWith("/Volumes/")) {
    return mount.split("/").filter(Boolean).slice(1).join("/") || mount;
  }
  return mount;
}

export function smartLabel(status: string | null | undefined): string {
  if (status === "verified") return "良好";
  if (!status) return "未知";
  console.warn(`[i18n] 未映射的 SMART 状态：${status}`);
  return status === "errors" || status === "failed" ? "需关注" : status;
}

/* ---------- 网络接口 ---------- */

const IFACE_MAP: Record<string, string> = {
  en0: "Wi-Fi",
  en5: "以太网",
  en6: "Thunderbolt 桥接",
};

export function ifaceName(name: string): string {
  return IFACE_MAP[name] ?? "网络接口";
}

/* ---------- 最近使用时间 ---------- */

// "Last: 1y ago" → "1 年前"；供卸载预览等场景拼接
const LAST_UNIT_MAP: Record<string, string> = {
  m: "分钟",
  h: "小时",
  d: "天",
  w: "周",
  mo: "个月",
  y: "年",
};

export function formatLastUsedZh(raw: string): string | null {
  const m = raw.match(/Last:\s*(\d+)\s*(mo|y|w|d|h|m)\s+ago/i);
  if (!m) return null;
  const unit = LAST_UNIT_MAP[m[2].toLowerCase()] ?? m[2];
  return `${m[1]} ${unit}前`;
}

// 文案翻译层：后端 CLI 的英文原文一律不直接上界面。
// 查不到的字符串 fallback 显示原文并 console.warn，不允许静默透出。

/* ---------- 清理分类 ---------- */

const CATEGORY_MAP: Record<string, string> = {
  "User essentials": "用户基础项",
  "User app cache": "通用应用缓存",
  "User app logs": "应用日志",
  Trash: "废纸篓",
  "App caches": "各应用缓存",
  System: "系统",
  Browsers: "浏览器",
  "Cloud & Office": "云与办公",
  "Developer tools": "开发者工具",
  "Apps & utilities": "应用与实用工具",
  Virtualization: "虚拟机",
  "Application Support": "应用支持",
  "App leftovers": "应用残留",
  "Apple Silicon": "Apple 芯片组件",
  "Apple Silicon updates": "Apple 芯片更新",
  "Device backups & firmware": "设备备份与固件",
  "Time Machine": "时间机器",
  "Large files": "大文件",
  "Project artifacts": "项目构建产物",
  "Final summary": "汇总",
};

// 条目级专有名词（清理结果里的单条缓存项）
const ITEM_MAP: Record<string, string> = {
  "Media analysis temp files": "媒体分析临时文件",
  "Geod temp files": "定位服务缓存",
  "macOS Help system cache": "系统帮助缓存",
  "Maps geo tile cache": "地图瓦片缓存",
  "Apple Media Services cache": "Apple 媒体服务缓存",
  "Application Support logs/caches": "应用支持日志/缓存",
  "pnpm store": "pnpm 存储",
  "Hugging Face cache": "Hugging Face 缓存",
};

// 条目描述里的通用英文短语（工具/应用专名保留原文）
const PHRASE_MAP: [RegExp, string][] = [
  [/Nothing to clean/gi, "无需清理"],
  [/Would clean/gi, "将清理"],
  [/would clean/gi, "可清理"],
  [/would free/gi, "可释放"],
  [/review with docker system df/gi, "可用 docker system df 查看"],
  [/review before removing/gi, "移除前请确认"],
  [/Stale login item/gi, "失效登录项"],
  [/Missing app\/helper target/gi, "缺少应用目标"],
  [/service worker cache/gi, "Service Worker 缓存"],
  [/mini program cache/gi, "小程序缓存"],
  [/metadata cache/gi, "元数据缓存"],
  [/binary cache/gi, "二进制缓存"],
  [/crash reports/gi, "崩溃报告"],
  [/completion cache/gi, "补全缓存"],
  [/module cache/gi, "模块缓存"],
  [/old files/gi, "旧文件"],
  [/cleanup/gi, "清理"],
  [/old versions/gi, "旧版本"],
  [/web cache/gi, "网页缓存"],
  [/logs\/caches/gi, "日志/缓存"],
  [/unused data/gi, "未使用数据"],
  [/Application Support/gi, "应用支持"],
  [/updater/gi, "更新器"],
  [/(\d+)\s+dirs/gi, "$1 个目录"],
  [/(\d+)\s+items/gi, "$1 个项目"],
  [/cache/gi, "缓存"],
  [/logs/gi, "日志"],
  [/directory/gi, "目录"],
  [/\babout\b/gi, "约"],
];

function translatePhrases(text: string): string {
  let out = text;
  for (const [re, zh] of PHRASE_MAP) out = out.replace(re, zh);
  return out;
}

export function translateCategory(name: string): string {
  const normalized = name.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)$/, "").trim();
  const hit = CATEGORY_MAP[normalized];
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

// 清理条目名：'User app cache · 27 items' → '通用应用缓存 · 27 个项目'；
// 'Trash · skipped, grant Full Disk Access...' 返回空串（整行隐藏，
// 只保留行内的中文跳过原因 + 去授权按钮）
export function translateItemName(name: string): string {
  const [head, ...rest] = name.split(" · ");
  const trimmedHead = head.trim();
  if (/^trash$/i.test(trimmedHead) && /full disk access/i.test(name)) return "";
  const restZh = rest
    .map((part) => {
      if (/skipped.*full disk access/i.test(part)) return "已跳过：需要完全磁盘访问授权";
      if (/^skipped$/i.test(part)) return "已跳过";
      return translatePhrases(part);
    })
    .join(" · ");
  const headZh =
    ITEM_MAP[trimmedHead] ?? peekCategory(trimmedHead) ?? translatePhrases(trimmedHead);
  return restZh ? `${headZh} · ${restZh}` : headZh;
}

/* ---------- 磁盘分析：目录名 ---------- */

const FOLDER_MAP: Record<string, string> = {
  "User Library": "用户资源库",
  "System Library": "系统资源库",
  Home: "个人文件夹",
  Applications: "应用程序",
  Library: "资源库",
  "uv Cache": "Python 工具缓存",
  Documents: "文档",
  Desktop: "桌面",
  Downloads: "下载",
  Music: "音乐",
  Pictures: "图片",
  Movies: "影片",
  Containers: "容器",
  "Group Containers": "群组容器",
  "Application Support": "应用支持",
  "Application Scripts": "应用脚本",
  Caches: "缓存",
  Preferences: "偏好设置",
  Logs: "日志",
  ".Trash": "废纸篓",
};

export function translateFolderName(name: string): string {
  const hit = FOLDER_MAP[name];
  if (hit) return hit;
  // 用户自建目录（项目文件夹等）保持原名，不算未映射告警
  return name;
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
  const normalized = label.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)$/, "").trim();
  const hit = CATEGORY_MAP[normalized];
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

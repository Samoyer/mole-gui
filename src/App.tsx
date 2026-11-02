import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { moStatusWatchStart, moVersion } from "./lib/mole";
import { currentNav, subscribeNav, type NavKey as StoreNavKey } from "./lib/nav";
import {
  IconDisk,
  IconGauge,
  IconInfo,
  IconMoon,
  IconSparkle,
  IconSun,
  IconTrash,
} from "./components";
import moleLogo from "./assets/mole-logo.png";
import {
  assessMoCompatibility,
  missingMoCompatibility,
  TESTED_MO_VERSION,
  type MoCompatibility,
} from "./lib/moCompatibility";
import StatusView from "./views/StatusView";
import CleanView from "./views/CleanView";
import UninstallView from "./views/UninstallView";
import AnalyzeView from "./views/AnalyzeView";
import { useAppearanceTheme } from "./AppearancePicker";

type NavKey = StoreNavKey;

const NAV: { key: NavKey; label: string; icon: ReactNode }[] = [
  { key: "status", label: "状态总览", icon: <IconGauge /> },
  { key: "clean", label: "深度清理", icon: <IconSparkle /> },
  { key: "uninstall", label: "应用卸载", icon: <IconTrash /> },
  { key: "analyze", label: "磁盘分析", icon: <IconDisk /> },
];

const TITLES: Record<NavKey, { title: string; subtitle: string }> = {
  status: { title: "状态总览", subtitle: "系统健康、性能与实时占用" },
  clean: { title: "深度清理", subtitle: "缓存、日志与临时文件的安全清理" },
  uninstall: { title: "应用卸载", subtitle: "连同关联文件一起移除应用" },
  analyze: { title: "磁盘分析", subtitle: "逐级查看磁盘空间占用" },
};

function compatibilityNotice(compatibility: MoCompatibility | null) {
  if (!compatibility || compatibility.status === "supported") return null;
  if (compatibility.status === "missing") {
    return {
      tone: "danger",
      title: "未找到 Mole",
      detail: "请先安装 Mole，界面中的扫描与清理功能暂时不可用。",
    };
  }
  if (compatibility.status === "unknown") {
    return {
      tone: "warning",
      title: "无法识别 Mole 版本",
      detail: `当前界面针对 Mole ${TESTED_MO_VERSION}.x 验证，部分功能可能无法正常显示。`,
    };
  }
  if (compatibility.status === "unsupported") {
    return {
      tone: "danger",
      title: `Mole ${compatibility.version} 尚未兼容`,
      detail: `当前版本已验证 Mole ${TESTED_MO_VERSION}.x，请切换版本后再执行清理或卸载。`,
    };
  }
  return {
    tone: "warning",
    title: `Mole ${compatibility.version} 尚未验证`,
    detail: `当前输出契约针对 Mole ${TESTED_MO_VERSION}.x；新版本可能改变文案或数据结构。`,
  };
}

export default function App() {
  const [nav, setNav] = useState<NavKey>(currentNav);
  const [version, setVersion] = useState("");
  const [compatibility, setCompatibility] = useState<MoCompatibility | null>(null);
  const [theme, setTheme] = useAppearanceTheme();

  useEffect(() => subscribeNav((key) => setNav(key)), []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t || typeof t.closest !== "function") return;
      const card = t.closest(".panel[data-drag], .sidebar[data-drag]");
      const header = t.closest(".topbar[data-drag], .page-title, .page-subtitle");
      const interactive = t.closest("button, a, input, select, textarea, svg, [role='button'], .mrow, .row, [data-no-drag]");
      if ((card || header) && !interactive) {
        appWindow.startDragging();
      }
    };
    window.addEventListener("mousedown", onMouseDown);

    moVersion()
      .then((raw) => {
        const next = assessMoCompatibility(raw);
        setCompatibility(next);
        setVersion(next.version ? `Mole v${next.version}` : "Mole 版本未知");
      })
      .catch(() => {
        setCompatibility(missingMoCompatibility());
        setVersion("Mole 未安装");
      });

    moStatusWatchStart().catch(() => {});
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  const navItem = (key: NavKey, label: string, icon: ReactNode) => (
    <button
      key={key}
      className={`nav-item ${nav === key ? "active" : ""}`}
      onClick={() => setNav(key)}
    >
      <span className="ic" style={{ display: "grid", placeItems: "center", width: 20, height: 20 }}>{icon}</span>
      <strong>{label}</strong>
    </button>
  );

  const notice = compatibilityNotice(compatibility);

  return (
    <div className="app">
      <aside className="sidebar" data-drag>
        <div className="brand">
          <div className="brand-mark">
            <img className="brand-logo" src={moleLogo} alt="" draggable={false} />
          </div>
          <div className="brand-text">
            <strong>Mole</strong>
            <small>Mac 工具箱</small>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-label">工具</div>
          {NAV.map((item) => navItem(item.key, item.label, item.icon))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="side-foot">
          <button
            className="icon-btn theme-toggle"
            title="外观：默认跟随系统，点按可手动切换深浅色"
            aria-label="切换外观"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <IconMoon size={14} /> : <IconSun size={14} />}
          </button>
          <div className="version">{version}</div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar" data-drag>
          <div className="crumb">
            <strong>{TITLES[nav].title}</strong>
          </div>
        </header>

        <main className="content" style={{ width: "100%" }}>
          {notice && (
            <div className={`compat-banner ${notice.tone}`} role="status">
              <span className="compat-icon"><IconInfo size={16} /></span>
              <div>
                <strong>{notice.title}</strong>
                <span>{notice.detail}</span>
              </div>
            </div>
          )}
          <div className="page-body" key={nav}>
            {nav === "status" && <StatusView />}
            {nav === "clean" && <CleanView compatibility={compatibility} />}
            {nav === "uninstall" && <UninstallView compatibility={compatibility} />}
            {nav === "analyze" && <AnalyzeView compatibility={compatibility} />}
          </div>
        </main>
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { moStatusWatchStart, moVersion } from "./lib/mole";
import { currentNav, subscribeNav, type NavKey as StoreNavKey } from "./lib/nav";
import {
  IconDisk,
  IconGauge,
  IconMoon,
  IconSparkle,
  IconSun,
  IconTrash,
} from "./components";
import moleLogo from "./assets/mole-logo.png";
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

export default function App() {
  const [nav, setNav] = useState<NavKey>(currentNav);
  const [version, setVersion] = useState("");
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
      .then((v) => setVersion(v.split("\n")[0].replace("Mole version ", "Mole v")))
      .catch(() => setVersion("Mole 未安装"));

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
          <div className="page-body" key={nav}>
            {nav === "status" && <StatusView />}
            {nav === "clean" && <CleanView />}
            {nav === "uninstall" && <UninstallView />}
            {nav === "analyze" && <AnalyzeView />}
          </div>
        </main>
      </div>
    </div>
  );
}

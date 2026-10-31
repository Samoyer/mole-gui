import { Palette, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { materials, single, multi, corners } from "./presets";
import { installLiquidGlass } from "./liquid-glass";
export { materials, single, multi, corners } from "./presets";
export const accents = [...single, ...multi];
export type Theme = "light" | "dark";
export type Material = typeof materials[number]["id"];
export type Color = typeof accents[number]["id"];
export type Corner = typeof corners[number]["id"];
let prefix = "sunny-ui";
let disposeGlass: (() => void) | undefined;
const eventName = "sunny-ui:appearance";
function read(key: string) { try { return localStorage.getItem(`${prefix}-${key}`); } catch { return null; } }
function save(key: string, value: string) { try { localStorage.setItem(`${prefix}-${key}`, value); } catch { /* Selection still works in this tab. */ } }
function valid<T extends string>(value: string | null, values: readonly { id: T }[], fallback: T): T { return values.find(item => item.id === value)?.id ?? fallback; }
function getPreferences() {
  const material = read("material");
  return {
    theme: read("theme") === "dark" ? "dark" as const : "light" as const,
    material: valid(material === "default" ? "clear" : material === "blocks" ? "satin" : material, materials, "soft"),
    color: valid(read("color") ?? read("accent"), accents, "blue"),
    corner: valid(read("corner"), corners, "default"),
  };
}
type Preferences = ReturnType<typeof getPreferences>;
function apply(state: Preferences) {
  if (typeof document === "undefined") return;
  Object.assign(document.documentElement.dataset, state);
}
export function configureAppearance(options: { storagePrefix?: string } = {}) {
  prefix = options.storagePrefix || "sunny-ui";
  apply(getPreferences());
  if (typeof document !== "undefined") { disposeGlass?.(); disposeGlass = installLiquidGlass(); }
}
function change<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  save(key, value);
  if (typeof document !== "undefined") document.documentElement.dataset[key] = value;
  window.dispatchEvent(new CustomEvent(eventName, { detail: { key, value } }));
}
function usePreferences() {
  const [state, setState] = useState(getPreferences);
  useEffect(() => {
    const sync = () => { const next = getPreferences(); apply(next); setState(next); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(`${prefix}-`)) sync(); };
    const local = (event: Event) => {
      const { key, value } = (event as CustomEvent).detail;
      setState(current => ({ ...current, [key]: value }));
    };
    window.addEventListener("storage", storage);
    window.addEventListener(eventName, local);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener(eventName, local); };
  }, []);
  return state;
}
export function useAppearanceTheme() {
  const { theme } = usePreferences();
  return [theme, (value: Theme) => change("theme", value)] as const;
}
function cssStyle(declarations: string): CSSProperties {
  return Object.fromEntries(declarations.split(";").filter(Boolean).map(part => {
    const index = part.indexOf(":");
    return [part.slice(0,index).replace(/-([a-z])/g, (_,letter: string) => letter.toUpperCase()), part.slice(index+1)];
  })) as CSSProperties;
}
export function AppearancePicker({ theme, onThemeChange }: { theme: Theme; onThemeChange: () => void }) {
  const state = usePreferences();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node) && trigger.current && !trigger.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onEsc); };
  }, [open]);
  return <div className="appearance-anchor" style={{ position: "relative" }}>
    <button ref={trigger} type="button" className="appearance-btn" aria-label="外观" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Palette size={16} />外观</button>
    {open && <div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} className="appearance-pop sunny-picker open" style={{ position: "absolute", right: 0, top: "calc(100% + 12px)", zIndex: 60 }}>
      <header className="pop-head"><div><strong id={`${id}-title`}>外观</strong><small>{materials.find(item => item.id === state.material)?.name} · {accents.find(item => item.id === state.color)?.name}</small></div><button className="pop-close" aria-label="关闭外观" onClick={() => setOpen(false)}><X size={14} /></button></header>
      <div className="pop-group"><span>明暗</span><div className="seg">{(["light","dark"] as const).map(mode => <button key={mode} aria-pressed={theme === mode} onClick={() => { if (mode !== theme) onThemeChange(); }}>{mode === "light" ? "浅色" : "深色"}</button>)}</div></div>
      <div className="pop-group"><span>圆角</span><div className="seg">{corners.map(item => <button key={item.id} aria-pressed={state.corner === item.id} onClick={() => change("corner",item.id)}>{item.name}</button>)}</div></div>
      <div className="pop-group"><span>质感 · 16 种</span><div className="mat-grid" role="radiogroup" aria-label="质感">{materials.map(item => <button className="mat-opt" role="radio" aria-checked={state.material === item.id} key={item.id} title={item.note} onClick={() => change("material",item.id)}><i className="ms" style={cssStyle(item.sample)} /><b>{item.name}</b></button>)}</div></div>
      <div className="pop-group"><span>单色</span><div className="col-row" role="radiogroup" aria-label="单色">{single.map(item => <button className="sw" role="radio" key={item.id} aria-label={item.name} title={item.name} aria-checked={state.color === item.id} style={{ "--sw": item[theme] } as CSSProperties} onClick={() => change("color",item.id)} />)}</div></div>
      <div className="pop-group"><span>多色 · 主色 / 辅色 / 点缀</span><div className="col-row" role="radiogroup" aria-label="多色">{multi.map(item => <button className="sw wheel" role="radio" key={item.id} aria-label={item.name} title={item.name} aria-checked={state.color === item.id} style={{ "--sw": `conic-gradient(from -90deg,${item[theme].join(",")},${item[theme][0]})` } as CSSProperties} onClick={() => change("color",item.id)} />)}</div></div>
      <p className="pop-foot">质感换表面，配色换颜料，两者互不覆盖。<br />偏好自动保存在当前浏览器。</p>
    </div>}
  </div>;
}

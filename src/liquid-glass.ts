/** Lens math adapted from SunnyTV / compose-miuix-ui, Apache-2.0; see liquid-glass-NOTICE.txt.
 * The displacement texture contains geometry only, never a screenshot or copied page content.
 */
export type GlassVariant = "glass" | "frosted" | "aurora";
export type GlassRenderer = "refracted" | "blur" | "solid";
export interface GlassOptions { variant?: GlassVariant; renderer?: "auto" | "refracted" | "blur"; radius?: number }
const variants = new Set<string>(["glass", "frosted", "aurora"]);
let serial = 0;

export function glassRenderer(preference: GlassOptions["renderer"] = "auto"): GlassRenderer {
  if (typeof window === "undefined") return "solid";
  if (matchMedia("(forced-colors: active), (prefers-reduced-transparency: reduce)").matches) return "solid";
  if (!CSS.supports("backdrop-filter", "blur(2px)") && !CSS.supports("-webkit-backdrop-filter", "blur(2px)")) return "solid";
  // URL syntax support alone does not prove that SVG filters work on a browser's backdrop.
  // Auto enables the path verified in Chromium; other engines retain native backdrop diffusion.
  const chromium = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent) && !/(?:CriOS|EdgiOS)\//.test(navigator.userAgent);
  return preference === "refracted" || (preference !== "blur" && chromium) ? "refracted" : "blur";
}

/** Pixel positions correspond to the native lens's rounded-rectangle distance and circleMap.
 * feDisplacementMap samples P(x + scale*(R-.5), y + scale*(G-.5)).
 */
export function lensDisplacement(x: number, y: number, width: number, height: number, radius: number) {
  const px = x - width / 2, py = y - height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  const depth = Math.min(1, Math.max(0, -sd / 18));
  const circle = 1 - Math.sqrt(Math.max(0, 1 - (1 - depth) ** 2));
  const gradRadius = Math.min(r * 1.5, width / 2, height / 2);
  const gx = Math.abs(px) - (width / 2 - gradRadius), gy = Math.abs(py) - (height / 2 - gradRadius);
  let nx = gx >= 0 || gy >= 0 ? Math.max(gx, 0) : gx >= gy ? 1 : 0;
  let ny = gx >= 0 || gy >= 0 ? Math.max(gy, 0) : gx >= gy ? 0 : 1;
  const length = Math.hypot(nx, ny) || 1;
  nx = nx / length * Math.sign(px); ny = ny / length * Math.sign(py);
  return [circle * -14 * nx, circle * -14 * ny] as const;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** Enhance any existing element, including native dialog/popover. Returns complete cleanup.
 * Geometry regenerates on resize/corner changes only; scrolling and background updates are native.
 */
export function enhanceLiquidGlass(element: HTMLElement, options: GlassOptions = {}) {
  const previous = { variant: element.getAttribute("data-sunny-glass"), renderer: element.getAttribute("data-glass-renderer"), filter: element.style.getPropertyValue("--sunny-glass-filter"), inner: element.style.getPropertyValue("--sunny-glass-inner-radius") };
  const variant = options.variant ?? "glass";
  const svg = svgElement("svg", { width: "0", height: "0", "aria-hidden": "true", focusable: "false" });
  svg.style.cssText = "position:fixed;pointer-events:none;overflow:hidden";
  const id = `sunny-lens-${++serial}`;
  const filter = svgElement("filter", { id, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
  const blur = svgElement("feGaussianBlur", { in: "SourceGraphic", stdDeviation: variant === "frosted" ? "8" : "2.2", result: "diffused" });
  const saturation = svgElement("feColorMatrix", { in: "diffused", type: "saturate", values: ".85", result: "soft" });
  const map = svgElement("feImage", { result: "lens", preserveAspectRatio: "none" });
  const displacement = svgElement("feDisplacementMap", { in: "soft", in2: "lens", scale: variant === "frosted" ? "5.6" : "28", xChannelSelector: "R", yChannelSelector: "G" });
  filter.append(blur, saturation, map, displacement); svg.append(filter);
  document.body.append(svg);
  element.dataset.sunnyGlass = variant;
  let geometry = "", disposed = false, queued = 0;
  function update() {
    queued = 0;
    if (disposed) return;
    const renderer = glassRenderer(options.renderer);
    element.dataset.glassRenderer = renderer;
    // Filter coordinates use untransformed CSS pixels, including during a popover's opening scale.
    const width = element.offsetWidth, height = element.offsetHeight;
    if (width < 1 || height < 1) return;
    const style = getComputedStyle(element);
    const radius = options.radius ?? (parseFloat(style.borderTopLeftRadius) || 0);
    const resolvedRadius = Math.min(radius, width / 2, height / 2);
    const inset = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
    element.style.setProperty("--sunny-glass-inner-radius", `${Math.max(0, resolvedRadius - inset)}px`);
    if (renderer !== "refracted") { element.style.removeProperty("--sunny-glass-filter"); return; }
    const key = [Math.round(width), Math.round(height), radius].join(":");
    if (key !== geometry) {
      const canvas = document.createElement("canvas");
      const factor = Math.min(1, 640 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * factor)); canvas.height = Math.max(1, Math.round(height * factor));
      const context = canvas.getContext("2d");
      if (!context) { element.dataset.glassRenderer = "blur"; return; }
      const image = context.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const [dx, dy] = lensDisplacement((x + .5) / factor, (y + .5) / factor, width, height, radius);
        const i = (y * canvas.width + x) * 4;
        image.data[i] = Math.round(255 * (.5 + dx / 28)); image.data[i + 1] = Math.round(255 * (.5 + dy / 28));
        image.data[i + 2] = 128; image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      for (const node of [filter, map]) {
        node.setAttribute("x", node === filter ? "-40" : "0"); node.setAttribute("y", node === filter ? "-40" : "0");
        node.setAttribute("width", String(width + (node === filter ? 80 : 0))); node.setAttribute("height", String(height + (node === filter ? 80 : 0)));
      }
      map.setAttribute("href", canvas.toDataURL());
      geometry = key;
    }
    element.style.setProperty("--sunny-glass-filter", `url("#${id}")`);
  }
  function schedule() { if (!disposed && !queued) queued = requestAnimationFrame(update); }
  const resize = new ResizeObserver(schedule); resize.observe(element);
  const root = new MutationObserver(schedule); root.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-corner", "data-material"] });
  const media = [matchMedia("(forced-colors: active)"), matchMedia("(prefers-reduced-transparency: reduce)")];
  media.forEach(query => query.addEventListener("change", schedule));
  element.addEventListener("toggle", schedule); schedule();
  return () => {
    disposed = true; cancelAnimationFrame(queued); resize.disconnect(); root.disconnect(); svg.remove();
    media.forEach(query => query.removeEventListener("change", schedule)); element.removeEventListener("toggle", schedule);
    for (const [attribute, value] of [["data-sunny-glass", previous.variant], ["data-glass-renderer", previous.renderer]] as const) {
      if (value == null) element.removeAttribute(attribute); else element.setAttribute(attribute, value);
    }
    if (previous.filter) element.style.setProperty("--sunny-glass-filter", previous.filter); else element.style.removeProperty("--sunny-glass-filter");
    if (previous.inner) element.style.setProperty("--sunny-glass-inner-radius", previous.inner); else element.style.removeProperty("--sunny-glass-inner-radius");
  };
}

/** Automatic treatment for the appearance picker and global chrome; unrelated materials untouched. */
export function installLiquidGlass(root: HTMLElement = document.documentElement) {
  const surfaces = new Map<HTMLElement, { variant: GlassVariant; dispose: () => void }>();
  let queued = 0;
  const scan = () => {
    queued = 0;
    const material = root.dataset.material;
    const active = material && variants.has(material);
    const found = new Set(active ? root.querySelectorAll<HTMLElement>(".topbar,.sunny-picker,.task-dialog,dialog.detail") : []);
    for (const [node, entry] of surfaces) if (!found.has(node) || entry.variant !== material) { entry.dispose(); surfaces.delete(node); }
    if (active) for (const node of found) if (!surfaces.has(node)) surfaces.set(node, { variant: material as GlassVariant, dispose: enhanceLiquidGlass(node, { variant: material as GlassVariant }) });
  };
  const observer = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(scan); });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-material"] });
  scan();
  return () => { observer.disconnect(); cancelAnimationFrame(queued); for (const entry of surfaces.values()) entry.dispose(); surfaces.clear(); };
}

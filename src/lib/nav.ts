// 全局导航 store：页面之间的任务链出口（去清理/查看大文件/返回总览）
// 不走 react-router，App.tsx 订阅这里即可。

export type NavKey = "status" | "clean" | "uninstall" | "analyze";

// focus：页面间跳转的筛选意图（clean 页收 cache/logs/trash，
// analyze 页收 large），含义由目标页解释
export interface NavParams {
  focus?: string;
}

type Listener = (key: NavKey, params: NavParams | null) => void;

let current: NavKey = "status";
let lastParams: NavParams | null = null;
const listeners = new Set<Listener>();

export function navigate(key: NavKey, params?: NavParams): void {
  lastParams = params ?? null;
  const payload = lastParams;
  if (key === current) {
    // 同页跳转也要把参数送达（例如已在清理页又被要求聚焦缓存分类）
    listeners.forEach((l) => l(key, payload));
    return;
  }
  current = key;
  listeners.forEach((l) => l(key, payload));
}

export function currentNav(): NavKey {
  return current;
}

// 目标页挂载时取走参数（取即清空，避免残留影响下次跳转）
export function consumeNavParams(): NavParams | null {
  const p = lastParams;
  lastParams = null;
  return p;
}

export function subscribeNav(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

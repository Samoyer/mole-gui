# Mole GUI

给 [tw93/Mole](https://github.com/tw93/Mole) 命令行工具做的 macOS 图形界面（Tauri + React），
遵循 Apple 设计规范：侧栏导航、大数字指标卡、克制的圆角与阴影。

## 兼容性

- 已验证：Mole `1.66.x`
- Mole `1.67+` 会被标记为“尚未验证”
- 旧版本和 Mole `2.x` 会被标记为不兼容，避免在未知输出契约下执行清理或卸载

## 功能

- **状态总览** — 存储健康、可清理空间、大文件提醒与专业模式实时指标，`mo status --watch` 流式推送
- **深度清理** — `mo clean --dry-run` 扫描预览，确认后执行真实清理
- **应用卸载** — 应用列表、搜索、卸载预览（dry-run），默认移到废纸篓
- **磁盘分析** — `mo analyze --json` 概览，点击文件夹逐级深入

所有清理逻辑都由本机 `mo` 命令完成，GUI 只负责展示与确认。

## 依赖

- [Rust](https://rustup.rs/)（rustup 安装）
- Node + pnpm
- `brew install mole`

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 构建

```bash
pnpm check
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`（.app 与 .dmg）。

## 结构

- `src-tauri/src/lib.rs` — Tauri 命令，封装 `mo` 子进程调用（nice 降优先级、ANSI 转义剥离、watch 长驻进程 + 事件推送）
- `src/lib/mole.ts` — 前端调用封装、JSON 类型、清理文本解析
- `src/lib/moCompatibility.ts` — Mole 版本兼容与输出契约校验
- `src/views/` — 四个功能页面
- `src/apple-hig.css` — 最终加载的 HIG 视觉层

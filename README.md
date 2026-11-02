# Mole GUI

给 [tw93/Mole](https://github.com/tw93/Mole) 命令行工具做的 macOS 图形界面（Tauri + React），
遵循 Apple 设计规范：侧栏导航、大数字指标卡、克制的圆角与阴影。

> [!IMPORTANT]
> 本仓库只提供源代码，不提供编译后的 `.app`、`.dmg` 或其他安装包。
> 所有清理、卸载、磁盘分析等后端能力均来自独立安装的
> [tw93/Mole](https://github.com/tw93/Mole)，本项目不内置、不打包、不再分发 Mole 二进制。

## 后端与分发边界

- 本项目是 Mole 的非官方图形前端，不隶属于 `tw93/Mole` 维护者。
- 实际扫描和清理逻辑由本机的 `mo` 命令执行，GUI 只负责展示、选择和确认。
- 使用前请通过 `brew install mole` 自行安装 Mole，并自行确认其版本和许可证。
- 本仓库遵循与上游 Mole 一致的 **GNU GPL v3.0**，完整条款见 [LICENSE](LICENSE)。
- 如需使用，请从源码自行构建；仓库不提供预编译应用或 GitHub Release 安装包。

## 界面示例

| 状态总览 | 深度清理 |
| --- | --- |
| ![状态总览示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/status.png) | ![深度清理示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/clean.png) |

| 应用卸载 | 磁盘分析 |
| --- | --- |
| ![应用卸载示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/uninstall.png) | ![磁盘分析示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/analyze.png) |

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

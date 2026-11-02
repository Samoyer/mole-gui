# Mole GUI

给 [tw93/Mole](https://github.com/tw93/Mole) 命令行工具做的 macOS 图形界面（Tauri + React），
遵循 Apple 设计规范：侧栏导航、大数字指标卡、克制的圆角与阴影。

> [!IMPORTANT]
> 本项目是 Mole 的非官方图形前端，不隶属于 `tw93/Mole` 维护者。
> 实际扫描、清理和卸载能力来自本机独立安装的 `mo` 命令，本项目不内置、不打包、不再分发 Mole 二进制。
>
> 本仓库只提供源代码，不提供编译后的 `.app`、`.dmg` 或其他安装包，也不提供 GitHub Release 安装包。

## 目录

- [功能](#功能)
- [快速开始](#快速开始)
- [界面示例](#界面示例)
- [兼容性](#兼容性)
- [首次使用与权限](#首次使用与权限)
- [工作原理](#工作原理)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [项目结构](#项目结构)
- [问题反馈](#问题反馈)
- [许可证](#许可证)

## 功能

- **状态总览** — 存储健康、可清理空间和大文件提醒；专业模式提供实时 CPU、内存、网络和进程指标
- **深度清理** — 先预览、再勾选、最后清理；不会默认全选，真实清理前需要再次确认
- **应用卸载** — 搜索应用并预览关联文件，默认移到废纸篓，也可选择不可恢复的彻底删除
- **磁盘分析** — 按目录逐级查看空间占用，支持树图和下钻浏览

所有扫描和清理逻辑都由本机 `mo` 命令完成，GUI 只负责展示、选择和确认。

## 快速开始

### 1. 安装运行依赖

需要 macOS、[Homebrew](https://brew.sh/) 和 Mole：

```bash
brew install mole
mo --version
```

当前 GUI 已验证 Mole `1.66.x`。如果版本不符，请先查看[兼容性](#兼容性)。

### 2. 安装构建依赖

- Xcode Command Line Tools：`xcode-select --install`
- [Rust](https://rustup.rs/) stable toolchain
- Node.js 22 与 [pnpm](https://pnpm.io/) 9，或与验证环境接近的版本

### 3. 从源码运行

```bash
git clone https://github.com/Samoyer/mole-gui.git
cd mole-gui
pnpm install
pnpm tauri dev
```

开发模式第一次启动可能需要下载和编译 Rust 依赖，耗时会明显高于后续启动。

## 界面示例

**状态总览**

![状态总览示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/status.png)

**深度清理**

![深度清理示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/clean.png)

**应用卸载**

![应用卸载示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/uninstall.png)

**磁盘分析**

![磁盘分析示例](https://fastly.jsdelivr.net/gh/Samoyer/mole-gui@main/docs/screenshots/analyze.png)

## 兼容性

| Mole 版本 | 状态 |
| --- | --- |
| `1.66.x` | 已验证 |
| `1.67+` 的其他 `1.x` | 尚未验证；界面会提示输出格式可能变化 |
| 低于 `1.66` | 不兼容；为避免误清理会被阻止 |
| Mole `2.x` | 不兼容；当前输出契约尚未适配 |

当前验证环境：

| 项目 | 版本 |
| --- | --- |
| macOS | `26.6.2`（Apple Silicon） |
| Node.js | `22.22.0` |
| pnpm | `9.12.0` |
| Rust | `1.99.1` |
| Mole | `1.66.0` |

以上是实际验证环境，不代表已经确认的最低版本。Intel Mac、其他 macOS 版本和其他 Mole 版本仍需单独验证。

## 首次使用与权限

### 完全磁盘访问

废纸篓和部分用户资源库受 macOS 隐私权限保护。需要读取这些内容时：

1. 打开「系统设置 → 隐私与安全性 → 完全磁盘访问」。
2. 从源码开发时，通常为启动应用的终端或 IDE 授权；使用构建后的应用时，为 `Mole.app` 授权。
3. 授权后完全退出并重新打开应用。
4. 回到深度清理或磁盘分析页面重新扫描。

没有完全磁盘访问权限时，应用不会绕过系统限制，受保护项目会显示为已跳过或只展示用户空间可读取的结果。

### 管理员权限

部分系统级缓存需要管理员密码。GUI 不会自动提升权限，也不会把无法读取的内容伪装成已清理；当前预览可能只包含用户空间内容。

### 本地缓存

为了减少重复扫描，状态、清理预览和磁盘分析结果会缓存在本机。缓存有有效期，也可以重新扫描获取最新结果。

## 工作原理

```mermaid
flowchart LR
  UI["React + TypeScript 界面"] --> IPC["Tauri 命令与事件"]
  IPC --> CLI["本机 mo 命令"]
  CLI --> FS["macOS 文件系统"]
  CLI --> IPC
```

GUI 不复制 Mole 的清理实现，而是调用本机 `mo`，解析其结构化数据和输出。Mole 的版本或输出格式变化可能影响界面，因此执行清理或卸载前会进行兼容性检查。

### 数据与隐私

- GUI 源码中没有接入分析、遥测或清理数据上传服务。
- 扫描结果和界面缓存保存在本机，用于页面切换和后续打开时快速展示。
- 外部 `mo` 命令的网络与数据处理行为由上游 Mole 决定，请自行查看并确认其版本与许可证。

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| 提示 Mole 未安装或找不到 `mo` | 运行 `brew install mole`，确认 `mo --version` 可以在当前终端执行，然后重启应用 |
| 提示 Mole 版本不兼容 | 切换到 Mole `1.66.x`；未知输出格式下不要强制执行清理或卸载 |
| 深度清理或磁盘分析显示“部分结果” | 检查完全磁盘访问授权，重新打开应用后再次扫描 |
| 系统级缓存没有出现在预览中 | 系统缓存可能需要管理员权限；当前界面只展示能够安全读取的用户空间内容 |
| 第一次扫描很慢 | 扫描耗时取决于目录数量、磁盘状态和文件系统缓存；后续扫描通常更快 |
| `pnpm tauri dev` 构建失败 | 检查 Xcode Command Line Tools、Rust toolchain、Node/pnpm 版本，并先运行 `pnpm install` |

## 开发与测试

安装依赖并启动开发环境：

```bash
pnpm install
pnpm tauri dev
```

运行前端测试：

```bash
pnpm test
```

执行完整前端检查（TypeScript 类型检查 + Vitest）：

```bash
pnpm check
```

构建应用：

```bash
pnpm check
pnpm tauri build
```

`.app` 和 `.dmg` 会生成在 `src-tauri/target/release/bundle/`。这些是本地构建产物，不会提交到仓库或作为 Release 提供。

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `src/views/` | 状态总览、深度清理、应用卸载和磁盘分析页面 |
| `src/lib/mole.ts` | 前端调用封装、类型定义和输出解析 |
| `src/lib/moCompatibility.ts` | Mole 版本兼容性与输出契约检查 |
| `src/lib/cache.ts` | 内存与本地扫描结果缓存 |
| `src-tauri/src/lib.rs` | Tauri 命令、`mo` 子进程、进度事件和任务控制 |
| `src/apple-hig.css` | 最终加载的 Apple HIG 视觉层 |

## 问题反馈

提交 Issue 时请附上：

- macOS 版本和芯片类型（Apple Silicon / Intel）
- Mole 版本及 `mo --version` 输出
- 问题页面的复现步骤
- 相关错误提示或截图

请勿在 Issue 中公开个人文件路径、应用列表、磁盘扫描结果或其他敏感信息。

## 许可证

本仓库遵循 **GNU GPL v3.0**，完整条款见 [LICENSE](LICENSE)。

上游 Mole 同样遵循 GNU GPL v3.0。本项目与 `tw93/Mole` 维护者没有隶属关系；如需分发或修改，请同时遵守上游项目的许可证与署名要求。

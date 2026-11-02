use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// 长驻的 `mo status --watch` 子进程。watch 模式由 mo 的 warm collector
/// 持续输出 NDJSON，避免每次刷新都重新起进程造成的 CPU 尖峰和卡顿。
static WATCH_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

/// 菜单栏托盘图标；watch 流会周期性把 CPU/内存摘要写到托盘标题上
static TRAY: LazyLock<Mutex<Option<TrayIcon>>> = LazyLock::new(|| Mutex::new(None));
static LAST_TRAY_TITLE: LazyLock<Mutex<Option<std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(None));

/// 重型任务（清理预览/分析/卸载预览等）的全局串行调度状态。
/// 同一时刻只允许一个 mo 进程执行重型任务，避免 CPU/IO 叠加拖垮 UI；
/// 任务带唯一 id，支持取消（离开页面时终止自己的任务）。
struct JobState {
    child: Option<(u64, std::process::Child)>,
    cancelled: std::collections::HashSet<u64>,
}
static JOB: LazyLock<Mutex<JobState>> = LazyLock::new(|| {
    Mutex::new(JobState {
        child: None,
        cancelled: std::collections::HashSet::new(),
    })
});
static CLEAN_MUTATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanTarget {
    path: String,
    section: String,
    bytes: Option<u64>,
    size_text: Option<String>,
    item_count: u64,
    size_known: bool,
    covered_by: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanPreviewResult {
    output: String,
    targets: Vec<CleanTarget>,
}

const MAX_CLEAN_LIST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WHITELIST_BYTES: u64 = 4 * 1024 * 1024;
const WHITELIST_BACKUP_VERSION: u8 = 1;

/// Locate the `mo` binary. GUI apps launched from Finder do not inherit the
/// user's shell PATH, so check the usual install locations before falling
/// back to a PATH lookup.
fn find_mo() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/mo".to_string(),
        "/usr/local/bin/mo".to_string(),
        format!("{home}/.local/bin/mo"),
        format!("{home}/.cargo/bin/mo"),
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Ok(p);
        }
    }
    // 回退到 PATH 查找（注释承诺的行为）：不装在常见位置时也能用
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let p = PathBuf::from(dir).join("mo");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err("未找到 mo 命令，请先安装 Mole：brew install mole".to_string())
}

fn run_mo_with_path(
    mo: &PathBuf,
    args: &[&str],
    stdin_text: Option<&str>,
) -> Result<String, String> {
    // nice 大幅降低 mo 子进程的 CPU 优先级，避免采集时抢占 UI 渲染
    let mut cmd = Command::new("/usr/bin/nice");
    cmd.args(["-n", "10"]).arg(mo).args(args);
    cmd.stdin(if stdin_text.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 mo：{e}"))?;
    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }
    }
    let mut stdout = child.stdout.take().ok_or("无法读取 mo 输出")?;
    let mut stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let (etx, erx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(se) = stderr.as_mut() {
            let _ = se.read_to_end(&mut buf);
        }
        let _ = etx.send(buf);
    });
    // 轻量命令也必须有截止时间：mo 卡死时不能让 invoke 永久悬挂
    let timeout = std::time::Duration::from_secs(30);
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("mo 命令超时（{} 秒无响应）", timeout.as_secs()));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("mo 执行失败：{e}")),
        }
    };
    let out = rx.recv().unwrap_or_default();
    let err_out = erx.recv().unwrap_or_default();
    let mut text = String::from_utf8_lossy(&out).to_string();
    let err = String::from_utf8_lossy(&err_out).to_string();
    if !err.trim().is_empty() {
        text.push_str("\n");
        text.push_str(&err);
    }
    if text.trim().is_empty() {
        if let Some(code) = status.code() {
            if code != 0 {
                text = format!("mo 退出码 {code}");
            }
        }
    }
    Ok(text)
}

/// mo 在交互输出里使用 ANSI 颜色/控制序列，GUI 里直接显示会出乱码，
/// 这里把 ESC [ … 结尾字母 形式的序列剥掉。
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() || c2 == '@' || c2 == '~' {
                        break;
                    }
                }
            } else if chars.peek() == Some(&']') {
                // OSC 序列：ESC ] ... BEL(0x07) 或 ST(ESC \)
                chars.next();
                loop {
                    let Some(c2) = chars.next() else { break };
                    if c2 == '\u{07}' {
                        break;
                    }
                    if c2 == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn run_mo_clean(args: &[&str], stdin_text: Option<&str>) -> Result<String, String> {
    let mo = find_mo()?;
    run_mo_clean_with_path(&mo, args, stdin_text)
}

fn run_mo_clean_with_path(
    mo: &PathBuf,
    args: &[&str],
    stdin_text: Option<&str>,
) -> Result<String, String> {
    run_mo_with_path(mo, args, stdin_text).map(|s| strip_ansi(&s))
}

fn spawn_nice(
    mo: &PathBuf,
    args: &[&str],
    with_stdin: bool,
) -> Result<std::process::Child, String> {
    let mut cmd = Command::new("/usr/bin/nice");
    cmd.args(["-n", "10"])
        .arg(mo)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // stdin 显式设为 null：mo 检测到非 TTY 会自动进入非交互模式，
        // 避免继承父进程 stdin 导致意外交互
        .stdin(if with_stdin {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        });
    cmd.spawn().map_err(|e| format!("无法启动 mo：{e}"))
}

/// 通过 `script` 分配真 PTY 再跑 mo：mo uninstall 会检查 stdin 是否为
/// 终端，明确拒绝从管道读取确认（防止无人审查的自动卸载），
/// 管道喂 "y" 在 mole 1.66 上不起作用。
fn spawn_nice_pty(mo: &PathBuf, args: &[&str]) -> Result<std::process::Child, String> {
    let mut cmd = Command::new("/usr/bin/script");
    cmd.args(["-q", "/dev/null", "/usr/bin/nice", "-n", "10"])
        .arg(mo)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped());
    cmd.spawn().map_err(|e| format!("无法启动 mo：{e}"))
}

/// mo clean 按分类渐进输出（"➤ 分类名"），实测 14 个分类头。
/// 每出现一个标记就给前端发一次真实进度事件；总数以实际看到的
/// 分类头动态校准（mole 升级增减分类时百分比才不会算错）。
const CLEAN_CATEGORY_TOTAL: usize = 14;

fn emit_clean_progress(
    app: &AppHandle,
    id: u64,
    raw_line: &[u8],
    cat_done: &mut usize,
    cat_total: &mut usize,
) {
    let line = strip_ansi(&String::from_utf8_lossy(raw_line));
    let trimmed = line.trim();
    let finished = trimmed.contains("Potential space") || trimmed.contains("Clean complete");
    let marker = trimmed.strip_prefix('➤').map(|s| s.trim().to_string());
    if marker.is_none() && !finished {
        return;
    }
    let (done, label) = if finished {
        (*cat_total, "汇总统计".to_string())
    } else {
        *cat_done += 1;
        if *cat_done > *cat_total {
            *cat_total = *cat_done;
        }
        (*cat_done, marker.unwrap_or_default())
    };
    let _ = app.emit(
        "mole://progress",
        serde_json::json!({ "id": id, "done": done, "total": *cat_total, "label": label }),
    );
}

/// 执行重型 mo 任务：全局串行（排队等前一个完成）。
/// 取消信号对任何任务都生效（用户显式取消优先于"删除不可中断"：
/// 卡在 sudo 授权框上的删除任务只能由用户决定去留）。
/// cancellable=false 只影响看门狗：真实删除（clean/uninstall）不会因
/// stdout 静默被自动杀掉——自动杀会产生"删到一半"的不可知状态，
/// 改为发提醒事件让用户自己决定是否取消。
fn run_mo_heavy(
    app: AppHandle,
    id: u64,
    args: &[&str],
    stdin_text: Option<&str>,
    prompt_response: Option<(&str, &str)>,
    cancellable: bool,
) -> Result<String, String> {
    let mo = find_mo()?;
    // PTY 应答模式下，stdin 句柄要共享给 stdout 读线程用于喂确认键
    let mut pty_stdin: Option<std::sync::Arc<Mutex<Option<std::process::ChildStdin>>>> = None;

    // 串行化：已有任务在跑就轮询等待；自己的 id 被取消则直接退出
    loop {
        {
            let mut g = JOB.lock().map_err(|e| e.to_string())?;
            if g.cancelled.contains(&id) {
                g.cancelled.remove(&id);
                return Err("已取消".to_string());
            }
            if g.child.is_none() {
                let mut c = if prompt_response.is_some() {
                    spawn_nice_pty(&mo, args)?
                } else {
                    spawn_nice(&mo, args, stdin_text.is_some())?
                };
                if let Some(t) = stdin_text {
                    if let Some(mut h) = c.stdin.take() {
                        use std::io::Write;
                        let _ = h.write_all(t.as_bytes());
                    }
                }
                pty_stdin = if prompt_response.is_some() {
                    c.stdin
                        .take()
                        .map(|s| std::sync::Arc::new(Mutex::new(Some(s))))
                } else {
                    None
                };
                g.child = Some((id, c));
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // 同时取出 stdout 和 stderr（stderr 之前被丢弃，导致 mo 崩溃时无法诊断）
    let (mut stdout_handle, mut stderr_handle) = {
        let mut g = JOB.lock().map_err(|e| e.to_string())?;
        let (_, c) = g.child.as_mut().ok_or_else(|| "任务状态异常".to_string())?;
        let so = c
            .stdout
            .take()
            .ok_or_else(|| "无法读取子进程输出".to_string())?;
        let se = c.stderr.take();
        (so, se)
    };

    // 独立线程读 stdout，主循环每 100ms 检查一次取消标记，
    // 保证取消能及时生效（mo 扫描期间可能长时间没有输出）
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    // stderr 也单独读，避免管道满导致子进程阻塞
    let (etx, erx) = std::sync::mpsc::channel::<Vec<u8>>();
    // PTY 模式：stdout 出现确认提示（marker）后再喂应答键（reply），
    // 避免预喂的按键被 mo 的 drain_pending_input 当作"待清理输入"冲掉；
    // marker 和 reply 必须分开——拿 reply 当标记会匹配到输出里的
    // 任意同名字节而提前误触发
    let responder = prompt_response.map(|(m, r)| (m.to_string(), r.to_string()));
    let responder_stdin = pty_stdin;
    if let Some(mut se) = stderr_handle.take() {
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match se.read(&mut buf) {
                    Ok(0) => {
                        let _ = etx.send(Vec::new());
                        break;
                    }
                    Ok(n) => {
                        if etx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = etx.send(Vec::new());
                        break;
                    }
                }
            }
        });
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending = responder;
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match stdout_handle.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Vec::new());
                    break;
                }
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    if carry.len() > 256 {
                        // 只留尾部，防止长输出无限累积
                        carry.drain(..carry.len() - 256);
                    }
                    if let Some((marker, reply)) = pending.as_ref() {
                        if carry.windows(marker.len()).any(|w| w == marker.as_bytes()) {
                            // mo 打印提示后会先 drain 输入缓冲，立刻喂键会被
                            // 当作"待清理输入"冲掉；延迟到 drain 结束、read
                            // 已在阻塞等待时再喂
                            let reply = reply.clone();
                            let stdin = responder_stdin.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(2000));
                                let h = stdin
                                    .as_ref()
                                    .and_then(|arc| arc.lock().ok())
                                    .and_then(|mut g| g.take());
                                if let Some(mut h) = h {
                                    use std::io::Write;
                                    let _ = h.write_all(reply.as_bytes());
                                    let _ = h.flush();
                                }
                            });
                            pending = None;
                        }
                    }
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(Vec::new());
                    break;
                }
            }
        }
    });

    let mut out: Vec<u8> = Vec::new();
    // analyze --json 的全量输出驻留内存；给个硬顶防病态情况吃光内存
    const MAX_HEAVY_OUTPUT: usize = 64 * 1024 * 1024;
    // 看门狗：stdout 静默超过 120 秒就判定扫描挂起/通道断裂，
    // 不再让前端无限等待（历史上出现过子进程被信号杀死但 invoke 悬挂 40 分钟的情况）
    // clean --dry-run 冷启动实测约 150s 且 stdout 全缓冲（结束前零输出），
    // 120s 静默阈值会误杀合法慢扫描；300s 仍能兜底历史上的 40 分钟悬挂
    let silence_limit = std::time::Duration::from_secs(300);
    let mut last_output_at = std::time::Instant::now();
    let mut warned_silence = false;
    let mut line_buf: Vec<u8> = Vec::new();
    let mut cat_done: usize = 0;
    let mut cat_total: usize = CLEAN_CATEGORY_TOTAL;
    let cancelled = loop {
        {
            let g = JOB.lock().map_err(|e| e.to_string())?;
            if g.cancelled.contains(&id) {
                break true;
            }
        }
        match rx.recv_timeout(std::time::Duration::from_millis(1000)) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break false;
                }
                out.extend_from_slice(&chunk);
                if out.len() > MAX_HEAVY_OUTPUT {
                    if let Ok(mut g) = JOB.lock() {
                        if let Some((_, mut c)) = g.child.take() {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                    return Err("输出过大（超过 64MB），已自动终止任务。".to_string());
                }
                line_buf.extend_from_slice(&chunk);
                while let Some(pos) = line_buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = line_buf.drain(..=pos).collect();
                    emit_clean_progress(&app, id, &line, &mut cat_done, &mut cat_total);
                }
                last_output_at = std::time::Instant::now();
                warned_silence = false;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_output_at.elapsed() > silence_limit {
                    if cancellable {
                        // 杀进程、清状态，让串行队列恢复可用
                        if let Ok(mut g) = JOB.lock() {
                            if let Some((_, mut c)) = g.child.take() {
                                let _ = c.kill();
                                let _ = c.wait();
                            }
                        }
                        return Err(
                            "扫描超时：进程长时间没有输出，已自动终止。请重试。".to_string()
                        );
                    }
                    // 真实删除：不自动杀，提醒用户可显式取消
                    if !warned_silence {
                        warned_silence = true;
                        let _ = app.emit(
                            "mole://progress",
                            serde_json::json!({
                                "id": id, "done": 0, "total": 0,
                                "label": "任务已静默较久，仍在运行（可能在等授权）；可点取消强制终止"
                            }),
                        );
                    }
                }
            }
            Err(_) => break false,
        }
    };

    // 回收子进程；被取消的任务先杀掉再回收
    let mut exit_code: Option<i32> = None;
    {
        let mut g = JOB.lock().map_err(|e| e.to_string())?;
        if let Some((_, mut c)) = g.child.take() {
            if cancelled {
                let _ = c.kill();
            }
            if let Ok(s) = c.wait() {
                exit_code = s.code();
            }
        }
        // 用完即清：集合只增不清会长期累积，也可能干扰同 id 复用
        g.cancelled.remove(&id);
    }
    if cancelled {
        return Err("已取消".to_string());
    }
    let mut text = String::from_utf8_lossy(&out).to_string();
    // 把 stderr 内容也拼进来（如果非空）
    let mut err_out: Vec<u8> = Vec::new();
    while let Ok(chunk) = erx.try_recv() {
        if chunk.is_empty() {
            break;
        }
        err_out.extend_from_slice(&chunk);
    }
    let err_text = String::from_utf8_lossy(&err_out).to_string();
    if !err_text.trim().is_empty() {
        if !text.trim().is_empty() {
            text.push('\n');
        }
        text.push_str(&err_text);
    }
    if text.trim().is_empty() {
        if let Some(code) = exit_code {
            if code != 0 {
                text = format!("mo 退出码 {code}");
            }
        }
    }
    Ok(strip_ansi(&text))
}

fn clean_list_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("无法读取用户主目录：{e}"))?;
    Ok(PathBuf::from(home).join(".config/mole/clean-list.txt"))
}

fn whitelist_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("无法读取用户主目录：{e}"))?;
    Ok(PathBuf::from(home).join(".config/mole/whitelist"))
}

fn parse_human_size(text: &str) -> Option<u64> {
    let split = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    let value: f64 = text[..split].parse().ok()?;
    let unit = text[split..].trim().to_ascii_uppercase();
    let power = match unit.as_str() {
        "B" => 0,
        "KB" => 1,
        "MB" => 2,
        "GB" => 3,
        "TB" => 4,
        _ => return None,
    };
    Some((value * 1024_f64.powi(power)) as u64)
}

fn parse_clean_targets(text: &str) -> Vec<CleanTarget> {
    let mut section = String::new();
    let mut targets = Vec::new();

    for line in text.lines() {
        if line.starts_with("=== ") && line.ends_with(" ===") && line.len() >= 8 {
            section = line[4..line.len() - 4].trim().to_string();
            continue;
        }
        if section.is_empty() || !line.starts_with('/') {
            continue;
        }
        let Some((raw_path, note)) = line.rsplit_once("  # ") else {
            continue;
        };
        let path = raw_path.trim_end_matches('/').trim();
        if !path.starts_with('/') || path.chars().any(char::is_control) {
            continue;
        }

        let mut bytes = None;
        let mut size_text = None;
        let mut item_count = 1_u64;
        let mut size_known = false;
        let mut covered_by = None;
        for (index, part) in note.split(", ").enumerate() {
            if index == 0 && part != "size unknown" {
                bytes = parse_human_size(part);
                size_known = bytes.is_some();
                size_text = Some(part.trim().to_string());
            } else if let Some(count) = part.strip_suffix(" items") {
                if let Ok(value) = count.parse::<u64>() {
                    item_count = value.max(1);
                }
            } else if let Some(parent) = part.strip_prefix("counted under ") {
                let parent = parent.trim_end_matches('/');
                if parent.starts_with('/') && !parent.chars().any(char::is_control) {
                    covered_by = Some(parent.to_string());
                }
            }
        }

        targets.push(CleanTarget {
            path: path.to_string(),
            section: section.clone(),
            bytes,
            size_text,
            item_count,
            size_known,
            covered_by,
        });
    }
    targets
}

fn read_bounded_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("拒绝读取非普通文件：{}", path.display()));
    }
    if meta.len() > max_bytes {
        return Err(format!("文件过大：{}", path.display()));
    }
    let file = File::open(path).map_err(|e| format!("无法打开 {}：{e}", path.display()))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("文件过大：{}", path.display()));
    }
    Ok(bytes)
}

fn read_clean_targets() -> Result<Vec<CleanTarget>, String> {
    let path = clean_list_path()?;
    let bytes = read_bounded_regular_file(&path, MAX_CLEAN_LIST_BYTES)?;
    Ok(parse_clean_targets(&String::from_utf8_lossy(&bytes)))
}

fn normalize_target_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "/" {
        "/".to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

fn path_is_within(path: &str, parent: &str) -> bool {
    path == parent
        || (parent != "/"
            && path.starts_with(parent)
            && path.as_bytes().get(parent.len()) == Some(&b'/'))
}

fn selectable_targets(targets: &[CleanTarget]) -> Vec<CleanTarget> {
    targets
        .iter()
        .filter(|target| {
            target.covered_by.is_none()
                && !targets.iter().any(|candidate| {
                    candidate.path != target.path && path_is_within(&target.path, &candidate.path)
                })
        })
        .cloned()
        .collect()
}

fn normalize_selection(selected_paths: &[String]) -> HashSet<String> {
    selected_paths
        .iter()
        .map(|path| normalize_target_path(path))
        .filter(|path| path.starts_with('/'))
        .collect()
}

fn build_selective_whitelist(
    effective_patterns: &[String],
    targets: &[CleanTarget],
    selected: &HashSet<String>,
) -> Vec<String> {
    let mut patterns = effective_patterns.to_vec();
    for target in targets {
        let kept_by_selection = selected
            .iter()
            .any(|selected_path| path_is_within(&target.path, selected_path));
        if !kept_by_selection {
            patterns.push(target.path.clone());
        }
    }

    let mut seen = HashSet::new();
    patterns
        .into_iter()
        .map(|pattern| pattern.trim().to_string())
        .filter(|pattern| !pattern.is_empty() && seen.insert(pattern.clone()))
        .collect()
}

fn effective_mole_whitelist(mo: &Path) -> Result<Vec<String>, String> {
    let canonical = mo
        .canonicalize()
        .map_err(|e| format!("无法定位 Mole 安装目录：{e}"))?;
    let common = canonical
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("libexec/lib/core/common.sh"))
        .ok_or_else(|| "无法定位 Mole 的 whitelist 实现".to_string())?;
    if !common.is_file() {
        return Err("当前 Mole 版本无法导出有效白名单，已取消选择性清理".to_string());
    }

    let script = r#"
set -euo pipefail
source "$1"
MOLE_USER_HOME="$HOME"
load_mole_whitelist "$HOME" >/dev/null
printf '%s\0' "${WHITELIST_PATTERNS[@]}"
"#;
    let output = Command::new("/bin/bash")
        .args(["-c", script, "mole-gui"])
        .arg(&common)
        .output()
        .map_err(|e| format!("无法读取 Mole 白名单：{e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "无法读取 Mole 白名单：{}",
            detail.trim().if_empty("未知错误")
        ));
    }

    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .filter(|pattern| !pattern.chars().any(char::is_control))
        .collect())
}

trait EmptyFallback {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyFallback for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() { fallback } else { self }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhitelistBackupMeta {
    version: u8,
    whitelist_path: String,
    original_exists: bool,
    original_mode: u32,
    original_fingerprint: Option<u64>,
    temporary_fingerprint: u64,
}

struct WhitelistGuard {
    path: PathBuf,
    backup_path: PathBuf,
    meta_path: PathBuf,
    original: Option<(Vec<u8>, u32)>,
    active: bool,
}

fn whitelist_backup_paths(path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Mole 白名单路径无效".to_string())?;
    Ok((
        parent.join(".whitelist.molegui-backup"),
        parent.join(".whitelist.molegui-backup.json"),
    ))
}

fn content_fingerprint(content: &[u8]) -> u64 {
    // FNV-1a 只用于识别“这是否仍是本进程写入的临时白名单”，不是安全哈希。
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn read_optional_regular_file(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(format!("拒绝读取非普通文件：{}", path.display()));
            }
            read_bounded_regular_file(path, max_bytes).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法检查 {}：{error}", path.display())),
    }
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除 {}：{error}", path.display())),
    }
}

fn restore_whitelist_content(path: &Path, original: Option<&(Vec<u8>, u32)>) -> Result<(), String> {
    match original {
        Some((content, mode)) => write_private_file_atomic(path, content, *mode),
        None => remove_file_if_exists(path),
    }
}

fn recover_pending_whitelist_for_path(path: &Path) -> Result<(), String> {
    let (backup_path, meta_path) = whitelist_backup_paths(path)?;
    let Some(meta_bytes) = read_optional_regular_file(&meta_path, 64 * 1024)? else {
        // 没有元数据时，孤立的备份只可能来自“写入元数据前就中断”的事务，
        // 此时原白名单尚未改写；删除残留备份即可。
        return remove_file_if_exists(&backup_path);
    };

    let meta: WhitelistBackupMeta = serde_json::from_slice(&meta_bytes)
        .map_err(|e| format!("临时白名单恢复记录损坏，已停止自动恢复：{e}"))?;
    if meta.version != WHITELIST_BACKUP_VERSION
        || meta.whitelist_path != path.to_string_lossy()
        || meta.original_mode > 0o777
    {
        return Err("临时白名单恢复记录与当前 Mole 配置不匹配，已停止自动恢复".to_string());
    }

    let original = if meta.original_exists {
        let content = read_optional_regular_file(&backup_path, MAX_WHITELIST_BYTES)?
            .ok_or_else(|| "临时白名单备份缺失，已停止自动恢复".to_string())?;
        if Some(content_fingerprint(&content)) != meta.original_fingerprint {
            return Err("临时白名单备份校验失败，已停止自动恢复".to_string());
        }
        Some((content, meta.original_mode))
    } else {
        None
    };

    let current = read_optional_regular_file(path, MAX_WHITELIST_BYTES)?;
    let current_fingerprint = current.as_deref().map(content_fingerprint);
    let already_original = match (&original, current_fingerprint) {
        (Some((content, _)), Some(fingerprint)) => fingerprint == content_fingerprint(content),
        (None, None) => true,
        _ => false,
    };
    let has_temporary = current_fingerprint == Some(meta.temporary_fingerprint);

    if !already_original {
        if has_temporary || (original.is_some() && current.is_none()) {
            restore_whitelist_content(path, original.as_ref())?;
        } else {
            return Err(
                "检测到 Mole 白名单在异常退出后被其他程序修改；为避免覆盖用户设置，已停止自动恢复"
                    .to_string(),
            );
        }
    }

    // 内容恢复成功后才移除记录；顺序保证中途再次崩溃时恢复仍可重试。
    remove_file_if_exists(&meta_path)?;
    remove_file_if_exists(&backup_path)
}

fn recover_pending_whitelist() -> Result<(), String> {
    let path = whitelist_path()?;
    recover_pending_whitelist_for_path(&path)
}

impl WhitelistGuard {
    fn apply(path: PathBuf, content: &str) -> Result<Self, String> {
        recover_pending_whitelist_for_path(&path)?;
        let original = read_optional_regular_file(&path, MAX_WHITELIST_BYTES)?.map(|bytes| {
            let mode = std::fs::symlink_metadata(&path)
                .map(|meta| meta.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            (bytes, mode)
        });
        let parent = path
            .parent()
            .ok_or_else(|| "Mole 白名单路径无效".to_string())?;
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建 Mole 配置目录：{e}"))?;

        let (backup_path, meta_path) = whitelist_backup_paths(&path)?;
        if let Some((bytes, _)) = &original {
            write_private_file_atomic(&backup_path, bytes, 0o600)?;
        }
        let meta = WhitelistBackupMeta {
            version: WHITELIST_BACKUP_VERSION,
            whitelist_path: path.to_string_lossy().to_string(),
            original_exists: original.is_some(),
            original_mode: original.as_ref().map(|(_, mode)| *mode).unwrap_or(0),
            original_fingerprint: original
                .as_ref()
                .map(|(bytes, _)| content_fingerprint(bytes)),
            temporary_fingerprint: content_fingerprint(content.as_bytes()),
        };
        let meta_bytes =
            serde_json::to_vec(&meta).map_err(|e| format!("无法生成白名单恢复记录：{e}"))?;
        if let Err(error) = write_private_file_atomic(&meta_path, &meta_bytes, 0o600) {
            let _ = remove_file_if_exists(&backup_path);
            return Err(error);
        }
        if let Err(error) = write_private_file_atomic(&path, content.as_bytes(), 0o600) {
            let _ = remove_file_if_exists(&meta_path);
            let _ = remove_file_if_exists(&backup_path);
            return Err(error);
        }
        Ok(Self {
            path,
            backup_path,
            meta_path,
            original,
            active: true,
        })
    }

    fn restore(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        restore_whitelist_content(&self.path, self.original.as_ref())?;
        self.active = false;
        let meta_cleanup = remove_file_if_exists(&self.meta_path);
        let backup_cleanup = remove_file_if_exists(&self.backup_path);
        match (meta_cleanup, backup_cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (_, Err(error)) => Err(format!(
                "白名单内容已恢复，但清理恢复记录失败；下次启动会再次校验：{error}"
            )),
        }
    }
}

impl Drop for WhitelistGuard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn write_private_file_atomic(path: &Path, content: &[u8], mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件路径无效".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "目标文件名为空".to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temp = parent.join(format!(
        ".{file_name}.molegui-{}-{nonce}",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(mode);
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("无法写入临时白名单：{e}"))?;
    if let Err(error) = (|| -> std::io::Result<()> {
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode))?;
        std::fs::rename(&temp, path)?;
        Ok(())
    })() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("无法更新临时白名单：{error}"));
    }
    Ok(())
}

fn validate_selection(
    targets: &[CleanTarget],
    selected: &HashSet<String>,
) -> Result<Vec<CleanTarget>, String> {
    if selected.is_empty() {
        return Err("请至少选择一个要清理的项目".to_string());
    }
    let selectable = selectable_targets(targets);
    let selectable_paths: HashSet<String> = selectable
        .iter()
        .map(|target| target.path.clone())
        .collect();
    if !selected.is_subset(&selectable_paths) {
        return Err("所选项目已变化，请重新扫描后再试".to_string());
    }
    Ok(selectable)
}

fn verify_selective_scope(
    targets: &[CleanTarget],
    selected: &HashSet<String>,
) -> Result<(), String> {
    let unexpected: Vec<&str> = targets
        .iter()
        .filter(|target| {
            !selected
                .iter()
                .any(|selected_path| path_is_within(&target.path, selected_path))
        })
        .map(|target| target.path.as_str())
        .collect();
    if unexpected.is_empty() {
        return Ok(());
    }
    Err(format!(
        "范围核对未通过：仍可能清理未选中的项目（例如 {}）。为避免误删，本次没有执行清理。",
        unexpected[0]
    ))
}

#[tauri::command]
fn mo_job_cancel(id: u64) -> Result<(), String> {
    JOB.lock().map_err(|e| e.to_string())?.cancelled.insert(id);
    Ok(())
}

#[tauri::command]
fn mo_clean_targets() -> Result<Vec<CleanTarget>, String> {
    read_clean_targets()
}

// 注意：所有会跑满整个 mo 子进程生命周期的命令必须是 async + spawn_blocking。
// Tauri 的同步命令在主线程上执行，阻塞会冻结 WebView 重绘——
// 症状就是扫描期间界面整个卡死、动效画不出来、点页面不切换。
#[tauri::command]
async fn mo_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| run_mo_clean(&["--version"], None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| run_mo_clean(&["status", "--json"], None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn mo_status_watch_start(app: AppHandle) -> Result<(), String> {
    // 检查、spawn、登记必须在同一临界区内完成：否则两次并发调用会
    // 双双通过检查并各起一个 status-go，先到的 Child 被顶掉后无人能回收
    let mut guard = WATCH_CHILD.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let mo = find_mo()?;
    let mut child = Command::new("/usr/bin/nice")
        .args(["-n", "10"])
        .arg(&mo)
        .args(["status", "--watch", "--interval", "2s"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动 mo status --watch：{e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 mo watch 输出")?;
    guard.replace(child);
    drop(guard);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let _ = app.emit("mole://status", &l);
                    update_tray_title(&l);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // 进程退出（含被 kill）后清理状态，允许前端再次启动
        if let Ok(mut g) = WATCH_CHILD.lock() {
            let _ = g.take();
        }
    });
    Ok(())
}

/// 从 watch 流的一行 NDJSON 里取 CPU/内存摘要，节流后写到菜单栏托盘标题，
/// 让用户不开主窗口也能瞟到系统状态（学习 Stats / CleanMyMac 的菜单栏思路）
fn update_tray_title(line: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let Some(cpu) = v.pointer("/cpu/usage").and_then(|x| x.as_f64()) else {
        return;
    };
    let Some(mem) = v.pointer("/memory/used_percent").and_then(|x| x.as_f64()) else {
        return;
    };
    {
        let Ok(mut last) = LAST_TRAY_TITLE.lock() else {
            return;
        };
        if let Some(t) = *last {
            if t.elapsed() < std::time::Duration::from_secs(4) {
                return;
            }
        }
        *last = Some(std::time::Instant::now());
    }
    if let Ok(mut g) = TRAY.lock() {
        if let Some(tray) = g.as_mut() {
            let _ = tray.set_title(Some(format!("CPU {:.0}% · 内存 {:.0}%", cpu, mem)));
        }
    }
}

/// 菜单栏托盘：左键点开主窗口，菜单可打开/退出
fn build_tray(app: &tauri::App) -> Result<(), String> {
    let show = MenuItemBuilder::with_id("show", "打开 Mole")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出 Mole")
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &quit])
        .build()
        .map_err(|e| e.to_string())?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| e.to_string())?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .title("Mole")
        .tooltip("Mole — Mac 工具箱")
        .menu(&menu)
        .menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    TRAY.lock().map_err(|e| e.to_string())?.replace(tray);
    Ok(())
}

#[tauri::command]
fn mo_status_watch_stop() -> Result<(), String> {
    if let Some(mut child) = WATCH_CHILD.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
async fn mo_clean_preview(app: AppHandle, id: u64) -> Result<CleanPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_mo_heavy(app, id, &["clean", "--dry-run"], None, None, true)?;
        let targets = read_clean_targets()?;
        Ok(CleanPreviewResult { output, targets })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_clean_run(
    app: AppHandle,
    id: u64,
    selected_paths: Vec<String>,
) -> Result<String, String> {
    // 全选时保持 Mole 的原生全量清理；部分选择时，临时白名单只放行已选项，
    // 并在真正删除前再做一次 dry-run 核对实际范围。
    tauri::async_runtime::spawn_blocking(move || {
        let _mutation_lock = CLEAN_MUTATION_LOCK
            .lock()
            .map_err(|e| format!("清理任务锁已损坏：{e}"))?;
        let targets = read_clean_targets()?;
        let selected = normalize_selection(&selected_paths);
        let selectable = validate_selection(&targets, &selected)?;
        let selectable_paths: HashSet<String> = selectable
            .iter()
            .map(|target| target.path.clone())
            .collect();

        if selected == selectable_paths {
            return run_mo_heavy(app, id, &["clean"], None, None, false);
        }

        let mo = find_mo()?;
        let effective_patterns = effective_mole_whitelist(&mo)?;
        let patterns = build_selective_whitelist(&effective_patterns, &targets, &selected);
        let mut content = patterns.join("\n");
        content.push('\n');
        let mut guard = WhitelistGuard::apply(whitelist_path()?, &content)?;

        let _ = app.emit(
            "mole://clean-stage",
            serde_json::json!({ "id": id, "stage": "verifying" }),
        );
        let result = (|| -> Result<String, String> {
            let _ = run_mo_heavy(app.clone(), id, &["clean", "--dry-run"], None, None, true)?;
            let verified_targets = read_clean_targets()?;
            verify_selective_scope(&verified_targets, &selected)?;

            let _ = app.emit(
                "mole://clean-stage",
                serde_json::json!({ "id": id, "stage": "cleaning" }),
            );
            run_mo_heavy(app.clone(), id, &["clean"], None, None, false)
        })();
        let restored = guard.restore();

        match (result, restored) {
            (Ok(output), Ok(())) => Ok(output),
            (Ok(output), Err(restore_error)) => Ok(format!(
                "{output}\n\n注意：清理已执行，但临时白名单未能自动恢复。{restore_error}"
            )),
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(restore_error)) => Err(format!(
                "{error}\n同时未能恢复 Mole 白名单：{restore_error}"
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_uninstall_list(app: AppHandle, id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_mo_heavy(app, id, &["uninstall", "--list"], None, None, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_uninstall_preview(app: AppHandle, name: String, id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_mo_heavy(
            app,
            id,
            &["uninstall", "--dry-run", &name],
            None,
            None,
            true,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_uninstall_run(
    app: AppHandle,
    name: String,
    permanent: bool,
    id: u64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = if permanent {
            vec!["uninstall", "--permanent", &name]
        } else {
            vec!["uninstall", &name]
        };
        // mo uninstall 明确要求交互式确认（检查 stdin 是否为终端），
        // 必须经真 PTY 运行，并在出现确认提示后喂 "y"。
        run_mo_heavy(app, id, &args, None, Some(("confirm,", "y")), false)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mo_analyze(app: AppHandle, path: Option<String>, id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || match path {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim().to_string();
            run_mo_heavy(app, id, &["analyze", "--json", &p], None, None, true)
        }
        _ => run_mo_heavy(app, id, &["analyze", "--json"], None, None, true),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 扫描结果的磁盘缓存目录（跟随 gdu/GrandPerspective 的「结果持久化」思路：
/// 扫一次落盘，下次启动先展示旧结果，后台再刷新）。
fn cache_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(home).join("Library/Application Support/MoleGUI");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 缓存文件名只留字母数字和 - _，防止路径穿越
fn sanitize_cache_name(name: &str) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("非法的缓存名".to_string());
    }
    Ok(safe)
}

fn cache_file(name: &str) -> Result<PathBuf, String> {
    let safe = sanitize_cache_name(name)?;
    // 过滤字符后不同输入可能同名（如 "A B" 与 "AB"），
    // 追加原始输入的 FNV-1a 哈希保证键一一对应
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in name.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(cache_dir()?.join(format!("{safe}-{hash:016x}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct FakeMo {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Drop for FakeMo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fake_mo(body: &str) -> FakeMo {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mole-gui-test-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mo");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        FakeMo { dir, path }
    }

    fn target(path: &str, bytes: Option<u64>, covered_by: Option<&str>) -> CleanTarget {
        CleanTarget {
            path: path.to_string(),
            section: "Test".to_string(),
            bytes,
            size_text: bytes.map(|_| "1MB".to_string()),
            item_count: 1,
            size_known: bytes.is_some(),
            covered_by: covered_by.map(str::to_string),
        }
    }

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32mOK\u{1b}[0m"), "OK");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        assert_eq!(strip_ansi("\u{1b}]0;title\u{07}body"), "body");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{1b}\\tail"), "tail");
    }

    #[test]
    fn strip_ansi_keeps_plain_text_and_emoji() {
        assert_eq!(strip_ansi("普通文本 123 ➤"), "普通文本 123 ➤");
    }

    #[test]
    fn sanitize_cache_name_filters_path_separators() {
        assert_eq!(
            sanitize_cache_name("../../etc/passwd").unwrap(),
            "etcpasswd"
        );
        assert_eq!(
            sanitize_cache_name("analyze-/Users/x").unwrap(),
            "analyze-Usersx"
        );
    }

    #[test]
    fn sanitize_cache_name_rejects_fully_filtered_names() {
        assert!(sanitize_cache_name("").is_err());
        assert!(sanitize_cache_name("///").is_err());
    }

    #[test]
    fn cache_file_distinguishes_inputs_that_sanitize_identically() {
        let a = cache_file("A B").unwrap();
        let b = cache_file("AB").unwrap();
        assert_ne!(a, b);
        let a2 = cache_file("A B").unwrap();
        assert_eq!(a, a2);
    }

    #[test]
    fn fake_mo_verifies_process_output_and_ansi_stripping() {
        let fake = fake_mo("printf '\\033[32mMole version 1.66.0\\033[0m\\n'");
        let output = run_mo_clean_with_path(&fake.path, &["--version"], None).unwrap();
        assert_eq!(output.trim(), "Mole version 1.66.0");
    }

    #[test]
    fn fake_mo_verifies_noninteractive_spawn() {
        let fake = fake_mo("printf 'plain-ok\\n'");
        let mut child = spawn_nice(&fake.path, &[], false).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        assert_eq!(output.trim(), "plain-ok");
    }

    #[test]
    fn fake_mo_verifies_pty_spawn() {
        let fake = fake_mo("printf 'pty-ok\\n'");
        let mut child = spawn_nice_pty(&fake.path, &[]).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        assert!(output.contains("pty-ok"));
    }

    #[test]
    fn parses_clean_target_paths_sizes_and_coverage() {
        let text = [
            "# Mole Cleanup Preview",
            "=== User essentials ===",
            "/Users/me/Library/Caches/App  # 1.5MB, 3 items",
            "/Users/me/Library/Caches/App/sub  # 4KB, counted under /Users/me/Library/Caches/App",
            "=== Application Support ===",
            "/Users/me/Library/Application Support/Tool/cache  # size unknown",
        ]
        .join("\n");
        let targets = parse_clean_targets(&text);
        assert_eq!(targets.len(), 3);
        assert_eq!(targets[0].section, "User essentials");
        assert_eq!(targets[0].bytes, Some(1_572_864));
        assert_eq!(targets[0].item_count, 3);
        assert_eq!(targets[1].bytes, Some(4_096));
        assert_eq!(
            targets[1].covered_by.as_deref(),
            Some("/Users/me/Library/Caches/App")
        );
        assert!(!targets[2].size_known);
        assert_eq!(targets[2].bytes, None);
    }

    #[test]
    fn selectable_targets_are_disjoint_top_level_paths() {
        let targets = vec![
            target("/Users/me/Library/Caches/App", None, None),
            target("/Users/me/Library/Caches/App/sub", Some(1024), None),
            target("/Users/me/.npm/_logs", Some(2048), None),
            target(
                "/Users/me/Library/Caches/Covered",
                Some(4096),
                Some("/Users/me/Library/Caches/App"),
            ),
        ];
        let selectable = selectable_targets(&targets);
        let paths: Vec<&str> = selectable
            .iter()
            .map(|target| target.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec!["/Users/me/Library/Caches/App", "/Users/me/.npm/_logs"]
        );
    }

    #[test]
    fn selective_whitelist_protects_everything_not_selected() {
        let targets = vec![
            target("/Users/me/Library/Caches/App", Some(1024), None),
            target(
                "/Users/me/Library/Caches/App/sub",
                Some(1024),
                Some("/Users/me/Library/Caches/App"),
            ),
            target("/Users/me/.npm/_logs", Some(2048), None),
        ];
        let selected = HashSet::from(["/Users/me/Library/Caches/App".to_string()]);
        let patterns = build_selective_whitelist(
            &["/Users/me/Library/Mobile Documents*".to_string()],
            &targets,
            &selected,
        );
        assert!(patterns.contains(&"/Users/me/Library/Mobile Documents*".to_string()));
        assert!(patterns.contains(&"/Users/me/.npm/_logs".to_string()));
        assert!(!patterns.contains(&"/Users/me/Library/Caches/App".to_string()));
        assert!(!patterns.contains(&"/Users/me/Library/Caches/App/sub".to_string()));
    }

    #[test]
    fn selective_scope_rejects_any_unselected_target() {
        let selected = HashSet::from(["/Users/me/Library/Caches/App".to_string()]);
        assert!(
            verify_selective_scope(
                &[target("/Users/me/Library/Caches/App/sub", Some(1024), None)],
                &selected
            )
            .is_ok()
        );
        assert!(
            verify_selective_scope(
                &[target("/Users/me/.npm/_logs", Some(1024), None)],
                &selected
            )
            .is_err()
        );
    }

    #[test]
    fn whitelist_guard_restores_existing_file_and_removes_temporary_file() {
        let root = std::env::temp_dir().join(format!(
            "mole-gui-whitelist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("whitelist");
        std::fs::write(&path, b"original\n").unwrap();
        {
            let mut guard = WhitelistGuard::apply(path.clone(), "temporary\n").unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "temporary\n");
            guard.restore().unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
        }
        std::fs::remove_file(&path).unwrap();
        {
            let mut guard = WhitelistGuard::apply(path.clone(), "temporary\n").unwrap();
            guard.restore().unwrap();
            assert!(!path.exists());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn whitelist_recovery_restores_existing_file_after_unclean_exit() {
        let root = std::env::temp_dir().join(format!(
            "mole-gui-whitelist-recover-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("whitelist");
        std::fs::write(&path, b"original\n").unwrap();

        let guard = WhitelistGuard::apply(path.clone(), "temporary\n").unwrap();
        std::mem::forget(guard);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "temporary\n");

        recover_pending_whitelist_for_path(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
        let (backup, meta) = whitelist_backup_paths(&path).unwrap();
        assert!(!backup.exists());
        assert!(!meta.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn whitelist_recovery_removes_temporary_file_created_from_nothing() {
        let root = std::env::temp_dir().join(format!(
            "mole-gui-whitelist-recover-new-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("whitelist");

        let guard = WhitelistGuard::apply(path.clone(), "temporary\n").unwrap();
        std::mem::forget(guard);
        assert!(path.exists());

        recover_pending_whitelist_for_path(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
fn mo_cache_read(name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(cache_file(&name)?) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn mo_cache_write(name: String, content: String) -> Result<(), String> {
    std::fs::write(cache_file(&name)?, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动时把已有窗口带到前台，而不是再开一个实例
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            if let Err(error) = recover_pending_whitelist() {
                eprintln!("[mole-gui] 未能恢复上次异常中断的临时白名单：{error}");
            }
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mo_version,
            mo_status,
            mo_status_watch_start,
            mo_status_watch_stop,
            mo_job_cancel,
            mo_clean_preview,
            mo_clean_targets,
            mo_clean_run,
            mo_uninstall_list,
            mo_uninstall_preview,
            mo_uninstall_run,
            mo_analyze,
            mo_cache_read,
            mo_cache_write
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                cleanup_children();
            }
            let _ = app_handle;
        });
}

/// 清理后台子进程：watch 的 status-go 若还存活就杀掉，
/// 避免每次启动泄漏一个采集进程（CPU 常年占用）。
fn cleanup_children() {
    if let Ok(mut g) = WATCH_CHILD.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

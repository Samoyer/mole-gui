use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use std::io::Read;
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
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

fn run_mo(args: &[&str], stdin_text: Option<&str>) -> Result<String, String> {
    let mo = find_mo()?;
    // nice 大幅降低 mo 子进程的 CPU 优先级，避免采集时抢占 UI 渲染
    let mut cmd = Command::new("/usr/bin/nice");
    cmd.args(["-n", "10"]).arg(&mo).args(args);
    if let Some(text) = stdin_text {
        cmd.stdin(std::process::Stdio::piped());
        let mut child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("无法启动 mo：{e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| format!("mo 执行失败：{e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if !err.trim().is_empty() {
            text.push_str("\n");
            text.push_str(&err);
        }
        Ok(text)
    } else {
        let out = cmd
            .output()
            .map_err(|e| format!("无法运行 mo：{e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if !err.trim().is_empty() {
            text.push_str("\n");
            text.push_str(&err);
        }
        Ok(text)
    }
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
                    if c2 == '\u{07}' { break; }
                    if c2 == '\u{1b}' {
                        if chars.peek() == Some(&'\\') { chars.next(); }
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
    run_mo(args, stdin_text).map(|s| strip_ansi(&s))
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
        .stderr(std::process::Stdio::piped());
    if with_stdin {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.spawn().map_err(|e| format!("无法启动 mo：{e}"))
}

/// 执行重型 mo 任务：全局串行（排队等前一个完成）、可取消。
/// cancellable=false 用于真实删除（clean/uninstall），取消信号会被忽略，
/// 防止删除进行到一半被中断。
fn run_mo_heavy(
    id: u64,
    args: &[&str],
    stdin_text: Option<&str>,
    cancellable: bool,
) -> Result<String, String> {
    let mo = find_mo()?;

    // 串行化：已有任务在跑就轮询等待；自己的 id 被取消则直接退出
    loop {
        {
            let mut g = JOB.lock().map_err(|e| e.to_string())?;
            if g.cancelled.contains(&id) {
                return Err("已取消".to_string());
            }
            if g.child.is_none() {
                let mut c = spawn_nice(&mo, args, stdin_text.is_some())?;
                if let Some(t) = stdin_text {
                    if let Some(mut h) = c.stdin.take() {
                        use std::io::Write;
                        let _ = h.write_all(t.as_bytes());
                    }
                }
                g.child = Some((id, c));
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // 同时取出 stdout 和 stderr（stderr 之前被丢弃，导致 mo 崩溃时无法诊断）
    let (mut stdout_handle, mut stderr_handle) = {
        let mut g = JOB.lock().map_err(|e| e.to_string())?;
        let (_, c) = g
            .child
            .as_mut()
            .ok_or_else(|| "任务状态异常".to_string())?;
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
        loop {
            match stdout_handle.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Vec::new());
                    break;
                }
                Ok(n) => {
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
    // 看门狗：stdout 静默超过 120 秒就判定扫描挂起/通道断裂，
    // 不再让前端无限等待（历史上出现过子进程被信号杀死但 invoke 悬挂 40 分钟的情况）
    let silence_limit = std::time::Duration::from_secs(120);
    let mut last_output_at = std::time::Instant::now();
    let cancelled = loop {
        {
            let g = JOB.lock().map_err(|e| e.to_string())?;
            if cancellable && g.cancelled.contains(&id) {
                break true;
            }
        }
        match rx.recv_timeout(std::time::Duration::from_millis(1000)) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break false;
                }
                out.extend_from_slice(&chunk);
                last_output_at = std::time::Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_output_at.elapsed() > silence_limit {
                    // 杀进程、清状态，让串行队列恢复可用
                    if let Ok(mut g) = JOB.lock() {
                        if let Some((_, mut c)) = g.child.take() {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                    return Err("扫描超时：进程长时间没有输出，已自动终止。请重试。".to_string());
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

#[tauri::command]
fn mo_job_cancel(id: u64) -> Result<(), String> {
    JOB.lock()
        .map_err(|e| e.to_string())?
        .cancelled
        .insert(id);
    Ok(())
}

#[tauri::command]
fn mo_version() -> Result<String, String> {
    run_mo_clean(&["--version"], None)
}

#[tauri::command]
fn mo_status() -> Result<String, String> {
    run_mo_clean(&["status", "--json"], None)
}

#[tauri::command]
fn mo_status_watch_start(app: AppHandle) -> Result<(), String> {
    {
        let guard = WATCH_CHILD.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
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
    WATCH_CHILD
        .lock()
        .map_err(|e| e.to_string())?
        .replace(child);
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
    let show = MenuItemBuilder::with_id("show", "打开 Mole").build(app).map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出 Mole").build(app).map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build().map_err(|e| e.to_string())?;
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
fn mo_clean_preview(id: u64) -> Result<String, String> {
    run_mo_heavy(id, &["clean", "--dry-run"], None, true)
}

#[tauri::command]
fn mo_clean_run(id: u64) -> Result<String, String> {
    // "y" answers mo's interactive confirmation; the frontend gates this
    // behind an explicit user confirmation sheet.
    run_mo_heavy(id, &["clean"], Some("y\n"), false)
}

#[tauri::command]
fn mo_uninstall_list(id: u64) -> Result<String, String> {
    run_mo_heavy(id, &["uninstall", "--list"], None, true)
}

#[tauri::command]
fn mo_uninstall_preview(name: String, id: u64) -> Result<String, String> {
    run_mo_heavy(id, &["uninstall", "--dry-run", &name], None, true)
}

#[tauri::command]
fn mo_uninstall_run(name: String, permanent: bool, id: u64) -> Result<String, String> {
    let args: Vec<&str> = if permanent {
        vec!["uninstall", "--permanent", &name]
    } else {
        vec!["uninstall", &name]
    };
    run_mo_heavy(id, &args, Some("y\n"), false)
}

#[tauri::command]
fn mo_analyze(path: Option<String>, id: u64) -> Result<String, String> {
    match path {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim().to_string();
            run_mo_heavy(id, &["analyze", "--json", &p], None, true)
        }
        _ => run_mo_heavy(id, &["analyze", "--json"], None, true),
    }
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
fn cache_file(name: &str) -> Result<PathBuf, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("非法的缓存名".to_string());
    }
    Ok(cache_dir()?.join(format!("{safe}.json")))
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
        .setup(|app| {
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

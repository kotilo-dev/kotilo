//! Process listing off Windows (U-2): the agent tracker's presence and classification
//! checks need every process's parent and name, and node-based agents need a command line.
//! Linux reads `/proc`; macOS (no `/proc`) runs `/bin/ps`. Windows uses the Toolhelp and
//! NT queries in `pty`.

/// One process: pid, parent pid and executable name (no path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// Every process on the machine this user can see.
#[cfg(target_os = "linux")]
pub fn list() -> Vec<Process> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| {
            let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let (ppid, name) = parse_proc_stat(&text)?;
            Some(Process { pid, ppid, name })
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
pub fn list() -> Vec<Process> {
    ps(&["-A", "-o", "pid=,ppid=,comm="])
        .map(|out| out.lines().filter_map(parse_ps_line).collect())
        .unwrap_or_default()
}

/// The process's command line, arguments joined with spaces.
#[cfg(target_os = "linux")]
pub fn command_line(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let text = String::from_utf8_lossy(&bytes).replace('\0', " ");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(not(target_os = "linux"))]
pub fn command_line(pid: u32) -> Option<String> {
    let pid = pid.to_string();
    let out = ps(&["-o", "command=", "-p", &pid])?;
    let text = out.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(not(target_os = "linux"))]
fn ps(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(args)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `/proc/<pid>/stat`: `pid (comm) state ppid …`. `comm` may hold spaces or `)`, so the
/// fields after it are taken from the last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_stat(text: &str) -> Option<(u32, String)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let name = text.get(open + 1..close)?.to_string();
    let ppid = text.get(close + 1..)?.split_whitespace().nth(1)?.parse().ok()?;
    Some((ppid, name))
}

/// One `ps -o pid=,ppid=,comm=` line; `comm` is the executable path (may hold spaces), kept
/// as its file name.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn parse_ps_line(line: &str) -> Option<Process> {
    let mut fields = line.trim_start().splitn(2, char::is_whitespace);
    let pid = fields.next()?.parse().ok()?;
    let mut rest = fields.next()?.trim_start().splitn(2, char::is_whitespace);
    let ppid = rest.next()?.parse().ok()?;
    let comm = rest.next()?.trim();
    let name = comm.rsplit('/').next().unwrap_or(comm).to_string();
    Some(Process { pid, ppid, name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proc_stat_reads_ppid_and_a_name_with_spaces_and_parens() {
        assert_eq!(parse_proc_stat("4321 (claude) S 1200 4321 4321 34816"), Some((1200, "claude".to_string())));
        assert_eq!(parse_proc_stat("77 (my (odd) app) R 1 77"), Some((1, "my (odd) app".to_string())));
        assert_eq!(parse_proc_stat("garbage"), None);
    }

    #[test]
    fn parse_ps_line_keeps_the_executable_file_name() {
        let p = |pid, ppid, name: &str| Some(Process { pid, ppid, name: name.to_string() });
        assert_eq!(parse_ps_line("  812   1 /usr/local/bin/claude"), p(812, 1, "claude"));
        assert_eq!(parse_ps_line("900 812 -zsh"), p(900, 812, "-zsh"));
        assert_eq!(parse_ps_line("x 1 bad"), None);
    }

    #[test]
    fn list_has_this_process_under_its_parent_with_its_command_line() {
        let me = std::process::id();
        let found = list().into_iter().find(|p| p.pid == me).expect("this process is listed");
        assert!(found.ppid > 0);
        assert!(command_line(me).is_some_and(|c| !c.is_empty()));
    }
}

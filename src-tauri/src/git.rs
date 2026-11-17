//! Repository discovery and status, using the user's own `git` binary.
//!
//! Shelling out to `git` (instead of libgit2) means we honour the user's config
//! (safe.directory, fsmonitor, credential helpers, ...) and stay tiny.
//! All read commands run with `GIT_OPTIONAL_LOCKS=0` so we never take the index lock
//! or interfere with an editor / terminal working in the same repo.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rayon::prelude::*;
use serde::Serialize;

/// Directory names that never contain repos worth listing (or are huge).
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "vendor", "Library", "Applications", "build", "dist", "out",
    "Pods", "DerivedData", "venv", "__pycache__", "bower_components", "Movies", "Music", "Pictures",
];

const FETCH_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub summary: String,
    pub author: String,
    /// Unix seconds.
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub path: String,
    pub name: String,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub stashes: u32,
    pub last_commit: Option<CommitInfo>,
    pub remote_url: Option<String>,
    /// Browser URL for the remote (GitHub/GitLab/...), credentials stripped.
    pub web_url: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// git binary
// ---------------------------------------------------------------------------

/// GUI apps on macOS get a minimal PATH, so look in the usual places first.
fn git_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .unwrap_or("git")
            .to_string()
    })
}

fn git(repo: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(git_bin());
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    cmd
}

fn git_output(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(repo, args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn git_available() -> bool {
    Command::new(git_bin())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Common places developers keep code, filtered to those that exist.
pub fn default_roots() -> Vec<String> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    [
        "Developer", "Projects", "projects", "code", "Code", "src", "dev", "workspace", "repos",
        "GitHub", "git", "Documents",
    ]
    .iter()
    .map(|d| home.join(d))
    .filter(|p| p.is_dir())
    .map(|p| p.display().to_string())
    .collect()
}

fn is_repo(dir: &Path) -> bool {
    // `.git` is a directory for normal repos and a file for worktrees/submodules.
    dir.join(".git").exists()
}

fn walk(dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<PathBuf>) {
    if is_repo(dir) {
        out.push(dir.to_path_buf());
        return; // don't descend into repos (submodules, vendored repos)
    }
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        walk(&entry.path(), depth + 1, max_depth, out);
    }
}

/// Find git repositories under `roots`, at most `max_depth` levels deep.
pub fn find_repos(roots: &[String], max_depth: u32) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = roots
        .par_iter()
        .flat_map(|root| {
            let mut out = Vec::new();
            walk(Path::new(root), 0, max_depth, &mut out);
            out
        })
        .collect();
    // Roots may overlap (e.g. ~/Documents and ~/Documents/work).
    found.sort();
    found.dedup();
    found
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Parse `git status --porcelain=v2 --branch` output into `status`.
fn parse_porcelain_v2(text: &str, status: &mut RepoStatus) {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = (rest != "(detached)").then(|| rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+<ahead> -<behind>"
            let mut parts = rest.split_whitespace();
            status.ahead = parts.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            status.behind = parts.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // "1 XY ..." — X = index (staged), Y = worktree (modified)
            let xy = line.as_bytes().get(2..4).unwrap_or(b"..");
            if xy[0] != b'.' {
                status.staged += 1;
            }
            if xy[1] != b'.' {
                status.modified += 1;
            }
        } else if line.starts_with("u ") {
            status.conflicted += 1;
        } else if line.starts_with("? ") {
            status.untracked += 1;
        }
    }
}

/// Turn a remote URL into something a browser can open. Strips credentials.
pub fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim();
    let (host, path) = if let Some(rest) = r.strip_prefix("git@") {
        // git@github.com:user/repo.git
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = r
        .strip_prefix("https://")
        .or_else(|| r.strip_prefix("http://"))
        .or_else(|| r.strip_prefix("ssh://"))
        .or_else(|| r.strip_prefix("git://"))
    {
        let (authority, path) = rest.split_once('/')?;
        // drop "user:token@" and ":port"
        let host = authority.rsplit('@').next()?.split(':').next()?;
        (host.to_string(), path.to_string())
    } else {
        return None; // local path remotes etc.
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("https://{host}/{path}"))
}

pub fn repo_status(path: &Path) -> RepoStatus {
    let mut status = RepoStatus {
        path: path.display().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
        ..Default::default()
    };

    match git_output(path, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]) {
        Ok(text) => parse_porcelain_v2(&text, &mut status),
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    }

    // Last commit (may fail on a fresh repo with no commits).
    if let Ok(log) = git_output(path, &["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%ct"]) {
        let f: Vec<&str> = log.trim_end().split('\x1f').collect();
        if f.len() == 4 {
            status.last_commit = Some(CommitInfo {
                hash: f[0].to_string(),
                summary: f[1].to_string(),
                author: f[2].to_string(),
                timestamp: f[3].parse().unwrap_or(0),
            });
        }
    }

    if let Ok(stash) = git_output(path, &["stash", "list", "--format=%H"]) {
        status.stashes = stash.lines().filter(|l| !l.is_empty()).count() as u32;
    }

    // Prefer the upstream's remote, fall back to "origin", then any remote.
    let remote_name = status
        .upstream
        .as_deref()
        .and_then(|u| u.split_once('/').map(|(r, _)| r.to_string()))
        .or_else(|| {
            let remotes = git_output(path, &["remote"]).ok()?;
            let list: Vec<&str> = remotes.lines().collect();
            list.iter()
                .find(|r| **r == "origin")
                .or(list.first())
                .map(|r| r.to_string())
        });
    if let Some(name) = remote_name {
        if let Ok(url) = git_output(path, &["remote", "get-url", &name]) {
            let url = url.trim().to_string();
            status.web_url = web_url(&url);
            status.remote_url = Some(url);
        }
    }

    status
}

pub fn scan(roots: &[String], max_depth: u32) -> Vec<RepoStatus> {
    let repos = find_repos(roots, max_depth);
    let mut statuses: Vec<RepoStatus> = repos.par_iter().map(|p| repo_status(p)).collect();
    statuses.sort_by_key(|s| s.name.to_lowercase());
    statuses
}

/// `git fetch --all --prune` with a timeout, then a fresh status.
pub fn fetch(path: &Path) -> Result<RepoStatus, String> {
    if !is_repo(path) {
        return Err(format!("{} is not a git repository.", path.display()));
    }
    let mut child = git(path, &["fetch", "--all", "--prune", "--quiet"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run git: {e}"))?;

    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) if s.success() => break,
            Some(_) => {
                let mut err = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use std::io::Read;
                    let _ = stderr.read_to_string(&mut err);
                }
                return Err(format!("git fetch failed: {}", err.trim()));
            }
            None if start.elapsed() > FETCH_TIMEOUT => {
                let _ = child.kill();
                return Err("git fetch timed out.".into());
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    Ok(repo_status(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmpdir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "reporadar-test-{}-{}-{}",
            std::process::id(),
            tag,
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Best effort: on Windows git marks object files read-only, so deletion can fail.
    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn init_repo(dir: &Path) {
        run(dir, &["init", "-q", "-b", "main"]);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(dir, &["add", "."]);
        run(dir, &["commit", "-q", "-m", "first commit"]);
    }

    #[test]
    fn porcelain_parsing() {
        let text = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n\
                    1 M. N... 100644 100644 100644 a b f1\n\
                    1 .M N... 100644 100644 100644 a b f2\n\
                    1 MM N... 100644 100644 100644 a b f3\n\
                    2 R. N... 100644 100644 100644 a b R100 new\told\n\
                    u UU N... 1 2 3 4 a b c f4\n\
                    ? new.txt\n? other.txt\n";
        let mut s = RepoStatus::default();
        parse_porcelain_v2(text, &mut s);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 3));
        assert_eq!((s.staged, s.modified, s.conflicted, s.untracked), (3, 2, 1, 2));
    }

    #[test]
    fn detached_head() {
        let mut s = RepoStatus::default();
        parse_porcelain_v2("# branch.head (detached)\n", &mut s);
        assert_eq!(s.branch, None);
    }

    #[test]
    fn web_urls() {
        assert_eq!(web_url("git@github.com:me/app.git").as_deref(), Some("https://github.com/me/app"));
        assert_eq!(web_url("https://github.com/me/app.git").as_deref(), Some("https://github.com/me/app"));
        assert_eq!(
            web_url("https://me:ghp_secret@github.com/me/app.git").as_deref(),
            Some("https://github.com/me/app"),
            "credentials must be stripped"
        );
        assert_eq!(
            web_url("ssh://git@gitlab.example.com:2222/team/app.git").as_deref(),
            Some("https://gitlab.example.com/team/app")
        );
        assert_eq!(web_url("/srv/git/app.git"), None);
    }

    #[test]
    fn finds_repos_and_skips_noise() {
        let root = tmpdir("find");
        for p in ["a", "group/b", "node_modules/c", ".hidden/d", "a/nested"] {
            let d = root.join(p);
            fs::create_dir_all(&d).unwrap();
            run(&d, &["init", "-q"]);
        }
        let found = find_repos(&[root.display().to_string()], 4);
        let rel: Vec<PathBuf> = found.iter().map(|p| p.strip_prefix(&root).unwrap().to_path_buf()).collect();
        // Compare as paths, so the separator is right on Windows too.
        assert_eq!(rel, vec![PathBuf::from("a"), Path::new("group").join("b")]);
        cleanup(&root);
    }

    #[test]
    fn reports_full_status() {
        let root = tmpdir("status");
        let origin = root.join("origin.git");
        fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "-q", "--bare", "-b", "main"]);

        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        init_repo(&work);
        run(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
        run(&work, &["push", "-q", "-u", "origin", "main"]);

        // one unpushed commit
        fs::write(work.join("b.txt"), "b\n").unwrap();
        run(&work, &["add", "b.txt"]);
        run(&work, &["commit", "-q", "-m", "second commit"]);
        // a stash
        fs::write(work.join("a.txt"), "stashed\n").unwrap();
        run(&work, &["stash", "-q"]);
        // staged, modified, untracked
        fs::write(work.join("c.txt"), "c\n").unwrap();
        run(&work, &["add", "c.txt"]);
        fs::write(work.join("a.txt"), "changed\n").unwrap();
        fs::write(work.join("new.txt"), "new\n").unwrap();

        let s = repo_status(&work);
        assert_eq!(s.error, None);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (1, 0));
        assert_eq!((s.staged, s.modified, s.untracked, s.stashes), (1, 1, 1, 1));
        assert_eq!(s.last_commit.as_ref().unwrap().summary, "second commit");
        assert!(s.remote_url.is_some());

        // A second clone pushes → after fetch, `work` is behind by 1.
        let other = root.join("other");
        run(&root, &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
        fs::write(other.join("z.txt"), "z\n").unwrap();
        run(&other, &["add", "."]);
        run(&other, &["commit", "-q", "-m", "from elsewhere"]);
        run(&other, &["push", "-q"]);

        let s = fetch(&work).unwrap();
        assert_eq!((s.ahead, s.behind), (1, 1));

        // Reading status must not leave an index lock behind.
        assert!(!work.join(".git/index.lock").exists());
        cleanup(&root);
    }

    #[test]
    fn empty_repo_has_no_commit() {
        let root = tmpdir("empty");
        run(&root, &["init", "-q", "-b", "main"]);
        let s = repo_status(&root);
        assert_eq!(s.error, None);
        assert!(s.last_commit.is_none());
        cleanup(&root);
    }
}

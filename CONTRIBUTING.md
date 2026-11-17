# Contributing to RepoRadar

Thanks for your interest in improving RepoRadar! Bug reports, ideas, docs and code are all welcome.

## Reporting bugs

Open an [issue](https://github.com/mypiroglu/repo-radar/issues) and include:

- Your OS and version (e.g. macOS 15.1, Windows 11, Ubuntu 24.04)
- RepoRadar version
- What you did, what you expected, and what happened
- A screenshot if it's a UI problem

## Development setup

```bash
npm install
npm run tauri dev
```

See the [README](README.md#-build-from-source) for prerequisites.

## Making a change

1. Fork the repository and create a branch: `git checkout -b feat/my-change`
2. Make your change. Keep pull requests focused on one thing.
3. Check that everything builds and the tests pass:
   ```bash
   npm run build
   cd src-tauri && cargo test && cargo clippy
   ```
4. Commit using a clear message, e.g. `feat: group rows by process` or `fix: crash when PID disappears`.
5. Open a pull request describing **what** changed and **why**. Add a screenshot for UI changes.

## Code guidelines

- **Rust:** all git and file-system access lives in `src-tauri/src/git.rs`. Keep Tauri commands in `lib.rs` thin.
  Add a test in `git.rs` for new behaviour where possible. Run `cargo fmt`.
- **Frontend:** filter and sort logic belongs in `src/repo.ts`; keep `App.tsx` focused on UI.
- **Read-only:** RepoRadar must never modify a repository. Read commands must keep `GIT_OPTIONAL_LOCKS=0`.
- **No network calls** other than `git fetch` to the user's own remotes.

## Good first issues

Issues labelled `good first issue` are small and well-scoped. Comment on one to claim it.

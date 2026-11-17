import { invoke } from "@tauri-apps/api/core";

export interface CommitInfo {
  hash: string;
  summary: string;
  author: string;
  /** Unix seconds */
  timestamp: number;
}

export interface RepoStatus {
  path: string;
  name: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  stashes: number;
  lastCommit: CommitInfo | null;
  remoteUrl: string | null;
  webUrl: string | null;
  error: string | null;
}

export const gitAvailable = () => invoke<boolean>("git_available");
export const defaultRoots = () => invoke<string[]>("default_roots");
export const scan = (roots: string[], maxDepth: number) => invoke<RepoStatus[]>("scan", { roots, maxDepth });
export const refreshRepo = (path: string) => invoke<RepoStatus>("refresh_repo", { path });
export const fetchRepo = (path: string) => invoke<RepoStatus>("fetch_repo", { path });

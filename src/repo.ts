import type { RepoStatus } from "./api";

export type Filter = "all" | "attention" | "uncommitted" | "unpushed" | "behind" | "noremote" | "clean";
export type SortKey = "attention" | "name" | "recent";

export const isDirty = (r: RepoStatus) => r.staged + r.modified + r.untracked + r.conflicted > 0;
/** Has commits that exist only locally. */
export const isUnpushed = (r: RepoStatus) => r.ahead > 0 || (r.branch != null && r.upstream == null && r.remoteUrl != null && r.lastCommit != null);
export const isBehind = (r: RepoStatus) => r.behind > 0;
export const hasNoRemote = (r: RepoStatus) => r.remoteUrl == null && r.error == null;
export const needsAttention = (r: RepoStatus) =>
  r.error != null || isDirty(r) || isUnpushed(r) || isBehind(r) || r.conflicted > 0;
export const isClean = (r: RepoStatus) => !needsAttention(r) && !hasNoRemote(r);

export const FILTERS: { key: Filter; label: string; test: (r: RepoStatus) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "attention", label: "Needs attention", test: needsAttention },
  { key: "uncommitted", label: "Uncommitted", test: isDirty },
  { key: "unpushed", label: "Unpushed", test: isUnpushed },
  { key: "behind", label: "Behind", test: isBehind },
  { key: "noremote", label: "No remote", test: hasNoRemote },
  { key: "clean", label: "Clean", test: isClean },
];

/** Higher = more urgent. Conflicts > unpushed work > uncommitted > behind. */
export function attentionScore(r: RepoStatus): number {
  if (r.error) return 1000;
  return (
    r.conflicted * 100 +
    (isUnpushed(r) ? 50 + r.ahead : 0) +
    (isDirty(r) ? 20 + r.staged + r.modified : 0) +
    (isBehind(r) ? 10 + r.behind : 0) +
    (r.stashes > 0 ? 1 : 0)
  );
}

export function filterAndSort(repos: RepoStatus[], filter: Filter, query: string, sort: SortKey): RepoStatus[] {
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const q = query.trim().toLowerCase();
  const byName = (a: RepoStatus, b: RepoStatus) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return repos
    .filter(test)
    .filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        (r.branch ?? "").toLowerCase().includes(q) ||
        (r.remoteUrl ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => {
      if (sort === "name") return byName(a, b);
      if (sort === "recent") return (b.lastCommit?.timestamp ?? 0) - (a.lastCommit?.timestamp ?? 0) || byName(a, b);
      return attentionScore(b) - attentionScore(a) || byName(a, b);
    });
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const diff = unixSeconds - now / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "just now";
}

/** Replace the home directory with "~" for display. */
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~").replace(/^C:\\Users\\[^\\]+/i, "~");
}

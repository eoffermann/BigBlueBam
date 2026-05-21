// Checks GitHub API for latest commit on stable branch.
// Cached — refreshes every 6 hours. No git binary needed.

const GITHUB_REPO = 'eoffermann/BigBlueBam';
const GITHUB_BRANCH = 'stable';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

let cache: { sha: string; date: string; message: string } | null = null;
let lastCheck = 0;

async function fetchLatestRemoteCommit() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'BigBlueBam-VersionCheck' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sha: string;
      commit: { committer: { date: string }; message: string };
    };
    return { sha: data.sha, date: data.commit.committer.date, message: data.commit.message.split('\n')[0] ?? '' };
  } catch {
    return null;
  }
}

export async function getVersionInfo() {
  const currentCommit = process.env.GIT_COMMIT || 'unknown';
  const buildDate = process.env.BUILD_DATE || 'unknown';

  // Refresh cache if stale
  if (Date.now() - lastCheck > CHECK_INTERVAL) {
    cache = await fetchLatestRemoteCommit();
    lastCheck = Date.now();
  }

  const updateAvailable = cache != null && currentCommit !== 'unknown' && cache.sha !== currentCommit;

  return {
    current_commit: currentCommit,
    current_commit_short: currentCommit === 'unknown' ? 'unknown' : currentCommit.slice(0, 8),
    build_date: buildDate,
    latest_remote_commit: cache?.sha ?? null,
    latest_remote_commit_short: cache?.sha?.slice(0, 8) ?? null,
    latest_remote_date: cache?.date ?? null,
    latest_commit_message: cache?.message ?? null,
    update_available: updateAvailable,
    checked_at: lastCheck > 0 ? new Date(lastCheck).toISOString() : null,
  };
}

// Allow manual refresh (for SuperUser "check now" button)
export async function forceVersionCheck() {
  lastCheck = 0;
  return getVersionInfo();
}

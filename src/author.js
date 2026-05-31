import { execFileSync } from 'node:child_process';

/**
 * Resolve a default author identity, degrading gracefully (FR-033):
 *   git config user.name  ->  $USER / $USERNAME  ->  "unknown"
 * The UI can override the value; this is only the starting default.
 * @param {string} [cwd] directory in which to consult git config
 * @returns {string}
 */
export function resolveAuthor(cwd = process.cwd()) {
  const fromGit = tryGitUserName(cwd);
  if (fromGit) return fromGit;

  const fromEnv = process.env.USER || process.env.USERNAME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  return 'unknown';
}

function tryGitUserName(cwd) {
  try {
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const name = out.trim();
    return name || null;
  } catch {
    return null; // git missing or no config — fall through (FR-033)
  }
}

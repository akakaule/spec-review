import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractTitle } from './render.js';
import { sidecarPathFor, isSidecarPath, specNameForSidecar } from './store.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build']);

/**
 * Translate a simple glob (`**`, `*`, `?`) into an anchored RegExp matched
 * against POSIX-style relative paths.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** — any number of path segments
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

async function walk(root) {
  /** @type {string[]} */
  const files = [];
  async function recurse(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await recurse(root);
  return files;
}

function toPosixRel(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

/**
 * Discover specs (glob-matched markdown) and review sidecars under `targetDir`.
 * Pairs each sidecar to its spec; sidecars with no matching spec are reported
 * as orphaned (FR-006/FR-061a). Only glob-matched specs and `*.review.json`
 * sidecars are ever read (FR-061).
 *
 * @param {string} targetDir absolute target folder
 * @param {string} glob discovery glob (default `**\/spec.md`)
 * @returns {Promise<{ specs: Array, orphanSidecars: Array }>}
 */
export async function discover(targetDir, glob = '**/spec.md') {
  const re = globToRegExp(glob);
  const allFiles = await walk(targetDir);

  const specFiles = [];
  const sidecarFiles = new Set();
  for (const full of allFiles) {
    const rel = toPosixRel(targetDir, full);
    if (isSidecarPath(full)) {
      sidecarFiles.add(full);
    } else if (re.test(rel)) {
      specFiles.push(full);
    }
  }

  const pairedSidecars = new Set();
  const specs = [];
  for (const full of specFiles.sort()) {
    const rel = toPosixRel(targetDir, full);
    const sidecar = sidecarPathFor(full);
    const hasSidecar = sidecarFiles.has(sidecar);
    if (hasSidecar) pairedSidecars.add(sidecar);
    let title = null;
    try {
      title = extractTitle(await fs.readFile(full, 'utf8'));
    } catch {
      title = null;
    }
    const summary = hasSidecar ? await readSidecarSummary(sidecar) : { openCount: 0, commentCount: 0 };
    specs.push({
      path: rel,
      absPath: full,
      title: title || rel,
      sidecarPath: sidecar,
      hasSidecar,
      commentCount: summary.commentCount,
      openCount: summary.openCount,
    });
  }

  const orphanSidecars = [];
  for (const sc of sidecarFiles) {
    if (pairedSidecars.has(sc)) continue;
    orphanSidecars.push({
      path: toPosixRel(targetDir, sc),
      absPath: sc,
      expectedSpec: specNameForSidecar(sc),
    });
  }

  return {
    specs,
    orphanSidecars: orphanSidecars.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function readSidecarSummary(sidecar) {
  try {
    const raw = await fs.readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw);
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    return {
      commentCount: comments.length,
      openCount: comments.filter((c) => c && c.status === 'open').length,
    };
  } catch {
    return { commentCount: 0, openCount: 0 };
  }
}

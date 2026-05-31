import path from 'node:path';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';

import { createServer } from './server.js';
import { mintToken } from './security.js';
import { resolveAuthor } from './author.js';

const HELP = `spec-review — review markdown specs with anchored, agent-applyable comments

Usage:
  spec-review [path] [options]

Arguments:
  path                 Folder to scan for specs. Defaults to ./docs/specs if it
                       exists, otherwise the current directory.

Options:
  --port <n>           Port to listen on (default: an open port, reported on start)
  --glob <pattern>     Discovery glob, relative to path (default: **/spec.md)
  --no-open            Do not auto-launch the browser
  --read-only          Render specs but disallow writing comments
  -h, --help           Show this help

The server binds to 127.0.0.1 only and mints a per-run token embedded in the
URL it opens. Comments persist to <name>.review.json next to each spec.`;

/** Parse argv (after `node script`) into an options object. */
export function parseArgs(argv) {
  const opts = { path: null, port: 0, glob: '**/spec.md', open: true, readOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--read-only':
        opts.readOnly = true;
        break;
      case '--port':
        opts.port = Number(argv[++i]);
        if (!Number.isInteger(opts.port) || opts.port < 0) throw new Error('--port must be a non-negative integer');
        break;
      case '--glob':
        opts.glob = argv[++i];
        if (!opts.glob) throw new Error('--glob requires a pattern');
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        if (opts.path === null) opts.path = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
  }
  return opts;
}

/** Resolve the target folder per FR-002. */
export function resolveTarget(argPath, cwd = process.cwd()) {
  if (argPath) return path.resolve(cwd, argPath);
  const defaultDocs = path.join(cwd, 'docs', 'specs');
  if (fsSync.existsSync(defaultDocs) && fsSync.statSync(defaultDocs).isDirectory()) return defaultDocs;
  return cwd;
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

/** Run the CLI. Returns a handle with a close() for tests. */
export async function run(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(HELP);
    return null;
  }

  const targetDir = resolveTarget(opts.path, cwd);
  if (!fsSync.existsSync(targetDir)) {
    throw new Error(`target folder does not exist: ${targetDir}`);
  }

  const token = mintToken();
  const author = resolveAuthor(targetDir);
  const server = createServer({
    targetDir,
    glob: opts.glob,
    token,
    readOnly: opts.readOnly,
    author,
    port: opts.port,
  });

  const port = await server.start(opts.port);
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  log(`spec-review serving ${targetDir}`);
  log(`  glob:      ${opts.glob}`);
  log(`  mode:      ${opts.readOnly ? 'read-only' : 'read-write'}`);
  log(`  url:       ${url}`);

  if (opts.open) openBrowser(url);

  return { server, url, port, token, targetDir };
}

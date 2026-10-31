import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';

export const now = () => Date.now();

/** The project is the enclosing git root, so memories follow the repo, not the shell's cwd. */
const rootCache = new Map();
export function projectRoot(cwd = process.cwd()) {
  const start = resolve(cwd);
  if (rootCache.has(start)) return rootCache.get(start);
  let dir = start;
  for (;;) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      dir = mainWorktree(git) || dir;
      break;
    }
    const up = dirname(dir);
    if (up === dir) {
      dir = start;
      break;
    }
    dir = up;
  }
  rootCache.set(start, dir);
  return dir;
}

// A linked worktree has a .git file pointing into the main repo's .git/worktrees/<name>.
// Memories belong to the repository, so every worktree shares the main checkout's key.
function mainWorktree(git) {
  try {
    if (statSync(git).isDirectory()) return null;
    const m = readFileSync(git, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gitdir = resolve(dirname(git), m[1]);
    const i = gitdir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/');
    return i === -1 ? null : gitdir.slice(0, i);
  } catch {
    return null;
  }
}

export function fileStat(path) {
  try {
    const st = statSync(path);
    return { mtime: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}

export const projectName = (root) => basename(root) || root;

export function relPath(root, path) {
  if (!path) return path;
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  // Forward slashes everywhere, so memories and exports match across operating systems.
  return rel.startsWith('..') ? abs : rel.split(sep).join('/');
}

export function hashFile(path) {
  try {
    if (statSync(path).size > 5_000_000) return null;
    return createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Rough token estimate (characters / 4); close enough to keep injected context inside a budget. */
export const tokens = (s) => Math.ceil((s || '').length / 4);

export function clip(s, max) {
  if (!s) return '';
  s = String(s);
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export function oneLine(s, max = 160) {
  return clip(String(s || '').replace(/\s+/g, ' ').trim(), max);
}

export function ago(ts, at = Date.now()) {
  const s = Math.max(0, Math.round((at - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(data));
  });
}

export function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

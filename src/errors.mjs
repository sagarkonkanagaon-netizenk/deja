// Turn noisy failure output into a stable signature, so the same bug matches
// across runs, machines and weeks even though paths, line numbers and ids differ.
import { sha } from './util.mjs';

const SIGNAL = /\b(error|exception|failed|failure|fatal|cannot|can't|could not|couldn't|not found|no such|undefined|unresolved|refused|denied|invalid|missing|unexpected|traceback|panic|segmentation|timed? ?out|conflict|mismatch|analysisexception|py4j)\b/i;
const NOISE = /^\s*(at |\.\.\.|\^+$|~+$|File "|-->|\d+ \||│|npm ERR! (A complete log|Log files)|in <module>|Exit code \d+$)/;

export function normalizeLine(line) {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g, (p) => '<path>/' + p.split(/[\\/]/).filter(Boolean).pop())
    .replace(/:\d+(:\d+)?\b/g, ':N')
    .replace(/\b(line|col|column|port|pid|attempt|stage|task|partition) \d+/gi, '$1 N')
    .replace(/\b\d{3,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// The lines that carry meaning: the ones mentioning an error, preferring the last
// (Python and the JVM put the real cause at the bottom of the trace).
export function keyLines(error, max = 2) {
  const lines = String(error || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  const hits = lines.filter((l) => SIGNAL.test(l));
  const pick = hits.length ? hits : lines;
  const seen = new Set();
  const out = [];
  for (let i = pick.length - 1; i >= 0 && out.length < max; i--) {
    const n = normalizeLine(pick[i]);
    if (n.length < 4 || seen.has(n)) continue;
    seen.add(n);
    out.unshift(n);
  }
  return out;
}

export function errorSignature(error) {
  const lines = keyLines(error);
  if (!lines.length) return null;
  return { signature: sha(lines.join('\n')), text: lines.join('\n') };
}

const WRAPPERS = new Set(['sudo', 'npx', 'bunx', 'pnpx', 'uv', 'poetry', 'pipenv', 'time', 'env', 'nohup', 'exec']);
const SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'git', 'docker', 'kubectl', 'make', 'python', 'python3', 'dbt', 'airflow', 'terraform', 'gradle', 'mvn', 'sbt', 'pip', 'spark-submit', 'databricks', 'dotnet', 'mix', 'bundle', 'rails', 'php', 'composer']);

// "npm run test -- --watch" and "npm run test" are the same family; so are
// "pytest tests/a.py -k x" and "pytest tests/b.py". A fix is the next success in the family.
export function commandFamily(command) {
  const first = String(command || '')
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(cd|export|source|\.)\s/.test(s))[0] || '';
  const words = first
    .split(/\s+/)
    .filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
  while (words.length > 1 && WRAPPERS.has(words[0])) {
    words.shift();
    if (words[0] === 'run' || words[0] === 'exec') words.shift();
  }
  if (!words.length) return '';
  const head = words[0].split('/').pop();
  if (!SUBCOMMANDS.has(head)) return head;
  const sub = words.slice(1).filter((w) => !w.startsWith('-'));
  if (head.startsWith('python') && words[1] === '-m') return `${head} -m ${words[2] || ''}`.trim();
  if (sub[0] === 'run' && sub[1] && /^(npm|pnpm|yarn|bun)$/.test(head)) return `${head} run ${sub[1]}`;
  return sub[0] ? `${head} ${sub[0]}` : head;
}

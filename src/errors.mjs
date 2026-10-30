// Turn noisy failure output into a stable signature, so the same bug matches
// across runs, machines and weeks even though paths, line numbers and ids differ.
import { sha } from './util.mjs';

const SIGNAL = /\w(Error|Exception|Failure)\b|\b(error|exception|failed|failure|fatal|cannot|can't|could not|couldn't|not found|no such|undefined|unresolved|refused|denied|invalid|missing|unexpected|panic|segmentation|timed? ?out|conflict|mismatch|assert\w*|py4j)\b|^\s*[●✕×✗]\s|^\s*(FAILED|--- FAIL:|FAIL:?)\s|\bexpected\b.*\b(got|received|but was|actual)\b/i;
const NOISE = /^\s*(at |\.\.\.|\^+$|~+$|File "|-->|\d+ \||in <module>)/;

// Lines every failure of a tool prints, whatever went wrong. Matching on them would
// make every failing test run look like the same bug.
const GENERIC = [
  /^(tests?|test suites?|test files?|suites?|snapshots?)\s*:/i,
  /^(tests?|test files?|suites?)\s+\d+ (failed|passed)/i,
  /^\d+ examples?, \d+ failures?/i,
  /^✖ \d+ problems? \(/,
  /\b\d+ (failed|failing|errors?)\b.*\b\d+ (passed|passing|total|skipped)\b/i,
  /^=+ .*\b(failed|errors?|passed)\b.* =+$/i,
  /^(\d+ (failed|failing|errors?)[,\s]*)+(in [\d.]+m?s)?$/i,
  /^npm (ERR!|error)\s+(code|errno|syscall|path|command|Lifecycle|Test failed|A complete log|Failed at|This is probably|Exit status|\S+@\S+ \w+:)/i,
  /\bELIFECYCLE\b|^error Command failed with exit code|^error: script .* (exited|failed)|^ERROR: .*exited with code/i,
  /^(FAILURE: Build failed|BUILD FAIL(ED|URE)|\[ERROR\] (BUILD FAILURE|Failed to execute goal|-> \[Help|Re-run Maven|To see the full stack|For more information))/i,
  /^make(\[\d+\])?: \*\*\*/,
  /^error: (could not compile|aborting due to)|^warning: build failed/i,
  /^Found \d+ errors?\b/i,
  /^(Exit code \d+|Process completed with exit code|Command exited with|The command .* exited with)/i,
  /^Traceback \(most recent call last\)|^During handling of the above exception|^The above exception was the direct cause/i,
  /^(FAIL|FAILED)$|^(error|Error|ERROR):?$/,
  /^ERROR: (Job failed|process completed)/i,
];
const generic = (l) => GENERIC.some((re) => re.test(l));

export function normalizeLine(line) {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m)\b/g, '<dur>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g, (p) => '<path>/' + p.split(/[\\/]/).filter(Boolean).pop())
    .replace(/:\d+(:\d+)?\b/g, ':N')
    .replace(/\(\d+,\s*\d+\)/g, '(N,N)')
    .replace(/\[\d+,\s*\d+\]/g, '[N,N]')
    .replace(/^\d+:\d+\b/, 'N:N')
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
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[│┃|]\s?/, '').trim())
    .filter((l) => l && !NOISE.test(l) && !generic(l));
  const pick = lines.filter((l) => SIGNAL.test(l));
  if (!pick.length) return [];
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

// Checks a commit header or pull request title against docs/STANDARDS.md §9
// (Conventional Commits, 50-character target, 72-character limit).
// Usage: node scripts/check-commit.mjs "<header>"   (CI passes the PR title)
import { pathToFileURL } from 'node:url';

const TYPES = ['feat', 'fix', 'perf', 'docs', 'test', 'refactor', 'build', 'ci', 'chore', 'revert'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: (.+)$`);

/** Problems with a commit header; an empty list means it follows the standard. */
export function commitProblems(header) {
  const problems = [];
  const m = header.match(HEADER);
  if (!m) return [`must look like "<type>(<scope>): <summary>" with type one of ${TYPES.join(', ')}`];
  const summary = m[3];
  if (header.length > 72) problems.push(`is ${header.length} characters; the limit is 72 (aim for 50)`);
  if (/^[A-Z][a-z]/.test(summary)) problems.push('summary should start in lower case');
  if (/\.$/.test(summary)) problems.push('summary should not end with a period');
  if (/^(added|adds|fixed|fixes|updated|updates|removed|removes|changed|changes)\b/i.test(summary)) problems.push('summary should use the imperative ("add", not "added" or "adds")');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const header = (process.argv[2] || '').split('\n')[0].trim();
  const problems = commitProblems(header);
  if (problems.length) {
    console.error(`"${header}"\n${problems.map((p) => '  ✘ ' + p).join('\n')}\nSee docs/STANDARDS.md, section 9.`);
    process.exit(1);
  }
  console.log(`"${header}" follows the commit standard${header.length > 50 ? ` (${header.length} characters; 50 or fewer reads best)` : ''}`);
}

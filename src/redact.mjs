// Secret redaction. Everything is redacted before it is written to disk: nothing
// leaves the machine, but a database full of credentials would still be a liability.

/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[api key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[api key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, '[github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[github token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[slack token]'],
  [/\bdapi[0-9a-f]{32}(?:-\d)?\b/g, '[databricks token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [token]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1[password]@'],
  [/\b((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[redacted]'],
];

export function redact(text) {
  if (!text) return '';
  let out = String(text).replace(/<private>[\s\S]*?<\/private>/gi, '[private]');
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}

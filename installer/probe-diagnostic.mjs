const DETAIL_LIMIT_BYTES = 1_024;
const EMBEDDED_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const AMBIGUOUS_WHITESPACE = /[^\S\u0020]/u;
const AMBIGUOUS_URL_PUNCTUATION = /["'`<>]/u;
const URL_START = /https?:\/\//giu;

const urlCandidateEnd = (value, start) => {
  let index = start;
  while (index < value.length && !/\s/u.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
};

function sanitizeUrlCandidate(candidate) {
  const separator = candidate.indexOf('//') + 2;
  const scheme = candidate.slice(0, separator);
  const authorityStart = separator;
  let authorityEnd = candidate.length;
  for (let index = authorityStart; index < candidate.length; index += 1) {
    if ('/?#'.includes(candidate[index] ?? '')) {
      authorityEnd = index;
      break;
    }
  }

  const authority = candidate.slice(authorityStart, authorityEnd);
  const credentialSeparator = authority.lastIndexOf('@');
  const host = credentialSeparator < 0 ? authority : authority.slice(credentialSeparator + 1);
  if (host === '') {
    return undefined;
  }

  const tail = candidate.slice(authorityEnd);
  let parsed;
  try {
    parsed = new URL(`${scheme}${host}${tail}`);
  } catch {
    return undefined;
  }
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }

  const safeAuthority = credentialSeparator < 0 ? authority : `[redacted]@${host}`;
  const pathEnd = tail.search(/[?#]/u);
  const path = pathEnd < 0 ? tail : tail.slice(0, pathEnd);
  return `${scheme}${safeAuthority}${path}`;
}

function redactUrls(value) {
  let result = '';
  let cursor = 0;
  URL_START.lastIndex = 0;
  for (let match = URL_START.exec(value); match !== null; match = URL_START.exec(value)) {
    const start = match.index;
    const end = urlCandidateEnd(value, URL_START.lastIndex);
    const candidate = value.slice(start, end);
    if (AMBIGUOUS_URL_PUNCTUATION.test(candidate)) {
      return undefined;
    }
    const safeCandidate = sanitizeUrlCandidate(candidate);
    if (safeCandidate === undefined) {
      return undefined;
    }
    result += value.slice(cursor, start) + safeCandidate;
    cursor = end;
    URL_START.lastIndex = end;
  }
  return result + value.slice(cursor);
}

export function sanitizeProbeDiagnostic(value) {
  const source = String(value ?? '').replace(/[\r\n]+$/u, '');
  if (EMBEDDED_CONTROL.test(source)) {
    return '[probe detail omitted: embedded control]';
  }
  if (AMBIGUOUS_WHITESPACE.test(source)) {
    return '[probe detail omitted: ambiguous whitespace]';
  }

  const urlsRedacted = redactUrls(source);
  if (urlsRedacted === undefined) {
    return '[probe detail omitted: ambiguous URL authority]';
  }

  const redacted = urlsRedacted
    .replace(/\b(Bearer|Basic)\s+\S+/giu, '$1 [redacted]')
    .replace(/\b(_authToken|password|token)\s*[:=]\s*[^&#\s]*/giu, '$1=[redacted]');
  return Buffer.byteLength(redacted, 'utf8') > DETAIL_LIMIT_BYTES
    ? '[probe detail omitted: size limit exceeded]'
    : redacted;
}

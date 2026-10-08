const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 4;
const URL_CREDENTIALS = /\b([a-z][a-z\d+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#@]+@/giu;
const PASSWORD_ASSIGNMENT = /(password["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/giu;

const secrets = new Set<string>();

export function protectDatabaseUrl(databaseUrl: string): void {
  let password: string;
  try {
    password = new URL(databaseUrl).password;
  } catch {
    return;
  }
  for (const form of [password, decoded(password), encodeURIComponent(decoded(password))]) {
    if (form.length >= MIN_SECRET_LENGTH) {
      secrets.add(form);
    }
  }
}

export function redactLog(text: string): string {
  let redacted = text;
  for (const secret of [...secrets].toSorted((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted
    .replaceAll(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replaceAll(PASSWORD_ASSIGNMENT, `$1${REDACTED}`);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

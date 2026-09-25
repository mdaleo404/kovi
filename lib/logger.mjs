function cleanValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(cleanValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|authorization|code$/i.test(key)) continue;
      const cleaned = cleanValue(item);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return String(value).slice(0, 500);
}

export function logEvent(level, event, message, fields = {}) {
  const normalized = String(level || 'info').toLowerCase();
  const meta = cleanValue(fields) || {};
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${new Date().toISOString()}] [kovi] ${normalized.toUpperCase()} ${event} — ${message}${suffix}`;
  if (normalized === 'error') console.error(line);
  else if (normalized === 'warn' || normalized === 'warning') console.warn(line);
  else console.log(line);
}

export const info = (event, message, fields) => logEvent('info', event, message, fields);
export const warn = (event, message, fields) => logEvent('warn', event, message, fields);
export const error = (event, message, fields) => logEvent('error', event, message, fields);

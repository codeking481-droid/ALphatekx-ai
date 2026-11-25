export function log(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  write(JSON.stringify(entry))
}

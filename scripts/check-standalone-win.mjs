// Shared acceptance flow tests every shipped converter and Nginx on Windows x64.
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows standalone acceptance must run on Windows x64')
}
await import('./check-standalone-mac.mjs')

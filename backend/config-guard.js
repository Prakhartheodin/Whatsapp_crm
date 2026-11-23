// Imported FIRST by every entry point (index.js, scripts). config.js throws at import on a malformed
// variable; ESM reports that as an uncaught exception, which this turns into one fatal log line
// (pino's JSON shape) instead of a stack trace. Entry points call configLoaded() once imports are done.
function onError(err) {
  if (err?.configError) {
    process.stdout.write(JSON.stringify({ level: 60, time: Date.now(), msg: `${err.message}. See .env.example.` }) + '\n')
  } else {
    console.error(err)
  }
  process.exit(1)
}
process.on('uncaughtException', onError)

export const configLoaded = () => process.off('uncaughtException', onError)

/** Purges raw_messages older than RETENTION_DAYS (0 = keep forever). Bookings are not touched. */
export function createRetention({ RawMessage, config, now = () => new Date(), logger }) {
  const days = config.retentionDays
  let timer

  async function run() {
    if (!days) return 0
    const cutoff = new Date(now().getTime() - days * 86_400_000)
    const { deletedCount } = await RawMessage.deleteMany({ timestamp: { $lt: cutoff } })
    logger.info({ deleted: deletedCount, retentionDays: days }, 'retention purge done')
    return deletedCount
  }
  const runLogged = () => run().catch((err) => logger.error({ err }, 'retention purge failed'))

  return {
    run,
    start() {
      if (!days) return
      runLogged()
      clearInterval(timer)
      timer = setInterval(runLogged, 86_400_000)
      timer.unref()
    },
    stop: () => clearInterval(timer),
  }
}

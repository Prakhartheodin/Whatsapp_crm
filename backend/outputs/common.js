const IST_MS = 5.5 * 3600_000

/** Date (or ISO string) -> "YYYY-MM-DD HH:mm" in IST; '' when missing or invalid. */
export function ist(d) {
  const t = d ? new Date(d).getTime() : NaN
  return Number.isNaN(t) ? '' : new Date(t + IST_MS).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * One HTTPS call: 10 s timeout, one retry on 429 (honours retry_after, max 30 s) or 5xx. Never
 * retried after a network error/timeout: the first try may have landed (the caller decides).
 * Returns { ok, body, status, unknown }: ok with the parsed JSON body; on failure status is the
 * HTTP status (the server answered, so nothing was done) or unknown is true (network error or
 * timeout: the request may have landed). Never throws. Logs never contain the URL, headers or
 * request body (they carry the bot token / access token).
 */
export async function call(fetch, url, init, { logger, sleep, output }) {
  for (let attempt = 0; ; attempt++) {
    let res, body
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      body = await res.json().catch(() => null)
    } catch (err) {
      // Name and cause code only: some fetch errors quote the URL.
      logger.error({ output, error: err.name, code: err.cause?.code }, 'output request failed (outcome unknown)')
      return { ok: false, unknown: true }
    }
    if (res.ok) return { ok: true, body: body ?? {} }
    const retry = attempt === 0 && (res.status === 429 || res.status >= 500)
    const description = body?.description ?? body?.error_description ?? body?.error?.message ?? body?.error
    logger[retry ? 'warn' : 'error']({ output, status: res.status, description }, retry ? 'output request failed; retrying once' : 'output request failed')
    if (!retry) return { ok: false, status: res.status }
    const wait = Number(body?.parameters?.retry_after ?? res.headers.get('retry-after'))
    await sleep(Math.min(wait > 0 ? wait : 1, 30) * 1000)
  }
}

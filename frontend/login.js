const form = document.getElementById('login-form')
const error = document.getElementById('login-error')
const button = form.querySelector('button')

// Only return to one of our own tabs; never follow an arbitrary `next`.
const next = new URLSearchParams(location.search).get('next') || ''
const target = /^#(review|raw|status|export)?$/.test(next) ? `/${next}` : '/'

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = form.username.value.trim()
  const password = form.password.value
  if (!username || !password) {
    error.textContent = 'Enter your username and password.'
    return
  }
  button.disabled = true
  error.textContent = ''
  try {
    const res = await fetch('/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (res.ok) {
      // A Secure cookie over plain HTTP is dropped silently: check the session actually stuck.
      const me = await fetch('/api/me', { credentials: 'same-origin' })
      if (me.ok) return location.assign(target)
      error.textContent = 'Login worked, but the browser did not keep the session cookie. Open the dashboard over HTTPS.'
      button.disabled = false
      return
    }
    const data = await res.json().catch(() => ({}))
    if (res.status === 429) {
      const min = Math.max(1, Math.ceil((data.retryAfterSec || 60) / 60))
      error.textContent = `Too many attempts, try again in ${min} minute${min === 1 ? '' : 's'}`
    } else if (res.status === 401) {
      error.textContent = 'Wrong username or password'
      form.password.select()
    } else {
      error.textContent = data.error || "Couldn't log in. Try again."
    }
  } catch {
    error.textContent = "Couldn't reach the server. Check your connection and try again."
  }
  button.disabled = false
})

// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'booking-collector',
      script: 'backend/index.js',
      cwd: __dirname, // .env and ./auth resolve from here, wherever pm2 is started
      // Exactly one process: a second one would open a second WhatsApp socket on the same session.
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production' },
      exp_backoff_restart_delay: 1000, // 1 s, doubling up to pm2's 15 s cap, reset after a stable run
      max_restarts: 50,
      kill_timeout: 10_000, // time for graceful shutdown (close HTTP, disconnect MongoDB)
      time: true,
    },
  ],
}

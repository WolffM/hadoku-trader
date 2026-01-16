/**
 * PM2 Ecosystem Configuration for Trader Worker
 *
 * Start with: pm2 start ecosystem.config.js
 * View logs: pm2 logs trader-worker
 * Restart: pm2 restart trader-worker
 */

module.exports = {
  apps: [
    {
      name: "trader-worker",
      script: "uvicorn",
      args: "main:app --host 127.0.0.1 --port 8765",
      cwd: __dirname,
      interpreter: "python",
      interpreter_args: "-m",
      env: {
        // These should be set in your environment or .env file
        TRADER_WORKER_PORT: 8765,
        // FIDELITY_USERNAME: "your_username",
        // FIDELITY_PASSWORD: "your_password",
        // FIDELITY_TOTP_SECRET: "your_totp_secret",
        // FIDELITY_DEFAULT_ACCOUNT: "X12345678",
        // TRADER_API_SECRET: "your_api_secret",
      },
      // Restart settings
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/trader-worker-error.log",
      out_file: "./logs/trader-worker-out.log",
      merge_logs: true,
    },
  ],
};

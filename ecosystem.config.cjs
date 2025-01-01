module.exports = {
  apps: [
    {
      name: "hazardous-db-bot",
      script: "src/index.js",
      interpreter: "bun",
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
      },
      health_check: {
        url: "http://localhost:3000/health",
        interval: 10000, // Check every 10 seconds
        timeout: 5000, // Wait up to 5 seconds for response
      },
    },
  ],
};

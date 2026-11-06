/**
 * ecosystem.config.js — Configuración PM2 de Wsp-CrmBot
 * Esta instancia maneja únicamente el bot CRM (keywords + TF-IDF + Naive Bayes).
 * 
 * VPS: pm2 start /var/www/wsp-crmbot/ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: 'wsp-crmbot',
      script: 'src/app.js',
      cwd: '/var/www/wsp-crmbot',
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 60000,       // 60s entre reinicios (evita loop de crashes)
      max_memory_restart: '400M', // Matar si supera 400MB (Chrome zombie)
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
        WSP_INSTANCIA: 'wsp-crmbot',
        API_BASE_URL: 'https://proxy.batidospitaya.com',
        // Stagger: wsp-crmbot arranca Chrome segundo (90s tras PM2 start)
        STARTUP_DELAY_MS: '90000'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};

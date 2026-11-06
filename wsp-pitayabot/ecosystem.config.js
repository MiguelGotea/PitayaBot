/**
 * ecosystem.config.js — Configuración PM2 de wsp-pitayabot
 * Asistente virtual por WhatsApp para colaboradores de Batidos Pitaya.
 *
 * Primer deploy en VPS:
 *   cd /var/www/wsp-pitayabot
 *   npm install --production
 *   cp .env.example .env && nano .env
 *   sudo ufw allow 3007/tcp
 *   pm2 start ecosystem.config.js
 *   pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'wsp-pitayabot',
      script: 'src/app.js',
      cwd: '/var/www/wsp-pitayabot',
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 60000,       // 60s entre reinicios (evita loop de crashes)
      max_memory_restart: '400M', // Matar si supera 400MB (Chrome zombie)
      env: {
        NODE_ENV: 'production',
        PORT: 3007,
        WSP_INSTANCIA: 'wsp-pitayabot',
        API_BASE_URL: 'https://proxy.batidospitaya.com',
        // Stagger: wsp-pitayabot arranca Chrome primero (5s tras PM2 start)
        STARTUP_DELAY_MS: '5000'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};

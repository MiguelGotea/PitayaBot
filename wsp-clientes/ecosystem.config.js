/**
 * ecosystem.config.js — Configuración PM2 de Wsp-Clientes
 * Esta instancia maneja únicamente las campañas de marketing.
 * 
 * VPS: pm2 start /var/www/wsp-clientes/ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: 'wsp-clientes',
      script: 'src/app.js',
      cwd: '/var/www/wsp-clientes',
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 60000,       // 60s entre reinicios (evita loop de crashes)
      max_memory_restart: '400M', // Matar si supera 400MB (Chrome zombie)
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        WSP_INSTANCIA: 'wsp-clientes',
        API_BASE_URL: 'https://proxy.batidospitaya.com',
        // Stagger: wsp-clientes arranca Chrome último (3 min tras PM2 start)
        // Evita que 3 Chrome compitan por CPU/RAM al mismo tiempo
        STARTUP_DELAY_MS: '180000'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};

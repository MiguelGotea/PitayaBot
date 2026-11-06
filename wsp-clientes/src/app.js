'use strict';

require('dotenv').config();
const express = require('express');
const { iniciarWhatsApp, obtenerEstado, obtenerQR, reportarEstadoVPS, obtenerEstadoActual, obtenerCliente, resetearSesion, setReadyHook } = require('./whatsapp/client');
const { iniciarWorker } = require('./workers/campaign_worker');
const { iniciarNotificationWorker } = require('./workers/notification_worker');
const { WSP_INSTANCIA } = require('./config/api');

const logApp = (msg) => {
    const pid = process.pid;
    const ut = Math.round(process.uptime());
    console.log(`[APP|PID:${pid}|UT:${ut}s] ${msg}`);
};

// ── Manejo de errores globales ──
process.on('uncaughtException', (err) => {
    logApp(`💥 FATAL UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logApp(`💥 UNHANDLED REJECTION: ${reason}`);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ── Seguridad: token requerido para rutas sensibles ──
const WSP_TOKEN = process.env.WSP_TOKEN || '';
function validarToken(req, res, next) {
    const token = req.headers['x-wsp-token'] || req.query.token;
    if (WSP_TOKEN && token !== WSP_TOKEN) {
        return res.status(403).json({ error: 'Token invalido' });
    }
    next();
}

// ── Rutas internas ──
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        servicio: `pitaya-whatsapp-service (${WSP_INSTANCIA})`,
        hora: new Date().toISOString()
    });
});

app.get('/status', (req, res) => {
    res.json(obtenerEstado());
});

app.get('/qr', (req, res) => {
    const qr = obtenerQR();
    if (!qr) return res.json({ qr: null, mensaje: 'Sin QR disponible o ya conectado' });
    res.json({ qr });
});

// ── Envío manual (CRM humano → cliente) ──
app.post('/send', validarToken, async (req, res) => {
    const numero = req.body.to || req.body.numero;
    const texto = req.body.message || req.body.texto;
    if (!numero || !texto) return res.status(400).json({ error: 'numero/to y texto/message son requeridos' });
    try {
        const cliente = obtenerCliente();
        if (!cliente) return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });
        const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await cliente.sendMessage(chatId, texto);
        res.json({ success: true, numero, chatId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Ping de prueba (ERP → cliente + notificación a grupo) ──
app.post('/ping', validarToken, async (req, res) => {
    const numero = req.body.to || req.body.numero;
    const texto = req.body.message || req.body.texto;
    const agente = req.body.agente || 'Usuario del ERP';

    if (!numero || !texto) return res.status(400).json({ error: 'numero/to y texto/message son requeridos' });

    try {
        const cliente = obtenerCliente();
        if (!cliente) return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });

        const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;

        // 1. Enviar el mensaje de prueba al destinatario real
        await cliente.sendMessage(chatId, texto);

        // 2. Notificar al grupo de monitoreo

        res.json({ success: true, numero, chatId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Reset de sesion (cambiar número) ──
app.post('/reset', validarToken, async (req, res) => {
    try {
        // RESET MANUAL: Borrar carpeta de sesión (borrarSesion = true)
        await resetearSesion(true);
        res.json({ success: true, mensaje: 'Sesion reiniciada, generando QR...' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Arranque: Express PRIMERO, luego WhatsApp en background ──
async function arrancar() {
    logApp(`🚀 Iniciando Pitaya WhatsApp Service [${WSP_INSTANCIA}]...`);

    // 1. Levantar Express inmediatamente
    await new Promise((resolve) => {
        app.listen(PORT, '0.0.0.0', () => {
            logApp(`✅ API interna [${WSP_INSTANCIA}] escuchando en http://0.0.0.0:${PORT}`);
            resolve();
        });
    });

    logApp('⏳ Esperando antes de arrancar WhatsApp para estabilizar sistema...');
    const startupDelay = parseInt(process.env.STARTUP_DELAY_MS || '15000', 10);
    logApp(`⏱️ Delay de arranque: ${startupDelay / 1000}s (configurable via STARTUP_DELAY_MS)`);
    await new Promise(r => setTimeout(r, startupDelay));

    // 2. Vincular workers que dependen de eventos (hook preparado para el futuro)
    setReadyHook((cliente) => {
        // En esta instancia los workers actuales no dependen de eventos
        // pero registramos el hook por consistencia arquitectónica.
    });

    // 3. Iniciar WhatsApp en background
    iniciarWhatsApp()
        .then((clienteWA) => {
            if (!clienteWA) return;
            iniciarWorker();
            iniciarNotificationWorker();
            logApp('📣 Modo Campañas activo');
            logApp('🔔 Modo Notificaciones Transaccionales activo');
        })
        .catch(err => {
            logApp(`❌ Error fatal en flujo de WhatsApp: ${err.message}`);
        });

    // 3. Heartbeat: actualiza ultimo_ping cada 60s
    setInterval(async () => {
        try {
            const estado = obtenerEstadoActual();
            let realWaState = 'N/A';

            // Intento de "despertar" WhatsApp y verificar que el engine no está congelado
            if (estado === 'conectado') {
                const cliente = obtenerCliente();
                if (cliente) {
                    try {
                        // Promise.race para evitar quedarnos colgados si la pestaña murió
                        realWaState = await Promise.race([
                            cliente.getState(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_GET_STATE')), 10000))
                        ]);
                        if (realWaState === 'TIMEOUT' || realWaState === 'UNPAIRED') {
                            logApp(`⚠️  El estado real de WA reportó ${realWaState} — forzando reset_solicitado falso pero es preocupante`);
                        }

                        // Forzar "en línea" para mantener viva la conexión WebSocket de WhatsApp Web
                        try {
                            await cliente.sendPresenceAvailable();
                        } catch (presenceErr) {
                            // Ignorar si falla el presence
                        }

                    } catch (e) {
                        realWaState = `ERROR: ${e.message}`;
                        logApp(`🚨 WhatsApp congelado / Inaccesible -> ${e.message}. Forzando AUTO-RECUPERACIÓN...`);
                        // AUTO-RECUPERACIÓN: NO borrar carpeta de sesión (borrarSesion = false)
                        await resetearSesion(false);
                        return; // Salir de esta iteración
                    }
                }
            }

            const data = await reportarEstadoVPS(estado, null);
            logApp(`💓 Heartbeat [${WSP_INSTANCIA}] — estado: ${estado} | engine: ${realWaState}`);

            if (data && data.reset_solicitado) {
                logApp('🔄 Detectada solicitud de reset en heartbeat — ejecutando...');
                // RESET SOLICITADO: Borrar carpeta de sesión (borrarSesion = true)
                await resetearSesion(true);
            }
        } catch (e) {
            logApp(`⚠️  Heartbeat falló: ${e.message}`);
        }
    }, 60_000);
}

arrancar().catch(err => {
    console.error('❌ Error arrancando el servicio:', err);
    process.exit(1);
});

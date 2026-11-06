'use strict';

require('dotenv').config();
const express = require('express');
const {
    iniciarWhatsApp, obtenerEstado, obtenerQR, reportarEstadoVPS,
    obtenerEstadoActual, obtenerCliente, resetearSesion, setReadyHook
} = require('./whatsapp/client');
const { iniciarPitayaBot } = require('./workers/pitayabot_worker');
const { iniciarScheduler  } = require('./bot/scheduler');
const { WSP_INSTANCIA }     = require('./config/api');

const logApp = (msg) => {
    const pid = process.pid;
    const ut  = Math.round(process.uptime());
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

const app  = express();
const PORT = process.env.PORT || 3007;

app.use(express.json());

// ── Seguridad: token requerido para rutas sensibles ──
const WSP_TOKEN = process.env.WSP_TOKEN || '';
function validarToken(req, res, next) {
    const token = req.headers['x-wsp-token'] || req.query.token;
    if (WSP_TOKEN && token !== WSP_TOKEN) {
        return res.status(403).json({ error: 'Token inválido' });
    }
    next();
}

// ── Rutas internas ──
app.get('/health', (req, res) => {
    res.json({
        status:   'ok',
        servicio: `pitaya-whatsapp-service (${WSP_INSTANCIA})`,
        hora:     new Date().toISOString()
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

// ── Envío manual ──
app.post('/send', validarToken, async (req, res) => {
    const numero = req.body.to || req.body.numero;
    const texto  = req.body.message || req.body.texto;
    if (!numero || !texto) return res.status(400).json({ error: 'numero y texto son requeridos' });
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

// ── Ping de prueba ──
app.post('/ping', validarToken, async (req, res) => {
    const numero = req.body.to || req.body.numero;
    const texto  = req.body.message || req.body.texto;
    const agente = req.body.agente || 'Usuario del ERP';
    if (!numero || !texto) return res.status(400).json({ error: 'numero y texto son requeridos' });
    try {
        const cliente = obtenerCliente();
        if (!cliente) return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });
        const chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await cliente.sendMessage(chatId, texto);
        
        // 2. Notificar al grupo de monitoreo

        res.json({ success: true, numero, chatId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Reset de sesión ──
app.post('/reset', validarToken, async (req, res) => {
    try {
        await resetearSesion(true);
        res.json({ success: true, mensaje: 'Sesión reiniciada, generando QR...' });
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

    // 2. Vincular worker antes de iniciar WhatsApp
    setReadyHook((cliente) => {
        iniciarPitayaBot(cliente);
        iniciarScheduler(cliente);
    });

    // 3. Iniciar WhatsApp en background
    iniciarWhatsApp()
        .then((clienteWA) => {
            if (!clienteWA) return;
            logApp('📣 PitayaBot activo');
        })
        .catch(err => {
            logApp(`❌ Error fatal en flujo de WhatsApp: ${err.message}`);
        });

    // 4. Heartbeat: actualiza ultimo_ping cada 60s + anti-zombie
    let _timeoutConsecutivos = 0; // Contador de TIMEOUT_GET_STATE consecutivos
    const MAX_TIMEOUTS_ANTES_RESET = 3; // Solo reiniciar tras 3 fallos seguidos
    let _inicializandoDesde = null;
    const MAX_INICIALIZANDO_MS = 8 * 60 * 1000; // 8 minutos máximo en 'inicializando'
    setInterval(async () => {
        try {
            const estado = obtenerEstadoActual();
            let realWaState = 'N/A';

            // ── WATCHDOG: Detectar "atascado en inicializando" ──
            if (estado === 'inicializando') {
                if (!_inicializandoDesde) _inicializandoDesde = Date.now();
                const tiempoInicializando = Date.now() - _inicializandoDesde;
                if (tiempoInicializando > MAX_INICIALIZANDO_MS) {
                    logApp(`⌛ WATCHDOG: Lleva ${Math.round(tiempoInicializando / 60000)} min en 'inicializando' — forzando reset...`);
                    _inicializandoDesde = null;
                    _timeoutConsecutivos = 0;
                    await resetearSesion(false);
                    return;
                }
                logApp(`💓 Heartbeat [${WSP_INSTANCIA}] — estado: ${estado} | inicializando hace ${Math.round(tiempoInicializando / 60000)}min`);
                await reportarEstadoVPS(estado, null).catch(() => {});
                return;
            } else {
                _inicializandoDesde = null;
            }

            if (estado === 'conectado') {
                const cliente = obtenerCliente();
                if (cliente) {
                    try {
                        realWaState = await Promise.race([
                            cliente.getState(),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('TIMEOUT_GET_STATE')), 30000))
                        ]);
                        // Éxito: reset contador
                        _timeoutConsecutivos = 0;

                        // Forzar presencia "En línea" anti-zombie
                        try { await cliente.sendPresenceAvailable(); } catch {}

                    } catch (e) {
                        _timeoutConsecutivos++;
                        realWaState = `ERROR: ${e.message}`;
                        logApp(`🚨 WhatsApp inaccesible [${_timeoutConsecutivos}/${MAX_TIMEOUTS_ANTES_RESET}] → ${e.message}`);

                        if (_timeoutConsecutivos >= MAX_TIMEOUTS_ANTES_RESET) {
                            logApp(`🔁 ${MAX_TIMEOUTS_ANTES_RESET} fallos consecutivos — Forzando recuperación...`);
                            _timeoutConsecutivos = 0;
                            await resetearSesion(false);
                            return;
                        }
                        // Aún no al límite: solo loguear, continuar
                    }
                }
            } else {
                _timeoutConsecutivos = 0;
            }

            const data = await reportarEstadoVPS(estado, null);
            logApp(`💓 Heartbeat [${WSP_INSTANCIA}] — ${estado} | engine: ${realWaState}`);

            if (data && data.reset_solicitado) {
                logApp('🔄 Reset solicitado desde ERP — ejecutando...');
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

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Estado interno del cliente
let estadoActual = 'desconectado';
let estaIniciando = false;
let qrBase64 = null;
let clienteWA = null;
let sessionIntentId = 0; // Para cancelar inits obsoletos durante el delay de stagger
let readyHook = null; // Hook para re-vincular workers tras reset
let readyTimeoutHandle = null; // FIX: Timeout de seguridad para cuando 'ready' nunca llega tras autenticarse

const logMsg = (msg) => {
    const pid = process.pid;
    const ut = Math.round(process.uptime());
    console.log(`[PID:${pid}|UT:${ut}s] ${msg}`);
};

/**
 * Inicializa el cliente de whatsapp-web.js con sesión persistente.
 * La sesión se guarda en .wwebjs_auth/ (excluida del repo).
 */
async function iniciarWhatsApp() {
    const currentInitId = ++sessionIntentId;

    if (estaIniciando) {
        logMsg(`⚠️  Ya hay una inicialización en curso... (Intento ID:${currentInitId})`);
        return;
    }
    if (estadoActual === 'conectado' && clienteWA) {
        logMsg('✅ WhatsApp ya está conectado.');
        return;
    }

    logMsg(`📱 [ID:${currentInitId}] Iniciando cliente WhatsApp Web...`);
    estaIniciando = true;
    estadoActual = 'inicializando';
    await reportarEstadoVPS('inicializando', null);

    // Detectar ejecutable de Chromium/Chrome disponible
    const fs = require('fs');
    const path = require('path');

    const chromiumPaths = [
        '/usr/bin/google-chrome-stable',    // Chrome estable (preferido)
        '/usr/bin/google-chrome',           // Chrome genérico
        '/usr/bin/chromium',                // apt en Ubuntu sin snap
    ];
    const executablePath = chromiumPaths.find(p => fs.existsSync(p));
    if (!executablePath) {
        logMsg('❌ No se encontró Chromium/Chrome en el sistema.');
        estaIniciando = false;
        return;
    }
    logMsg(`🌐 Usando navegador: ${executablePath}`);

    // Limpiar caché de Chrome ANTES de iniciar (evita acumulación en disco)
    const _instancia = process.env.WSP_INSTANCIA || 'wsp-clientes';
    const _authPath = path.resolve(`.wwebjs_auth_${_instancia}`);
    const cacheSubdirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache'];
    cacheSubdirs.forEach(dir => {
        const p = path.join(_authPath, `session-${_instancia}`, 'Default', dir);
        if (fs.existsSync(p)) {
            try { fs.rmSync(p, { recursive: true, force: true }); logMsg(`🗑️ Cache limpiado: ${dir}`); }
            catch (e) { logMsg(`⚠️ No se pudo limpiar ${dir}: ${e.message}`); }
        }
    });

    // Limpiar SingletonLock si existe
    const cleanupLocks = () => {
        const { WSP_INSTANCIA } = require('../config/api');
        const paths = [
            path.join(process.cwd(), `.wwebjs_auth_${WSP_INSTANCIA}`, `session-${WSP_INSTANCIA}`, 'SingletonLock'),
            path.join(process.cwd(), '.wwebjs_auth', 'session', 'SingletonLock')
        ];
        paths.forEach(p => {
            if (fs.existsSync(p)) {
                try {
                    fs.unlinkSync(p);
                    logMsg(`🔓 SingletonLock eliminado: ${p}`);
                } catch (e) {
                    logMsg(`⚠️  Lock ocupado: ${p}`);
                }
            }
        });
    };
    cleanupLocks();

    const { WSP_INSTANCIA } = require('../config/api');

    // ── FIX #1: Destruir cliente anterior ANTES de crear uno nuevo
    //    Evita listeners duplicados (causa del evento 'authenticated' x3)
    if (clienteWA) {
        logMsg(`🧹 [ID:${currentInitId}] Destruyendo instancia anterior antes de crear nueva...`);
        try {
            clienteWA.removeAllListeners();
            await Promise.race([
                clienteWA.destroy(),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
            ]);
        } catch (e) {
            logMsg(`⚠️ Error destruyendo instancia anterior: ${e.message}`);
        }
        clienteWA = null;
    }

    clienteWA = new Client({
        authStrategy: new LocalAuth({
            clientId: WSP_INSTANCIA,
            dataPath: `.wwebjs_auth_${WSP_INSTANCIA}`
        }),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1033870439.html'
        },
        puppeteer: {
            headless: 'new',
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                // PREVENIR BACKGROUND THROTTLING (CAUSA DE DESCONEXIONES LARGAS DE INACTIVIDAD)
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-zygote',
                '--no-first-run',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-breakpad',
                '--disable-component-update',
                '--disable-domain-reliability',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
                // FIX: Evitar acumulación de caché en disco (causa del colapso Nov 2026)
                '--disk-cache-size=0',
                '--media-cache-size=0',
                '--aggressive-cache-discard',
                '--disable-application-cache'
            ]
        }
    });

    // ── Eventos ──

    clienteWA.on('authenticated', async () => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`🔐 [ID:${currentInitId}] WhatsApp autenticado con éxito — sincronizando chats...`);
        estadoActual = 'inicializando';
        qrBase64 = null;
        await reportarEstadoVPS('inicializando', null);

        // ── FIX #2: Timeout de seguridad — si 'ready' no llega en 3 min, reiniciar Chrome
        //    Evita quedarse pegado en 'inicializando' indefinidamente
        if (readyTimeoutHandle) clearTimeout(readyTimeoutHandle);
        readyTimeoutHandle = setTimeout(async () => {
            if (estadoActual === 'inicializando' && currentInitId === sessionIntentId) {
                logMsg(`⌛ [ID:${currentInitId}] 'ready' no llegó en 3 minutos tras autenticación. Reiniciando Chrome...`);
                resetearSesion(false).catch(e => logMsg(`Error en auto-reset tras timeout: ${e.message}`));
            }
        }, 180_000); // 3 minutos
    });

    clienteWA.on('auth_failure', async (msg) => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`❌ [ID:${currentInitId}] Fallo de autenticación: ${msg}`);
        resetearSesion(true).catch(e => logMsg(`Error en reset tras auth_failure: ${e.message}`));
    });

    clienteWA.on('qr', async (qr) => {
        try {
            logMsg('📷 QR generado — escanéalo desde el ERP');
            estadoActual = 'qr_pendiente';
            qrBase64 = await qrcode.toDataURL(qr);
            await reportarEstadoVPS('qr_pendiente', qrBase64);
        } catch (qrErr) {
            // Si el frame fue detachado mientras procesaba el QR, auto-recuperar
            if (qrErr.message && qrErr.message.includes('detached Frame')) {
                logMsg(`🔴 [DETACHED-FRAME] Frame de Chrome muerto durante QR — forzando auto-recuperación...`);
                resetearSesion(false).catch(e => logMsg(`Error en auto-recuperación: ${e.message}`));
            } else {
                logMsg(`⚠️ Error procesando QR: ${qrErr.message}`);
            }
        }
    });

    clienteWA.on('loading_screen', (percent, message) => {
        logMsg(`⏳ [ID:${currentInitId}] Sincronizando WhatsApp Web: ${percent}% — ${message}`);
    });

    // Adjuntar listeners de errores de Chrome inmediatamente (no solo en 'ready')
    // Captura crashes durante la fase de QR antes de que esté autenticado
    const adjuntarMonitoreoCrash = () => {
        try {
            const page = clienteWA.pupPage;
            if (!page || page._closed) return;
            page.on('error', err => {
                const esDetach = err.message && err.message.includes('detached Frame');
                logMsg(`🔴 [CRASH-PAGE] ${esDetach ? 'Frame detachado' : 'Crash de Chrome'}: ${err.message}`);
                resetearSesion(false).catch(e => logMsg(`Error en auto-recuperación: ${e.message}`));
            });
            page.on('pageerror', pageErr => {
                logMsg(`⚠️ [PAGE-ERROR] Error JS en WhatsApp Web: ${pageErr.message.slice(0, 120)}`);
            });
            logMsg(`🔍 [ID:${currentInitId}] Monitoreo de crash de Chrome activado.`);
        } catch (e) {
            logMsg(`⚠️ No se pudo inyectar monitoreo de crash: ${e.message}`);
        }
    };

    // Intentar adjuntar el monitoreo en cuanto Puppeteer levanta la página
    setTimeout(adjuntarMonitoreoCrash, 3000);

    clienteWA.on('ready', async () => {
        if (currentInitId !== sessionIntentId) return;

        // ── FIX #3: Cancelar timeout de 'ready' al conectarse exitosamente
        if (readyTimeoutHandle) {
            clearTimeout(readyTimeoutHandle);
            readyTimeoutHandle = null;
        }

        const numero = clienteWA.info?.wid?.user || null;
        logMsg(`✅ [ID:${currentInitId}] WhatsApp Web conectado y listo — Número: ${numero || 'desconocido'}`);
        estadoActual = 'conectado';
        estaIniciando = false;
        qrBase64 = null;
        await reportarEstadoVPS('conectado', null, numero);

        // Re-adjuntar monitoreo de crash en 'ready' (el anterior puede haberse perdido)
        adjuntarMonitoreoCrash();

        // --- RE-VINCULACIÓN DE WORKERS ---
        if (readyHook) {
            logMsg(`🔗 Ejecutando ReadyHook para vincular workers...`);
            readyHook(clienteWA);
        }
    });

    clienteWA.on('change_state', state => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`🔄 [ID:${currentInitId}] WhatsApp cambió de estado de red/sesión internamente: ${state}`);
    });

    clienteWA.on('disconnected', async (reason) => {
        logMsg(`⚠️  WhatsApp desconectado: ${reason}`);

        // Si fue un logout manual desde el teléfono, hay que borrar sesión
        const borrarCarpeta = (reason === 'LOGOUT');

        // Usamos resetearSesion para asegurar limpieza de procesos Chrome
        resetearSesion(borrarCarpeta).catch(e => logMsg(`Error en reset tras desconexión: ${e.message}`));
    });

    // Timeout de seguridad: si no inicializa en 300s, algo está mal
    const initTimeout = setTimeout(() => {
        if (estaIniciando && estadoActual === 'desconectado') {
            logMsg('⌛ clienteWA.initialize() tardando demasiado (300s)...');
        }
    }, 300_000);

    const staggerDelay = 5_000;
    logMsg(`🏁 [ID:${currentInitId}] Preparando clienteWA.initialize() en ${staggerDelay / 1000} segundos...`);
    await new Promise(r => setTimeout(r, staggerDelay));

    // VERIFICAR QUE NO HAYA HABIDO UN RESET EN EL INTERIN
    if (currentInitId !== sessionIntentId) {
        logMsg(`🛑 [ID:${currentInitId}] Inicialización cancelada (detectado reset o nuevo intento).`);
        estaIniciando = false;
        return null;
    }

    logMsg(`🚀 [ID:${currentInitId}] Ejecutando clienteWA.initialize()...`);

    try {
        await clienteWA.initialize();
        clearTimeout(initTimeout);
        estaIniciando = false;
        logMsg(`✅ [ID:${currentInitId}] clienteWA.initialize() completado`);
        return clienteWA;
    } catch (err) {
        clearTimeout(initTimeout);
        estaIniciando = false;
        logMsg(`❌ [ID:${currentInitId}] Error en clienteWA.initialize(): ${err.message}`);

        // Programar reintento solo si falló la inicialización inicial y no hay reset pendiente
        if (currentInitId === sessionIntentId) {
            setTimeout(iniciarWhatsApp, 30_000);
        }
        return null;
    }
}

/**
 * Notifica a Hostinger (API o BD Directa) el estado actual del VPS/WhatsApp
 * @param {string} estado - conectado|qr_pendiente|desconectado|inicializando
 * @param {string|null} qr - QR en base64 (solo cuando qr_pendiente)
 * @param {string|null} numero - Número WhatsApp vinculado (solo cuando conectado)
 */
async function reportarEstadoVPS(estado, qr, numero = null) {
    try {
        const hostinger = require('../api/hostinger');
        return await hostinger.reportarEstadoVPS(estado, qr, numero);
    } catch (err) {
        logMsg(`⚠️  Error al reportar estado VPS: ${err.message}`);
        return null;
    }
}

// ── Getters para el servidor Express interno ──
function obtenerEstado() {
    return {
        estado: estadoActual,
        qr: qrBase64 ? 'disponible' : null,
        timestamp: new Date().toISOString()
    };
}

function obtenerEstadoActual() { return estadoActual; }
function obtenerQR() { return qrBase64; }
function obtenerCliente() { return clienteWA; }

/**
 * Reinicia completamente la sesión WhatsApp (para cambio de número o recuperación de errores)
 * @param {boolean} borrarSesion - Si es true, borra la carpeta .wwebjs_auth (nuke). Si es false, solo reinicia el navegador.
 */
async function resetearSesion(borrarSesion = false) {
    sessionIntentId++; // Invalidar cualquier inicialización en cola
    logMsg(`🔄 [ID:${sessionIntentId}] Iniciando reset de sesión WhatsApp (borrarCarpeta: ${borrarSesion})...`);

    // ── FIX: Cancelar timeout de ready pendiente al hacer reset
    if (readyTimeoutHandle) {
        clearTimeout(readyTimeoutHandle);
        readyTimeoutHandle = null;
        logMsg(`⏹️  Timeout de 'ready' cancelado.`);
    }

    // 1. Destruir cliente actual (sin esperar demasiado)
    if (clienteWA) {
        logMsg('🔌 Destruyendo cliente anterior...');
        try {
            clienteWA.removeAllListeners(); // ── FIX: limpiar listeners antes de destruir
            await Promise.race([
                clienteWA.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout destruyendo cliente')), 5000))
            ]);
        } catch (e) {
            logMsg(`⚠️  Al destruir cliente: ${e.message}`);
        }
        clienteWA = null;
    }

    // 2. Borrar la carpeta de sesión local SOLO si se solicita explícitamente
    const fs = require('fs');
    const path = require('path');
    const { WSP_INSTANCIA } = require('../config/api');
    const authPath = path.resolve(`.wwebjs_auth_${WSP_INSTANCIA}`);

    if (borrarSesion) {
        logMsg(`🗑️  Limpiando carpeta de sesión: ${authPath} (NUKE)`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                logMsg(`✅ Carpeta ${authPath} eliminada satisfactoriamente`);
            } catch (e) {
                logMsg(`❌ No se pudo eliminar la carpeta de sesión: ${e.message}`);
            }
        }
    } else {
        logMsg(`ℹ️  Manteniendo carpeta de sesión para intento de auto-recuperación.`);
    }

    // 3. Matar procesos de Chrome huérfanos residuo de esta instancia
    // Pattern refinado: solo chrome que use este data-dir (evita matar el proceso Node)
    try {
        const { execSync } = require('child_process');
        logMsg(`🧹 Limpiando procesos Chrome de ${WSP_INSTANCIA}...`);
        execSync(`pkill -9 -f "chrome.*\.wwebjs_auth_${WSP_INSTANCIA}" || true`);
    } catch (e) { }

    // 4. Actualizar estado y re-notificar
    estadoActual = 'desconectado';
    qrBase64 = null;
    estaIniciando = false;
    await reportarEstadoVPS('desconectado', null);

    // 5. Re-inicializar 
    logMsg(`⏳ Re-inicializando en 5 segundos...`);
    setTimeout(iniciarWhatsApp, 5_000);
}

function setReadyHook(hook) {
    readyHook = hook;
}

module.exports = { iniciarWhatsApp, obtenerEstado, obtenerQR, obtenerCliente, reportarEstadoVPS, obtenerEstadoActual, resetearSesion, setReadyHook };

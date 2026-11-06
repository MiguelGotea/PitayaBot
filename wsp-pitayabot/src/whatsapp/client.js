'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Estado interno del cliente
let estadoActual   = 'desconectado';
let estaIniciando  = false;
let qrBase64       = null;
let clienteWA      = null;
let sessionIntentId = 0;
let readyHook      = null;

const logMsg = (msg) => {
    const pid = process.pid;
    const ut  = Math.round(process.uptime());
    console.log(`[PID:${pid}|UT:${ut}s] ${msg}`);
};

/**
 * Inicializa el cliente de whatsapp-web.js con sesión persistente.
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

    logMsg(`📱 [ID:${currentInitId}] Iniciando cliente WhatsApp Web (wsp-pitayabot)...`);
    estaIniciando  = true;
    estadoActual   = 'inicializando';
    await reportarEstadoVPS('inicializando', null);

    // Detectar ejecutable de Chromium/Chrome disponible
    const fs   = require('fs');
    const path = require('path');

    const chromiumPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ];
    const executablePath = chromiumPaths.find(p => fs.existsSync(p));
    if (!executablePath) {
        logMsg('❌ No se encontró Chromium/Chrome en el sistema.');
        estaIniciando = false;
        return;
    }
    logMsg(`🌐 Usando navegador: ${executablePath}`);

    // Limpiar caché de Chrome ANTES de iniciar (evita acumulación en disco)
    const { WSP_INSTANCIA } = require('../config/api');
    const authPath = path.resolve(`.wwebjs_auth_${WSP_INSTANCIA}`);
    const cacheSubdirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache'];
    cacheSubdirs.forEach(dir => {
        const p = path.join(authPath, `session-${WSP_INSTANCIA}`, 'Default', dir);
        if (fs.existsSync(p)) {
            try { fs.rmSync(p, { recursive: true, force: true }); logMsg(`🗑️ Cache limpiado: ${dir}`); }
            catch (e) { logMsg(`⚠️ No se pudo limpiar ${dir}: ${e.message}`); }
        }
    });

    // Limpiar SingletonLock si existe
    const cleanupLocks = () => {
        const { WSP_INSTANCIA } = require('../config/api');
        const authPath = path.resolve(`.wwebjs_auth_${WSP_INSTANCIA}`);
        const deleteSingletonLock = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.lstatSync(fullPath).isDirectory()) {
                    deleteSingletonLock(fullPath);
                } else if (file === 'SingletonLock') {
                    try { fs.unlinkSync(fullPath); logMsg(`🔓 SingletonLock eliminado: ${fullPath}`); }
                    catch (e) { logMsg(`⚠️  Lock ocupado: ${fullPath}`); }
                }
            }
        };
        deleteSingletonLock(authPath);
    };
    cleanupLocks();

    const { WSP_INSTANCIA } = require('../config/api');
    clienteWA = new Client({
        authStrategy: new LocalAuth({
            clientId: WSP_INSTANCIA,
            dataPath: `.wwebjs_auth_${WSP_INSTANCIA}`
        }),
        puppeteer: {
            headless: 'new',
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                // FIX: Evitar acumulación de caché en disco (causa del colapso Nov 2026)
                '--disk-cache-size=0',
                '--media-cache-size=0',
                '--aggressive-cache-discard',
                '--disable-application-cache',
            ]
        }
    });

    // ── Eventos ──

    clienteWA.on('qr', async (qr) => {
        logMsg('📷 QR generado — escanéalo desde el ERP');
        estadoActual = 'qr_pendiente';
        qrBase64     = await qrcode.toDataURL(qr);
        await reportarEstadoVPS('qr_pendiente', qrBase64);
    });

    clienteWA.on('ready', async () => {
        if (currentInitId !== sessionIntentId) return;
        const numero = clienteWA.info?.wid?.user || null;
        logMsg(`✅ [ID:${currentInitId}] WhatsApp Web conectado — Número: ${numero || 'desconocido'}`);
        estadoActual  = 'conectado';
        estaIniciando = false;
        qrBase64      = null;
        await reportarEstadoVPS('conectado', null, numero);

        // Monitoreo profundo de la página Chrome
        try {
            if (clienteWA.pupPage) {
                clienteWA.pupPage.on('error', err => {
                    logMsg(`🔴 [CRITICAL P-ERROR] Chrome crash: ${err.message}`);
                    resetearSesion(false).catch(e => logMsg(`Error auto-recuperar: ${e.message}`));
                });
                clienteWA.pupPage.on('pageerror', pageErr => {
                    logMsg(`⚠️ [PAGE-ERROR] Error JS en WhatsApp Web: ${pageErr.message}`);
                });
                logMsg(`🔍 [ID:${currentInitId}] Monitoreo profundo de Chrome activado.`);
            }
        } catch (e) {
            logMsg(`⚠️ No se pudo inyectar monitoreo de página: ${e.message}`);
        }

        // Vincular workers tras conectar
        if (readyHook) {
            logMsg('🔗 Ejecutando ReadyHook para vincular workers...');
            readyHook(clienteWA);
        }
    });

    clienteWA.on('auth_failure', async (msg) => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`❌ [ID:${currentInitId}] Fallo de autenticación: ${msg}`);
        resetearSesion(true).catch(e => logMsg(`Error en reset tras auth_failure: ${e.message}`));
    });

    clienteWA.on('change_state', state => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`🔄 [ID:${currentInitId}] WhatsApp cambió estado interno: ${state}`);
    });

    clienteWA.on('disconnected', async (reason) => {
        logMsg(`⚠️  WhatsApp desconectado: ${reason}`);
        const borrarCarpeta = (reason === 'LOGOUT');
        resetearSesion(borrarCarpeta).catch(e => logMsg(`Error en reset tras desconexión: ${e.message}`));
    });

    const initTimeout = setTimeout(() => {
        if (estaIniciando && currentInitId === sessionIntentId) {
            logMsg(`⌛ [ID:${currentInitId}] initialize() tardando demasiado (Timeout 10m)...`);
        }
    }, 600_000);

    const staggerDelay = 15_000;
    logMsg(`🏁 [ID:${currentInitId}] Preparando initialize() en ${staggerDelay / 1000}s...`);
    await new Promise(r => setTimeout(r, staggerDelay));

    if (currentInitId !== sessionIntentId) {
        logMsg(`🛑 [ID:${currentInitId}] Inicialización cancelada (detectado reset).`);
        estaIniciando = false;
        return null;
    }

    logMsg(`🚀 [ID:${currentInitId}] Ejecutando clienteWA.initialize()...`);

    try {
        await clienteWA.initialize();
        clearTimeout(initTimeout);
        estaIniciando = false;
        logMsg(`✅ [ID:${currentInitId}] initialize() completado`);
        return clienteWA;
    } catch (err) {
        clearTimeout(initTimeout);
        estaIniciando = false;
        logMsg(`❌ [ID:${currentInitId}] Error en initialize(): ${err.message}`);
        if (currentInitId === sessionIntentId) {
            setTimeout(iniciarWhatsApp, 30_000);
        }
        return null;
    }
}

/**
 * Notifica a la API el estado actual del VPS/WhatsApp
 */
async function reportarEstadoVPS(estado, qr, numero = null) {
    try {
        const axios = require('axios');
        const { API_BASE_URL, WSP_TOKEN, WSP_INSTANCIA } = require('../config/api');
        const resp = await axios.post(`${API_BASE_URL}/api/wsp/registrar_sesion.php`, {
            estado,
            instancia:        WSP_INSTANCIA,
            qr_base64:        qr || null,
            numero_telefono:  numero || null
        }, {
            headers: { 'X-WSP-Token': WSP_TOKEN },
            timeout: 10_000
        });
        return resp.data;
    } catch (err) {
        logMsg(`⚠️  No se pudo reportar estado a la API: ${err.message}`);
        return null;
    }
}

function obtenerEstado() {
    return {
        estado:    estadoActual,
        qr:        qrBase64 ? 'disponible' : null,
        timestamp: new Date().toISOString()
    };
}

function obtenerEstadoActual() { return estadoActual; }
function obtenerQR()           { return qrBase64;     }
function obtenerCliente()      { return clienteWA;    }

/**
 * Reinicia completamente la sesión WhatsApp
 * @param {boolean} borrarSesion - true = nuke carpeta .wwebjs_auth
 */
async function resetearSesion(borrarSesion = false) {
    sessionIntentId++;
    logMsg(`🔄 [ID:${sessionIntentId}] Reset de sesión (borrarCarpeta: ${borrarSesion})...`);

    if (clienteWA) {
        logMsg('🔌 Destruyendo cliente anterior...');
        try {
            await Promise.race([
                clienteWA.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout destruyendo cliente')), 5000))
            ]);
        } catch (e) {
            logMsg(`⚠️  Al destruir cliente: ${e.message}`);
        }
        clienteWA = null;
    }

    const fs   = require('fs');
    const path = require('path');
    const { WSP_INSTANCIA } = require('../config/api');
    const authPath = path.resolve(`.wwebjs_auth_${WSP_INSTANCIA}`);

    if (borrarSesion) {
        logMsg(`🗑️  Limpiando carpeta de sesión: ${authPath} (NUKE)`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                logMsg(`✅ Carpeta ${authPath} eliminada`);
            } catch (e) {
                logMsg(`❌ No se pudo eliminar carpeta: ${e.message}`);
            }
        }
    } else {
        logMsg(`ℹ️  Manteniendo carpeta para auto-recuperación.`);
    }

    // Matar procesos Chrome huérfanos de esta instancia
    try {
        const { execSync } = require('child_process');
        execSync(`pkill -9 -f "chrome.*\\.wwebjs_auth_${WSP_INSTANCIA}" || true`);
    } catch (e) {}

    estadoActual  = 'desconectado';
    qrBase64      = null;
    estaIniciando = false;
    await reportarEstadoVPS('desconectado', null);

    logMsg('⏳ Re-inicializando en 5 segundos...');
    setTimeout(iniciarWhatsApp, 5_000);
}

function setReadyHook(hook) {
    readyHook = hook;
}

module.exports = {
    iniciarWhatsApp,
    obtenerEstado,
    obtenerQR,
    obtenerCliente,
    reportarEstadoVPS,
    obtenerEstadoActual,
    resetearSesion,
    setReadyHook
};

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Estado interno del cliente
let estadoActual = 'desconectado';
let estaIniciando = false;
let qrBase64 = null;
let clienteWA = null;
let sessionIntentId = 0; // Para cancelar inits obsoletos durante el delay de stagger
let readyHook = null; // Callback para re-vincular workers tras reset

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

    logMsg(`📱 [ID:${currentInitId}] Iniciando cliente WhatsApp Web (wsp-crmbot)...`);
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

    // Limpiar SingletonLock si existe
    const cleanupLocks = () => {
        const { WSP_INSTANCIA } = require('../config/api');
        const authPath = path.resolve(`.wwebjs_auth_${WSP_INSTANCIA}`);
        
        // Función recursiva para borrar SingletonLock
        const deleteSingletonLock = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.lstatSync(fullPath).isDirectory()) {
                    deleteSingletonLock(fullPath);
                } else if (file === 'SingletonLock') {
                    try {
                        fs.unlinkSync(fullPath);
                        logMsg(`🔓 SingletonLock eliminado: ${fullPath}`);
                    } catch (e) {
                        logMsg(`⚠️  Lock ocupado: ${fullPath}`);
                    }
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
                '--disable-application-cache'
            ]
        }
    });

    // ── Eventos ──

    clienteWA.on('qr', async (qr) => {
        logMsg('📷 QR generado — escanéalo desde el ERP');
        estadoActual = 'qr_pendiente';
        qrBase64 = await qrcode.toDataURL(qr);
        await reportarEstadoVPS('qr_pendiente', qrBase64);
    });

    clienteWA.on('ready', async () => {
        if (currentInitId !== sessionIntentId) return;
        const numero = clienteWA.info?.wid?.user || null;
        logMsg(`✅ [ID:${currentInitId}] WhatsApp Web conectado y listo — Número: ${numero || 'desconocido'}`);
        estadoActual = 'conectado';
        estaIniciando = false;
        qrBase64 = null;
        await reportarEstadoVPS('conectado', null, numero);

        // --- DEEP DEBUGGING: Escuchar errores internos de la página de Chrome ---
        try {
            if (clienteWA.pupPage) {
                clienteWA.pupPage.on('error', err => {
                    logMsg(`🔴 [CRITICAL P-ERROR] La página de Chrome hizo crash: ${err.message}`);
                    // Auto-recuperación NO destructiva (borrarSesion = false)
                    resetearSesion(false).catch(e => logMsg(`Error al intentar auto-recuperar: ${e.message}`));
                });
                clienteWA.pupPage.on('pageerror', pageErr => {
                    logMsg(`⚠️ [PAGE-ERROR] Error JS dentro de WhatsApp Web: ${pageErr.message}`);
                });
                logMsg(`🔍 [ID:${currentInitId}] Monitoreo profundo de la página Chrome activado.`);
            }
        } catch (e) {
            logMsg(`⚠️ No se pudo inyectar el monitoreo de página: ${e.message}`);
        }

        // --- RE-VINCULACIÓN DE WORKERS ---
        if (readyHook) {
            logMsg(`🔗 Ejecutando ReadyHook para vincular workers...`);
            readyHook(clienteWA);
        }
    });

    clienteWA.on('auth_failure', async (msg) => {
        if (currentInitId !== sessionIntentId) return;
        logMsg(`❌ [ID:${currentInitId}] Fallo de autenticación: ${msg}`);
        // FALLO CRÍTICO: Borrar carpeta para permitir nuevo QR
        resetearSesion(true).catch(e => logMsg(`Error en reset tras auth_failure: ${e.message}`));
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

    const initTimeout = setTimeout(() => {
        if (estaIniciando && currentInitId === sessionIntentId) {
            logMsg(`⌛ [ID:${currentInitId}] clienteWA.initialize() tardando demasiado (Timeout 10m)...`);
        }
    }, 600_000);

    const staggerDelay = 15_000;
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
 * Notifica a la API el estado actual del VPS/WhatsApp
 * @param {string} estado - conectado|qr_pendiente|desconectado|inicializando
 * @param {string|null} qr - QR en base64 (solo cuando qr_pendiente)
 * @param {string|null} numero - Número WhatsApp vinculado (solo cuando conectado)
 */
async function reportarEstadoVPS(estado, qr, numero = null) {
    try {
        const axios = require('axios');
        const { API_BASE_URL, WSP_TOKEN, WSP_INSTANCIA } = require('../config/api');
        const resp = await axios.post(`${API_BASE_URL}/api/wsp/registrar_sesion.php`, {
            estado,
            instancia: WSP_INSTANCIA,
            qr_base64: qr || null,
            numero_telefono: numero || null
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

    // 1. Destruir cliente actual (sin esperar demasiado)
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

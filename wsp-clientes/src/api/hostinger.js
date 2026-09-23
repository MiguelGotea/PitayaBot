/**
 * ============================================================================
 * hostinger.js — Router / Fachada de Integración con Hostinger
 * ============================================================================
 * 
 * ⚠️ ATENCIÓN: AJUSTE TEMPORAL ACTIVO POR DEFECTO ⚠️
 * 
 * MOTIVO:
 *   Actualmente existe un problema de conectividad / bloqueo TLS entre el VPS
 *   (DigitalOcean) y Hostinger (api.batidospitaya.com / proxy.batidospitaya.com).
 *   Para evitar que el bot de clientes quede inoperativo o desconectado, se
 *   implementó una conexión directa a la base de datos MySQL de Hostinger.
 * 
 * ¿CÓMO RESTABLECER AL MODO CONVENCIONAL?
 *   1. Cambiar la constante `USE_DIRECT_DB` a `false` (o configurar USE_DIRECT_DB=false en .env).
 *   2. Reiniciar el proceso con: `pm2 restart wsp-clientes`
 *   ¡Listo! Todo el flujo volverá automáticamente a través de la API/Proxy HTTPS.
 * ============================================================================
 */

'use strict';

require('dotenv').config();

// ── INTERRUPTOR DE MODO DE CONEXIÓN ───────────────────────────────────────────
// true  → Conexión DIRECTA a MySQL Hostinger (Ajuste temporal por bloqueo TLS VPS <-> API)
// false → Conexión ESTÁNDAR vía API HTTPS (Modo original)
const USE_DIRECT_DB = process.env.USE_DIRECT_DB !== undefined
    ? process.env.USE_DIRECT_DB === 'true'
    : true;

// ── Carga de submódulos separados ─────────────────────────────────────────────
const hostingerApi = require('./hostinger_api');
const hostingerDirectDb = require('./hostinger_direct_db');

// Seleccionar cliente activo
const activeClient = USE_DIRECT_DB ? hostingerDirectDb : hostingerApi;

if (USE_DIRECT_DB) {
    console.warn('╔════════════════════════════════════════════════════════════════════╗');
    console.warn('║ ⚠️  wsp-clientes: AJUSTE TEMPORAL ACTIVO                          ║');
    console.warn('║ Modo: Conexión DIRECTA a BD Hostinger (MySQL 145.223.105.42)      ║');
    console.warn('║ (api.batidospitaya.com está puenteado por bloqueo TLS VPS)         ║');
    console.warn('╚════════════════════════════════════════════════════════════════════╝');
} else {
    console.log('[wsp-clientes] Modo ESTÁNDAR activo: Comunicación vía API HTTPS');
}

// ── Fachada de métodos exportados ─────────────────────────────────────────────

async function reportarEstadoVPS(estado, qr, numero = null) {
    return activeClient.reportarEstadoVPS(estado, qr, numero);
}

async function obtenerCampanasPendientes() {
    return activeClient.obtenerCampanasPendientes();
}

async function reportarResultadoCampana(campanaId, destinatarioId, resultado, detalle) {
    return activeClient.reportarResultadoCampana(campanaId, destinatarioId, resultado, detalle);
}

async function obtenerNotificacionesPendientes() {
    return activeClient.obtenerNotificacionesPendientes();
}

async function reportarResultadoNotificacion(id, resultado, detalle) {
    return activeClient.reportarResultadoNotificacion(id, resultado, detalle);
}

module.exports = {
    USE_DIRECT_DB,
    reportarEstadoVPS,
    obtenerCampanasPendientes,
    reportarResultadoCampana,
    obtenerNotificacionesPendientes,
    reportarResultadoNotificacion,
    // Acceso a submódulos para depuración
    _api: hostingerApi,
    _directDb: hostingerDirectDb
};

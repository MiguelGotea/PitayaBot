'use strict';

/**
 * ============================================================================
 * hostinger_api.js — Modo Convencional vía HTTPS (api.batidospitaya.com / proxy)
 * ============================================================================
 */

const axios = require('axios');
const { API_BASE_URL, WSP_TOKEN, WSP_INSTANCIA } = require('../config/api');

async function reportarEstadoVPS(estado, qr, numero = null) {
    try {
        const url = `${API_BASE_URL}/api/wsp/registrar_sesion.php`;
        const resp = await axios.post(url, {
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
        if (err.response) {
            console.error(`❌ [API] HTTP ${err.response.status} en registrar_sesion.php`);
        } else if (err.request) {
            console.error(`❌ [API] Sin respuesta de [${API_BASE_URL}]: ${err.message}`);
        } else {
            console.error(`⚠️  [API] Error preparando request: ${err.message}`);
        }
        return null;
    }
}

async function obtenerCampanasPendientes() {
    const resp = await axios.get(`${API_BASE_URL}/api/wsp/pendientes.php`, {
        headers: { 'X-WSP-Token': WSP_TOKEN },
        params: { instancia: WSP_INSTANCIA },
        timeout: 15_000
    });
    return resp.data;
}

async function reportarResultadoCampana(campanaId, destinatarioId, resultado, detalle) {
    try {
        const resp = await axios.post(`${API_BASE_URL}/api/wsp/actualizar.php`, {
            campana_id: campanaId,
            destinatario_id: destinatarioId,
            resultado,
            detalle
        }, {
            headers: { 'X-WSP-Token': WSP_TOKEN },
            timeout: 10_000
        });
        return resp.data;
    } catch (err) {
        console.error('⚠️  [API] Error reportando resultado campaña:', err.message);
        return null;
    }
}

async function obtenerNotificacionesPendientes() {
    const resp = await axios.get(`${API_BASE_URL}/api/wsp/pendientes_notificaciones.php`, {
        headers: { 'X-WSP-Token': WSP_TOKEN },
        params: { instancia: WSP_INSTANCIA },
        timeout: 10_000
    });
    return resp.data;
}

async function reportarResultadoNotificacion(id, resultado, detalle) {
    try {
        const resp = await axios.post(`${API_BASE_URL}/api/wsp/actualizar_notificacion.php`, {
            id,
            resultado,
            detalle
        }, {
            headers: { 'X-WSP-Token': WSP_TOKEN },
            timeout: 10_000
        });
        return resp.data;
    } catch (err) {
        console.error(`⚠️  [API] Error reportando resultado notificación ID ${id}:`, err.message);
        return null;
    }
}

module.exports = {
    reportarEstadoVPS,
    obtenerCampanasPendientes,
    reportarResultadoCampana,
    obtenerNotificacionesPendientes,
    reportarResultadoNotificacion
};

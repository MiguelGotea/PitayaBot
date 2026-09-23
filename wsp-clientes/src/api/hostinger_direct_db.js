'use strict';

/**
 * ============================================================================
 * ⚠️ AJUSTE TEMPORAL: hostinger_direct_db.js (Bypass directo a MySQL Hostinger)
 * ============================================================================
 * 
 * MOTIVO:
 *   Actualmente existe un problema de conectividad / bloqueo TLS entre el VPS
 *   (DigitalOcean) y el servidor de Hostinger donde corre api.batidospitaya.com,
 *   lo que causa ERR_TLS_CERT_ALTNAME_INVALID o ECONNRESET en peticiones HTTPS.
 * 
 * SOLUCIÓN TEMPORAL:
 *   Este módulo conecta DIRECTAMENTE a la base de datos MySQL de Hostinger
 *   utilizando credenciales seguras (con respaldo en variables de entorno),
 *   emulando la funcionalidad exacta de los endpoints PHP de la API.
 * 
 * REVERSIÓN:
 *   Para volver al modo convencional, cambiar USE_DIRECT_DB = false en hostinger.js
 * ============================================================================
 */

require('dotenv').config();
const { WSP_INSTANCIA } = require('../config/api');

const DB_CONFIG = {
    host:               process.env.DB_HOST || '145.223.105.42',
    port:     parseInt(process.env.DB_PORT) || 3306,
    database:           process.env.DB_NAME || 'u839374897_erp',
    user:               process.env.DB_USER || 'u839374897_erp',
    password:           process.env.DB_PASS || 'ERpPitHay2025$',
    waitForConnections: true,
    connectionLimit:    5,
    queueLimit:         0,
    connectTimeout:     15000,
};

let pool = null;

function getPool() {
    if (!pool) {
        let mysql;
        try {
            mysql = require('mysql2/promise');
        } catch (e) {
            try {
                // Fallback directo al paquete instalado en gmb-worker en el VPS
                mysql = require('/opt/gmb-worker/node_modules/mysql2/promise');
            } catch (e2) {
                throw new Error('[DB-DIRECTO-TEMPORAL] Falta el paquete mysql2. Ejecuta: npm install mysql2');
            }
        }
        pool = mysql.createPool(DB_CONFIG);
        console.log(`[DB-DIRECTO-TEMPORAL] Pool MySQL inicializado → ${DB_CONFIG.host}:${DB_CONFIG.port} (BD: ${DB_CONFIG.database})`);
    }
    return pool;
}

/**
 * Reporta el estado de la sesión WhatsApp directamente en wsp_sesion_vps_
 * Emula: /api/wsp/registrar_sesion.php
 */
async function reportarEstadoVPS(estado, qr, numero = null) {
    try {
        const p = getPool();
        const qrGuardar = (estado === 'conectado') ? null : (qr || null);
        const numGuardar = (estado === 'desconectado') ? null : (numero || null);
        const ipVPS = '198.211.97.243';

        // Upsert en wsp_sesion_vps_
        await p.query(`
            INSERT INTO wsp_sesion_vps_ (instancia, estado, qr_base64, numero_telefono, ultimo_ping, ip_vps)
            VALUES (?, ?, ?, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE
                estado          = VALUES(estado),
                qr_base64       = VALUES(qr_base64),
                numero_telefono = COALESCE(VALUES(numero_telefono), numero_telefono),
                ultimo_ping     = VALUES(ultimo_ping),
                ip_vps          = VALUES(ip_vps)
        `, [WSP_INSTANCIA, estado, qrGuardar, numGuardar, ipVPS]);

        // Verificar si se solicitó un reset (cambio de número)
        const [rows] = await p.query(`
            SELECT reset_solicitado FROM wsp_sesion_vps_ 
            WHERE instancia = ? 
            ORDER BY ultimo_ping DESC LIMIT 1
        `, [WSP_INSTANCIA]);

        const resetSolicitado = rows.length > 0 && parseInt(rows[0].reset_solicitado) === 1;

        if (resetSolicitado) {
            await p.query(`
                UPDATE wsp_sesion_vps_ 
                SET reset_solicitado = 0 
                WHERE instancia = ?
            `, [WSP_INSTANCIA]);
        }

        return {
            estado,
            instancia: WSP_INSTANCIA,
            reset_solicitado: resetSolicitado
        };
    } catch (err) {
        console.error('❌ [DB-DIRECTO-TEMPORAL] Error en reportarEstadoVPS:', err.message);
        return null;
    }
}

/**
 * Consulta campañas pendientes y asigna el próximo destinatario
 * Emula: /api/wsp/pendientes.php
 */
async function obtenerCampanasPendientes() {
    try {
        const p = getPool();
        const LIMITE_DESTINATARIOS = 1;

        const [campanas] = await p.query(`
            SELECT 
                id,
                nombre,
                mensaje,
                imagen_url,
                DATE_FORMAT(fecha_envio, '%Y-%m-%d %H:%i:%s') AS fecha_envio,
                total_destinatarios,
                total_enviados
            FROM wsp_campanas_
            WHERE (estado = 'programada' OR estado = 'enviando')
              AND fecha_envio <= CONVERT_TZ(NOW(), '+00:00', '-06:00')
              AND total_enviados + total_errores < total_destinatarios
            ORDER BY fecha_envio ASC
            LIMIT 5
        `);

        const resultado = [];

        for (const campana of campanas) {
            const [destinatarios] = await p.query(`
                SELECT id, id_cliente, nombre, telefono, sucursal
                FROM wsp_destinatarios_
                WHERE campana_id = ?
                  AND enviado = 0
                  AND (error IS NULL OR error = '')
                  AND (
                    hora_envio_programada IS NULL
                    OR hora_envio_programada <= CONVERT_TZ(NOW(), '+00:00', '-06:00')
                  )
                ORDER BY hora_envio_programada ASC
                LIMIT ?
            `, [campana.id, LIMITE_DESTINATARIOS]);

            if (!destinatarios || destinatarios.length === 0) continue;

            if (campana.imagen_url && campana.imagen_url.startsWith('/')) {
                campana.imagen_url = 'https://erp.batidospitaya.com' + campana.imagen_url;
            }

            campana.destinatarios = destinatarios;
            resultado.push(campana);

            // Pasar estado a 'enviando'
            await p.query(`
                UPDATE wsp_campanas_
                SET estado = 'enviando'
                WHERE id = ? AND estado = 'programada'
            `, [campana.id]);
        }

        return {
            success: true,
            campanas: resultado,
            total: resultado.length
        };
    } catch (err) {
        console.error('❌ [DB-DIRECTO-TEMPORAL] Error en obtenerCampanasPendientes:', err.message);
        return { success: false, campanas: [], error: err.message };
    }
}

/**
 * Registra el resultado del envío de un destinatario en la campaña
 * Emula: /api/wsp/actualizar.php
 */
async function reportarResultadoCampana(campanaId, destinatarioId, resultado, detalle) {
    try {
        const p = getPool();
        const cid = parseInt(campanaId);
        const did = parseInt(destinatarioId);
        const errorGuardar = (resultado === 'error') ? (detalle || 'Error desconocido') : null;

        // 1. Actualizar destinatario
        await p.query(`
            UPDATE wsp_destinatarios_
            SET enviado     = 1,
                error       = ?,
                fecha_envio = CONVERT_TZ(NOW(),'+00:00','-06:00')
            WHERE id = ? AND campana_id = ?
        `, [errorGuardar, did, cid]);

        // 2. Insertar log
        const tipo = (resultado === 'exito') ? 'exito' : 'error';
        await p.query(`
            INSERT INTO wsp_logs_ (campana_id, destinatario_id, tipo, detalle, fecha)
            VALUES (?, ?, ?, ?, CONVERT_TZ(NOW(),'+00:00','-06:00'))
        `, [cid, did, tipo, detalle || null]);

        // 3. Recalcular contadores
        await p.query(`
            UPDATE wsp_campanas_ c
            SET
                total_enviados = (
                    SELECT COUNT(*) FROM wsp_destinatarios_
                    WHERE campana_id = ?
                      AND enviado = 1 AND (error IS NULL OR error = '')
                ),
                total_errores = (
                    SELECT COUNT(*) FROM wsp_destinatarios_
                    WHERE campana_id = ?
                      AND enviado = 1 AND error IS NOT NULL AND error != ''
                )
            WHERE c.id = ?
        `, [cid, cid, cid]);

        // 4. Verificar si la campaña finalizó
        const [checkRows] = await p.query(`
            SELECT COUNT(*) AS total, SUM(enviado) AS enviados
            FROM wsp_destinatarios_
            WHERE campana_id = ?
        `, [cid]);

        if (checkRows.length > 0) {
            const total = parseInt(checkRows[0].total || 0);
            const enviados = parseInt(checkRows[0].enviados || 0);
            if (total > 0 && total === enviados) {
                await p.query(`
                    UPDATE wsp_campanas_
                    SET estado = 'completada'
                    WHERE id = ? AND estado = 'enviando'
                `, [cid]);
            }
        }

        // 5. Historial CRM unificado (si fue exitoso)
        if (resultado === 'exito') {
            try {
                const [datosRows] = await p.query(`
                    SELECT d.telefono, c.mensaje, c.instancia
                    FROM wsp_destinatarios_ d
                    JOIN wsp_campanas_ c ON c.id = d.campana_id
                    WHERE d.id = ? AND d.campana_id = ?
                    LIMIT 1
                `, [did, cid]);

                if (datosRows.length > 0) {
                    const datos = datosRows[0];
                    const numCliente = (datos.telefono || '').replace(/\D/g, '');
                    const inst = datos.instancia || WSP_INSTANCIA;

                    const [convRows] = await p.query(`
                        SELECT id FROM conversations
                        WHERE instancia = ? AND numero_cliente = ?
                        LIMIT 1
                    `, [inst, numCliente]);

                    let convId;
                    if (convRows.length === 0) {
                        const [sesRows] = await p.query(`
                            SELECT numero_telefono FROM wsp_sesion_vps_ WHERE instancia = ? LIMIT 1
                        `, [inst]);
                        const numRem = (sesRows.length > 0 && sesRows[0].numero_telefono) ? sesRows[0].numero_telefono : '0';

                        const [insResult] = await p.query(`
                            INSERT INTO conversations
                                (instancia, numero_cliente, numero_remitente, status, last_interaction_at, created_at, updated_at)
                            VALUES
                                (?, ?, ?, 'bot',
                                 CONVERT_TZ(NOW(),'+00:00','-06:00'),
                                 CONVERT_TZ(NOW(),'+00:00','-06:00'),
                                 CONVERT_TZ(NOW(),'+00:00','-06:00'))
                        `, [inst, numCliente, numRem]);
                        convId = insResult.insertId;
                    } else {
                        convId = convRows[0].id;
                    }

                    await p.query(`
                        INSERT INTO messages
                            (conversation_id, direction, sender_type, message_text, message_type, created_at)
                        VALUES
                            (?, 'out', 'campaign', ?, 'text', CONVERT_TZ(NOW(),'+00:00','-06:00'))
                    `, [convId, datos.mensaje]);

                    await p.query(`
                        UPDATE conversations 
                        SET last_interaction_at = CONVERT_TZ(NOW(),'+00:00','-06:00'), 
                            updated_at = CONVERT_TZ(NOW(),'+00:00','-06:00') 
                        WHERE id = ?
                    `, [convId]);
                }
            } catch (crmErr) {
                console.warn('⚠️  [DB-DIRECTO-TEMPORAL] Advertencia registrando historial CRM:', crmErr.message);
            }
        }

        return { success: true };
    } catch (err) {
        console.error('❌ [DB-DIRECTO-TEMPORAL] Error en reportarResultadoCampana:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Consulta notificaciones transaccionales pendientes
 * Emula: /api/wsp/pendientes_notificaciones.php
 */
async function obtenerNotificacionesPendientes() {
    try {
        const p = getPool();
        const [pendientes] = await p.query(`
            SELECT id, celular, mensaje 
            FROM wsp_notificaciones_clientesclub_pendientes_ 
            WHERE estado = 'pendiente' 
              AND instancia = ? 
            ORDER BY creado_at ASC 
            LIMIT 20
        `, [WSP_INSTANCIA]);

        if (pendientes && pendientes.length > 0) {
            const ids = pendientes.map(n => n.id);
            await p.query(`
                UPDATE wsp_notificaciones_clientesclub_pendientes_ 
                SET estado = 'enviando' 
                WHERE id IN (?)
            `, [ids]);
        }

        return {
            success: true,
            notificaciones: pendientes || [],
            total: (pendientes || []).length
        };
    } catch (err) {
        console.error('❌ [DB-DIRECTO-TEMPORAL] Error en obtenerNotificacionesPendientes:', err.message);
        return { success: false, notificaciones: [], error: err.message };
    }
}

/**
 * Reporta el resultado del envío de una notificación transaccional
 * Emula: /api/wsp/actualizar_notificacion.php
 */
async function reportarResultadoNotificacion(id, resultado, detalle) {
    try {
        const p = getPool();
        const nuevoEstado = (resultado === 'exito') ? 'enviado' : 'error';

        await p.query(`
            UPDATE wsp_notificaciones_clientesclub_pendientes_ 
            SET estado = ?, 
                enviado_at = IF(? = 'enviado', CONVERT_TZ(NOW(),'+00:00','-06:00'), NULL), 
                error_detalle = ? 
            WHERE id = ?
        `, [nuevoEstado, nuevoEstado, detalle || null, id]);

        return { actualizado: true };
    } catch (err) {
        console.error('❌ [DB-DIRECTO-TEMPORAL] Error en reportarResultadoNotificacion:', err.message);
        return { actualizado: false, error: err.message };
    }
}

module.exports = {
    reportarEstadoVPS,
    obtenerCampanasPendientes,
    reportarResultadoCampana,
    obtenerNotificacionesPendientes,
    reportarResultadoNotificacion
};

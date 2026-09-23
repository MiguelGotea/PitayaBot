'use strict';

const hostinger = require('../api/hostinger');
const { obtenerCliente } = require('../whatsapp/client');
const { formatearNumeroWA } = require('../whatsapp/sender');

/**
 * Obtiene notificaciones transaccionales pendientes desde Hostinger
 */
async function obtenerPendientes() {
    return await hostinger.obtenerNotificacionesPendientes();
}

/**
 * Reporta el resultado a Hostinger
 */
async function reportarResultado(id, resultado, detalle) {
    try {
        await hostinger.reportarResultadoNotificacion(id, resultado, detalle);
    } catch (err) {
        console.error(`⚠️  [NOTIF] Error reportando resultado para ID ${id}:`, err.message);
    }
}

let ejecutandoCicloNotif = false;

/**
 * Ciclo de envío de notificaciones (más frecuente que campañas)
 */
async function ejecutarCicloNotificaciones() {
    if (ejecutandoCicloNotif) return;

    try {
        ejecutandoCicloNotif = true;
        
        const client = obtenerCliente();
        if (!client) {
            ejecutandoCicloNotif = false;
            return;
        }

        const data = await obtenerPendientes();
        if (!data.notificaciones || data.notificaciones.length === 0) {
            ejecutandoCicloNotif = false;
            return;
        }

        console.log(`🔔 [NOTIF] Procesando ${data.notificaciones.length} notificación(es) transaccional(es)...`);

        for (const notif of data.notificaciones) {
            const chatId = formatearNumeroWA(notif.celular);
            
            try {
                // Enviar mensaje de texto simple (las notificaciones transaccionales suelen ser texto)
                await client.sendMessage(chatId, notif.mensaje);
                await reportarResultado(notif.id, 'exito', null);
                console.log(`  ✅ [NOTIF] Enviada a ${notif.celular}`);
            } catch (err) {
                console.error(`  ❌ [NOTIF] Error enviando a ${notif.celular}:`, err.message);
                await reportarResultado(notif.id, 'error', err.message);
            }

            // Pequeño delay de 2s entre notificaciones transaccionales para no saturar si hay muchas de golpe
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (err) {
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND') {
            console.error('❌ [NOTIF] Error en worker de notificaciones:', err.message);
        }
    } finally {
        ejecutandoCicloNotif = false;
    }
}

/**
 * Inicia el cron de notificaciones (cada 15 segundos)
 */
function iniciarNotificationWorker() {
    console.log('⏰ Worker de Notificaciones Transaccionales iniciado (cada 15 segundos)');
    // node-cron no soporta convenientemente 15 segundos con sintaxis estándar, 
    // pero podemos usar un setInterval o cron avanzado si el paquete lo permite.
    // Usaremos setInterval para mayor precisión en frecuencias cortas.
    setInterval(ejecutarCicloNotificaciones, 15_000);
}

module.exports = { iniciarNotificationWorker };

'use strict';

const hostinger = require('../api/hostinger');
const { obtenerCliente } = require('../whatsapp/client');
const { enviarUno } = require('../whatsapp/sender');

// Control anti-ban diario
let mensajesEnviadosHoy = 0;
let fechaContador = new Date().toDateString();
const MAX_DIA = parseInt(process.env.MAX_MENSAJES_DIA) || 150;

/**
 * Verifica si estamos en horario permitido de envío.
 * Lee HORA_INICIO_ENVIO y HORA_FIN_ENVIO del .env.
 * HORA_FIN_ENVIO=24:00 desactiva el límite superior (modo pruebas).
 */
function enHorarioPermitido() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const hI = parseInt(process.env.HORA_INICIO_ENVIO?.split(':')[0] ?? '7');
    const hF = parseInt(process.env.HORA_FIN_ENVIO?.split(':')[0] ?? '22');
    if (hF >= 24) return hora >= hI;   // sin límite superior
    return hora >= hI && hora < hF;
}

/**
 * Reinicia el contador diario si cambió el día
 */
function verificarContadorDiario() {
    const hoy = new Date().toDateString();
    if (hoy !== fechaContador) {
        mensajesEnviadosHoy = 0;
        fechaContador = hoy;
        console.log('🔄 Contador diario reiniciado.');
    }
}

/**
 * Obtiene campañas pendientes desde Hostinger (vía Router: API o Direct DB)
 */
async function obtenerPendientes() {
    return await hostinger.obtenerCampanasPendientes();
}

/**
 * Reporta el resultado de cada mensaje enviado a Hostinger
 */
async function reportarResultado(campanaId, destinatarioId, resultado, detalle) {
    try {
        await hostinger.reportarResultadoCampana(campanaId, destinatarioId, resultado, detalle);
        if (resultado === 'exito') mensajesEnviadosHoy++;
    } catch (err) {
        console.error('⚠️  Error reportando resultado:', err.message);
    }
}

/**
 * Genera una pausa aleatoria entre minMin y minMax MINUTOS
 * Distribución no uniforme: favorece pausas cortas (más natural)
 */
function pausaAleatoria(minMin, minMax) {
    // Usar raíz cuadrada para sesgar hacia pausas más cortas (más humano)
    const rnd = Math.random();
    const minutos = minMin + Math.pow(rnd, 1.5) * (minMax - minMin);
    const ms = Math.round(minutos * 60 * 1000);
    console.log(`⏳ Próximo envío en ${Math.round(minutos)} min...`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pausa corta cuando no hay mensajes pendientes (2 min)
 */
function pausaSinPendientes() {
    return new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
}

/**
 * Loop principal — corre indefinidamente con pausas aleatorias
 * Cada iteración: verificar → enviar 1 mensaje → esperar N min aleatorios
 */
async function loopCampanas() {
    const PAUSA_MIN = parseFloat(process.env.PAUSA_MIN_MINUTOS) || 8;   // mín. entre mensajes
    const PAUSA_MAX = parseFloat(process.env.PAUSA_MAX_MINUTOS) || 25;  // máx. entre mensajes

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            // Reiniciar contador si cambió el día
            const hoy = new Date().toDateString();
            if (hoy !== fechaContador) {
                mensajesEnviadosHoy = 0;
                fechaContador = hoy;
                console.log('🔄 Contador diario reiniciado.');
            }

            // Verificar horario permitido
            if (!enHorarioPermitido()) {
                console.log('🌙 Fuera del horario de envío. Esperando 2 min...');
                await pausaSinPendientes();
                continue;
            }

            // Verificar límite diario
            if (mensajesEnviadosHoy >= MAX_DIA) {
                console.log(`⚠️  Límite diario alcanzado (${MAX_DIA}). Esperando 5 min...`);
                await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                continue;
            }

            // Verificar que WhatsApp está conectado
            const client = obtenerCliente();
            if (!client || client.info === undefined) {
                await pausaSinPendientes();
                continue;
            }

            // Consultar 1 destinatario pendiente
            const data = await obtenerPendientes();

            if (!data.campanas || data.campanas.length === 0) {
                await pausaSinPendientes();
                continue;
            }

            // Tomar la primera campaña con destinatario disponible
            const campana = data.campanas[0];
            if (!campana.destinatarios || campana.destinatarios.length === 0) {
                await pausaSinPendientes();
                continue;
            }

            const dest = campana.destinatarios[0];
            console.log(`📨 Campaña #${campana.id}: enviando a ${dest.telefono} (${dest.nombre})`);

            // Enviar 1 mensaje
            await enviarUno(client, campana, dest, reportarResultado);

            // Pausa aleatoria ENTRE mensajes (8-25 minutos por defecto)
            await pausaAleatoria(PAUSA_MIN, PAUSA_MAX);

        } catch (err) {
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                console.error('⚠️  No se puede conectar a la API:', err.message);
            } else {
                console.error('❌ Error en el worker:', err.message);
            }
            await pausaSinPendientes();
        }
    }
}

/**
 * Inicia el worker — arranca el loop con retardo inicial de 5s
 */
function iniciarWorker() {
    const PAUSA_MIN = parseFloat(process.env.PAUSA_MIN_MINUTOS) || 8;
    const PAUSA_MAX = parseFloat(process.env.PAUSA_MAX_MINUTOS) || 25;
    console.log(`⏰ Worker de campañas iniciado — pausas aleatorias ${PAUSA_MIN}-${PAUSA_MAX} min entre mensajes`);
    setTimeout(() => loopCampanas(), 5000);
}

module.exports = { iniciarWorker };

# 🚀 DigitalOcean — Pitaya WhatsApp Service

Servicio de mensajería WhatsApp para Batidos Pitaya.
Arquitectura **multi-instancia**: cada número WhatsApp corre como proceso PM2 independiente en el mismo VPS.

---

## Arquitectura Triangular

```
ERP (erp.batidospitaya.com / Hostinger)
       ↓ escribe datos en BD MySQL
api.batidospitaya.com/api/wsp/   ← puente central (PHP)
api.batidospitaya.com/api/bot/   ← endpoints del PitayaBot (PHP)
       ↑ polling cada 60s
VPS DigitalOcean — múltiples instancias Node.js + whatsapp-web.js
   ├── wsp-clientes  :3001  → Campañas de marketing + Notificaciones transaccionales
   ├── wsp-crmbot    :3003  → Bot CRM automatizado
   └── wsp-pitayabot :3007  → Asistente virtual IA para colaboradores
       ↓ envía mensajes
WhatsApp Web
```

> **¿Por qué triangular?** Hostinger no permite conexiones salientes persistentes ni ejecutar Node.js. La API actúa de puente: el VPS hace polling, nunca el ERP.

---

## Estructura del repositorio

```
.github/workflows/deploy-vps.yml        # CI/CD: push → rsync al VPS → PM2 reload
scripts/
├── setup.sh                            # Instalación VPS Ubuntu (ejecutar UNA VEZ)
└── test_api_connection.js              # Diagnóstico: verifica conectividad VPS → API
wsp-clientes/                           # PM2 :3001 — Campañas + Notificaciones transaccionales
├── src/
│   ├── app.js                          # Arranca campaign_worker + notification_worker
│   ├── config/api.js
│   ├── whatsapp/  (client.js, sender.js)
│   └── workers/
│       ├── campaign_worker.js          # Worker campañas de marketing
│       └── notification_worker.js      # Worker notificaciones transaccionales (cada 15s)
├── .env.example
├── ecosystem.config.js                 # Config PM2 solo de esta instancia
└── package.json
wsp-crmbot/                             # PM2 :3003 — Bot CRM (AUTÓNOMA)
├── src/
│   ├── app.js
│   ├── config/api.js
│   ├── nlp/  (TF-IDF, Naive Bayes — exclusivo de este bot)
│   ├── whatsapp/  (client.js, sender.js)
│   └── workers/crm_bot_worker.js
├── .env.example
├── ecosystem.config.js
└── package.json
wsp-pitayabot/                          # PM2 :3007 — Asistente IA colaboradores (AUTÓNOMA)
├── src/
│   ├── app.js
│   ├── config/api.js
│   ├── whatsapp/  (client.js, sender.js)
│   └── workers/
├── .env.example
├── ecosystem.config.js
└── package.json
```

> **Principio de independencia:** Cada `wsp-*/src/` es completamente autónomo. No comparte archivos con ninguna otra instancia. Borrar una no afecta las demás.

### Estructura en el VPS

```
/var/www/
├── wsp-clientes/          # PM2: wsp-clientes :3001
│   ├── src/               # ← sincronizado desde GitHub
│   ├── .env               # NO en GitHub — configurar manualmente una vez
│   ├── .wwebjs_auth_wsp-clientes/  # Sesión WhatsApp — NO en GitHub
│   └── logs/
├── wsp-crmbot/            # PM2: wsp-crmbot :3003
│   ├── src/
│   ├── .env
│   └── logs/
└── wsp-pitayabot/         # PM2: wsp-pitayabot :3007
    ├── src/
    ├── .env
    └── logs/

/root/presupuestos-ferreterias/   # App independiente — NO es un bot WhatsApp
```

---

## Instancias activas

| Nombre PM2 | Puerto | Uso | STARTUP_DELAY_MS |
|-----------|--------|-----|-----------------|
| `wsp-pitayabot`  | 3007 | Asistente virtual IA para colaboradores | 5 000 ms |
| `wsp-crmbot`     | 3003 | Bot CRM automatizado con NLP | 90 000 ms |
| `wsp-clientes`   | 3001 | Campañas de marketing + Notificaciones transaccionales | 180 000 ms |
| `presupuestos-ferreterias` | — | App de presupuestos (no WhatsApp) | — |

> **Arranque escalonado obligatorio:** Los 3 Chrome no deben iniciar al mismo tiempo en un Droplet 1 vCPU. El `STARTUP_DELAY_MS` escala el inicio 0 → 90s → 180s para que el CPU se recupere entre cada inicialización.

---

## 🔴 Post-Mortem — Colapso de Droplet (Nov 2026)

> **Síntoma:** CPU al 100% permanente, SSH tardaba minutos en responder, todos los bots en loop de crash, `campanas_wsp.php` mostraba "Servicio inactivo".

### Causa raíz: Reacción en cadena por disco lleno

#### Fase 1 — Acumulación silenciosa de caché (meses)

Cada instancia Chrome guardaba datos en `.wwebjs_auth_*/session-*/Default/`:
- `Cache/`, `Code Cache/`, `GPUCache/`, `DawnCache/`, `ShaderCache/`

Sin depuración automática, estos directorios crecieron a **~3.2 GB totales**. Sumado a:
- `/var/log/journal` → 1.8 GB
- `~/.pm2/logs/` → 207 MB

El disco llegó al **85%** hasta que Chrome no pudo escribir más y crasheó.

#### Fase 2 — Loop de crash por `restart_delay` corto

Con `restart_delay: 10000` (10 s) y `max_restarts` ilimitado, PM2 reiniciaba Chrome cada 10 segundos. En un servidor 1 vCPU, levantar 3 Chrome casi simultáneamente colapsa la RAM (cada Chrome necesita ~400-500 MB al iniciar).

La RAM se agotó → el kernel usó SWAP en disco → Disk I/O 100-150 MB/s → CPU 100% → procesos Chrome quedaron como **zombis** sin poder cerrarse.

#### Fase 3 — Falso positivo del heartbeat (bug de código)

Una vez estabilizado el servidor, enviar **15 notificaciones acumuladas en lote** disparó el nuevo problema:
- `notification_worker` enviaba 15 mensajes × 2 s delay = ~30 s con Chrome ocupado
- El heartbeat (cada 60 s) llamaba `getState()` con timeout de 30 s
- Chrome no podía responder `getState()` mientras enviaba mensajes por WebSocket
- Heartbeat interpretaba "Chrome congelado" → `resetearSesion()` innecesario
- El reset reiniciaba Chrome → subía el CPU → más timeouts → loop

### Fixes aplicados al código

#### 1. `--disk-cache-size=0` y limpieza de caché al arrancar (`client.js`)

```js
// En puppeteer args:
'--disk-cache-size=0',
'--media-cache-size=0',
'--aggressive-cache-discard',
'--disable-application-cache'
```

```js
// Antes de cada clienteWA.initialize(), limpia los subdirectorios de caché:
const cacheSubdirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache'];
cacheSubdirs.forEach(dir => {
    const p = path.join(_authPath, `session-${_instancia}`, 'Default', dir);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
});
```

> ⚠️ La limpieza elimina **solo subdirectorios de caché**, nunca la carpeta de sesión completa. La sesión (cookies, credenciales) se conserva para no tener que reescanear QR.

#### 2. Arranque escalonado vía `STARTUP_DELAY_MS` (`app.js` + `ecosystem.config.js`)

```js
// app.js — delay antes de iniciar Chrome
const startupDelay = parseInt(process.env.STARTUP_DELAY_MS || '15000', 10);
await new Promise(r => setTimeout(r, startupDelay));
```

```js
// ecosystem.config.js — valores por instancia
env: {
    STARTUP_DELAY_MS: '180000'  // wsp-clientes espera 3 min
}
```

#### 3. PM2 `restart_delay` y `max_restarts` más conservadores (`ecosystem.config.js`)

```js
restart_delay: 60000,    // antes: 10000 — 60 s entre reinicios (evita crash loop)
max_restarts: 5,         // antes: 10
max_memory_restart: '400M'
```

#### 4. Contador de timeouts consecutivos — no reiniciar por pico temporal (`app.js`)

```js
// Requiere 3 TIMEOUT_GET_STATE seguidos antes de hacer reset
// Un pico de CPU que cause 1-2 timeouts se absorbe sin reiniciar Chrome
let _timeoutConsecutivos = 0;
const MAX_TIMEOUTS_ANTES_RESET = 3;

// En el catch del getState():
_timeoutConsecutivos++;
if (_timeoutConsecutivos >= MAX_TIMEOUTS_ANTES_RESET) {
    await resetearSesion(false);
}
// En el try exitoso:
_timeoutConsecutivos = 0;
```

#### 5. Heartbeat inteligente: skip `getState()` mientras se envían mensajes (`app.js` + `notification_worker.js`)

```js
// notification_worker.js expone:
function estaEnviandoNotificaciones() { return ejecutandoCicloNotif; }

// app.js — heartbeat salta el test de Chrome si está en envío activo:
if (estaEnviandoNotificaciones()) {
    logApp(`💓 Heartbeat — estado: conectado | engine: BUSY (enviando notificaciones)`);
    _timeoutConsecutivos = 0;
    await reportarEstadoVPS(estado, null);
    return; // No llamar getState()
}
```

#### 6. Watchdog de "atascado en inicializando" (`app.js`)

```js
// Si lleva más de 8 min en estado 'inicializando', fuerza un reset automático.
// Corrige el caso donde initialize() completa pero el evento 'ready' nunca llega.
let _inicializandoDesde = null;
const MAX_INICIALIZANDO_MS = 8 * 60 * 1000;

if (estado === 'inicializando') {
    if (!_inicializandoDesde) _inicializandoDesde = Date.now();
    const elapsed = Date.now() - _inicializandoDesde;
    if (elapsed > MAX_INICIALIZANDO_MS) {
        await resetearSesion(false); // reset sin borrar sesión
    }
    return;
} else {
    _inicializandoDesde = null;
}
```

### Fixes aplicados directamente en el Droplet (una vez)

```bash
# 1. Limpiar caché Chrome acumulada
find /var/www -name "Cache" -type d | xargs rm -rf
find /var/www -name "Code Cache" -type d | xargs rm -rf
find /var/www -name "GPUCache" -type d | xargs rm -rf

# 2. Rotar journal y logs PM2
journalctl --vacuum-time=3d
pm2 flush

# 3. Matar procesos Chrome zombis
pkill -9 -f chrome

# 4. Cron semanal de limpieza (ya configurado — no revertir)
# crontab -e → entrada:
# 0 3 * * 0 find /var/www -path "*/Default/Cache" -type d -exec rm -rf {} + 2>/dev/null; journalctl --vacuum-time=7d
```

> ✅ El cron semanal de limpieza **debe mantenerse** en el droplet. No revertir.

### Señales de alerta tempranas

| Señal | Qué hacer |
|-------|-----------|
| CPU > 80% sostenido por 5+ min | `pgrep -c chrome` — si > 8, hay zombis. `pkill -9 -f chrome` y `pm2 restart all` |
| SSH tarda 30+ seg en responder | El servidor está en swap thrash. Verificar `free -h`. Puede necesitar reboot. |
| `campanas_wsp.php` → "Servicio inactivo" | `pm2 logs wsp-clientes --lines 30` — buscar `TIMEOUT_GET_STATE`, `inicializando`, errores |
| Disk I/O > 50 MB/s sostenido | Chrome usando swap. `df -h /` — si > 70%, limpiar caché y journal |
| `pm2 status` muestra muchos reinicios (↺ > 10) | `pm2 logs <nombre> --lines 50` para ver el error raíz |

### Comandos de diagnóstico rápido

```bash
# Estado general del sistema
pm2 status
free -h
df -h /
pgrep -c chrome         # Chrome headless activos (normal: 3-6 por bot conectado)

# Ver qué está consumiendo CPU
top -bn1 | head -20

# Logs en tiempo real
pm2 logs wsp-clientes --lines 50

# Si el disco está lleno (> 80%)
du -sh /var/www/*/     # Ver qué directorio pesa más
du -sh /var/log/journal
du -sh ~/.pm2/logs/

# Limpiar en emergencia
pm2 flush                                    # Limpiar logs PM2
journalctl --vacuum-time=3d                 # Limpiar journal viejos
find /var/www -name "GPUCache" -type d -exec rm -rf {} + 2>/dev/null
pkill -9 -f chrome                          # Matar Chrome zombis
```

### Restauración de emergencia completa

Si el droplet está 100% bloqueado (SSH sin responder), usar la consola web de DigitalOcean:

```bash
# Paso 1 — Liberar recursos inmediatamente
pm2 stop all
pkill -9 -f chrome

# Paso 2 — Limpiar disco
journalctl --vacuum-time=3d
pm2 flush
find /var/www -path "*/Default/Cache" -type d -exec rm -rf {} + 2>/dev/null
find /var/www -path "*/Default/Code Cache" -type d -exec rm -rf {} + 2>/dev/null
find /var/www -path "*/Default/GPUCache" -type d -exec rm -rf {} + 2>/dev/null

# Paso 3 — Verificar espacio recuperado
df -h /
free -h

# Paso 4 — Reiniciar bots en orden
pm2 start /var/www/wsp-pitayabot/ecosystem.config.js
sleep 30
pm2 start /var/www/wsp-crmbot/ecosystem.config.js
sleep 90
pm2 start /var/www/wsp-clientes/ecosystem.config.js

pm2 save
```

---

## 🐛 Post-Mortem — Incidente "Servicio Desconectado" (21-Apr-2026)

> **Síntoma:** Todos los bots aparecían como "Desconectado" en el ERP a pesar de funcionar correctamente.

### Causa raíz: 3 bugs en cadena

#### Bug 1 — `CONVERT_TZ` incorrecto en `registrar_sesion.php` ⚠️ CRÍTICO

```sql
-- ❌ ANTES: restaba 6h adicionales (servidor MySQL ya está en CST)
CONVERT_TZ(NOW(), '+00:00', '-06:00')

-- ✅ DESPUÉS:
NOW()
```

#### Bug 2 — Filas duplicadas en `wsp_sesion_vps_` (UNIQUE KEY faltante)

```sql
-- Limpiar filas duplicadas (conservar la más reciente por instancia)
DELETE t1 FROM wsp_sesion_vps_ t1
INNER JOIN wsp_sesion_vps_ t2
  ON t1.instancia = t2.instancia
  AND t1.id < t2.id;

-- Agregar UNIQUE para evitar duplicados futuros
ALTER TABLE wsp_sesion_vps_ ADD UNIQUE KEY uq_instancia (instancia);
```

#### Bug 3 — ERP llamaba a `api.batidospitaya.com` directamente (caído tras migración proxy)

```php
// campanas_wsp_get_status.php — intenta proxy primero, api como fallback
$urls = [
    'proxy' => 'https://proxy.batidospitaya.com/api/wsp/status.php?instancia=wsp-clientes',
    'api'   => 'https://api.batidospitaya.com/api/wsp/status.php?instancia=wsp-clientes',
];
```

---

## Cómo agregar una nueva instancia

> **Todo desde GitHub. Cero SSH para código.** Solo se usa SSH una vez al crear la instancia.

### En GitHub (VS Code local)

1. Crear carpeta `wsp-nueva/` con su propio código:
   - `src/app.js` — importa el worker de esta instancia + heartbeat con watchdog
   - `src/workers/nuevo_worker.js` — lógica de polling a la API
   - `src/whatsapp/client.js`, `sender.js` — copiados y adaptados
   - `src/config/api.js`
   - `.env.example` — con `PORT=XXXX`, `WSP_INSTANCIA=wsp-nueva`, `STARTUP_DELAY_MS`
   - `ecosystem.config.js` — `restart_delay: 60000`, `max_restarts: 5`, `max_memory_restart: '400M'`
   - `package.json`

2. En `.github/workflows/deploy-vps.yml`, agregar bloque rsync y PM2 restart.

### En el VPS (SSH — solo una vez)

```bash
cd /var/www/wsp-nueva
npm install --production
cp .env.example .env && nano .env
# Llenar: WSP_TOKEN, PORT, WSP_INSTANCIA, STARTUP_DELAY_MS

sudo ufw allow XXXX/tcp
pm2 start ecosystem.config.js
pm2 save
```

### Checklist nueva instancia

- [ ] Puerto único no usado (3001, 3003, 3007…)
- [ ] **Abrir puerto en Firewall DigitalOcean** (Inbound TCP)
- [ ] **Abrir puerto en Firewall VPS (UFW)**: `sudo ufw allow XXXX/tcp`
- [ ] `STARTUP_DELAY_MS` escalonado (el último bot: mayor delay)
- [ ] Token único en `.env`
- [ ] `clientId` único en `client.js` → `LocalAuth({ clientId: 'wsp-nueva' })`
- [ ] `ecosystem.config.js` con `restart_delay: 60000` y `max_restarts: 5`
- [ ] Escanear QR para vincular número desde el ERP

---

## GitHub Secrets requeridos

| Secret | Valor |
|--------|-------|
| `DO_SSH_KEY` | Clave privada SSH del Droplet (id_ed25519) |
| `DO_HOST` | IP del Droplet: `198.211.97.243` |
| `DO_USER` | `root` |

---

## Setup inicial VPS (solo una vez para un Droplet nuevo)

```bash
ssh root@<IP_DROPLET>
bash /var/www/wsp-clientes/scripts/setup.sh
```

---

## Variables de entorno (.env por instancia)

```env
API_BASE_URL=https://api.batidospitaya.com
WSP_TOKEN=<token_unico_de_esta_instancia>
WSP_INSTANCIA=wsp-clientes
PORT=3001
STARTUP_DELAY_MS=180000       # ms a esperar antes de iniciar Chrome (escalonado)
HORA_INICIO_ENVIO=07:00
HORA_FIN_ENVIO=20:00
MAX_MENSAJES_DIA=150
MAX_MENSAJES_POR_HORA=50
DELAY_MIN_SEGUNDOS=8
DELAY_MAX_SEGUNDOS=25
```

---

## Anti-ban configurado

| Medida | Valor |
|--------|-------|
| Delay entre mensajes | 8–25s aleatorio |
| Máx. mensajes/día | 150–200 (configurable por `.env`) |
| Máx. mensajes/hora | 50 (configurable por `.env`) |
| Sesión persistente | `LocalAuth` — no re-escanea QR salvo desconexión |

---

## Endpoints de la API Bridge (`api.batidospitaya.com/api/wsp/`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `ping.php` | GET | No | Health check |
| `status.php` | GET | No | Estado VPS |
| `pendientes.php` | GET | Token | Campañas pendientes |
| `actualizar.php` | POST | Token | VPS reporta resultado por destinatario |
| `registrar_sesion.php` | POST | Token | Heartbeat + estado + QR base64 |

## Endpoints del VPS (Llamados por el ERP)

| Endpoint | Método | Puerto | Descripción |
|----------|--------|--------|-------------|
| `/health` | GET | 300X | Verifica si Express está vivo |
| `/status` | GET | 300X | Estado interno y QR |
| `/send` | POST | 300X | Envío manual (CRM) |
| `/ping` | POST | 300X | Prueba de conexión |
| `/reset` | POST | 300X | Fuerza cierre y nuevo QR |

---

## Comandos PM2 de referencia

```bash
pm2 status                                  # Ver todas las instancias activas
pm2 logs wsp-clientes --lines 30            # Logs de una instancia
pm2 restart wsp-clientes --update-env       # Reiniciar recargando .env
pm2 stop wsp-clientes                       # Detener sin afectar otras
pm2 delete wsp-clientes                     # Eliminar instancia de PM2
pm2 save                                    # Persistir lista de procesos actual
free -h                                     # Verificar RAM y swap
curl http://localhost:3001/health           # Health check interno
```

```bash
# Si la sesión WhatsApp se corrompió — forzar nuevo QR
pm2 stop wsp-clientes
rm -rf /var/www/wsp-clientes/.wwebjs_auth_wsp-clientes
pm2 restart wsp-clientes --update-env
# Escanear QR desde el ERP
```

---

## Cambio de Número WhatsApp

```
ERP → clic "Cambiar Número"
    ↓ AJAX escribe reset_solicitado = 1 en wsp_sesion_vps_
    ↓ badge cambia a 🟠 "Cambiando número..."
    ↓ ~60s
VPS worker → detecta reset_solicitado = 1 en heartbeat
    ↓ client.destroy() → rm -rf .wwebjs_auth → reinicia
    ↓ genera nuevo QR
ERP → modal QR abre automáticamente
    ↓ usuario escanea con nuevo número
badge → 🟢 Conectado
```

### Estados del badge

| Estado | Color | Significado |
|--------|-------|-------------|
| `conectado` | 🟢 Verde | WhatsApp vinculado y listo |
| `qr_pendiente` | 🟡 Amarillo | Esperando escaneo QR |
| `inicializando` | 🔵 Azul | Cargando — normal hasta 5 min |
| `desconectado` | 🔴 Rojo | VPS caído o sin heartbeat >3 min |

---

## 🔴 Problemas conocidos en producción

### 1. Chromium Snap no funciona como root (Ubuntu 24.04)

**Síntoma:** `Command '/usr/bin/chromium-browser' requires the chromium snap to be installed`

**Solución:** Instalar Google Chrome `.deb` oficial:
```bash
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt install -y /tmp/chrome.deb
```

`client.js` detecta automáticamente el navegador en este orden:
```
/usr/bin/google-chrome-stable → /usr/bin/google-chrome → /usr/bin/chromium
```

---

### 2. `--single-process` crashea Chrome moderno

**Causa:** Flag deprecado. Combinado con `--no-zygote` provoca crash inmediato.

**Args correctos y completos para VPS Ubuntu (root):**
```js
args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-zygote', '--no-first-run',
    '--disable-extensions', '--disable-background-networking', '--disable-breakpad',
    '--disable-component-update', '--disable-domain-reliability', '--disable-sync',
    '--disable-translate', '--metrics-recording-only', '--mute-audio',
    '--no-default-browser-check',
    '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
    // Anti-throttling (obligatorio para evitar Zombie Bot)
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Anti-acumulación de caché en disco
    '--disk-cache-size=0', '--media-cache-size=0',
    '--aggressive-cache-discard', '--disable-application-cache'
]
```

---

### 3. RAM insuficiente en Droplet 1GB con 3 bots Chrome

**Causa:** Cada Chrome necesita ~400-500 MB al iniciar.

**Solución mínima — 2GB de swap:**
```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Optimización obligatoria — `swappiness=10`:**
```bash
sysctl vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

> Con `swappiness=60` (default) el kernel empieza a usar swap con 40% de RAM libre. Con `=10` solo lo hace cuando queda ~10%. Esto evita swap thrash y SSH tardando minutos.

**Señal de alerta:**
```bash
free -m          # Swap > 80%?
dmesg | grep -i oom  # ¿OOM Killer mató algún proceso?
```

> Para 3+ instancias Chrome simultáneas, **se recomienda upgrade a Droplet 2GB RAM** (~$6/mes adicionales). Elimina todos los problemas de CPU/OOM de raíz.

---

### 4. Badge ERP muestra "Desconectado" / "Servicio inactivo"

**Verificación rápida:**
```bash
# 1. ¿El bot está corriendo?
pm2 status

# 2. ¿El heartbeat está actualizando la BD?
curl -s "https://proxy.batidospitaya.com/api/wsp/status.php?instancia=wsp-clientes"
# → revisar seg_desde_ping: si > 180, el heartbeat no llega a la BD

# 3. ¿Qué dice el log?
pm2 logs wsp-clientes --lines 30 --nostream
```

**Causas frecuentes:**
- Bot en estado `inicializando` por > 3 min → watchdog lo auto-recupera a los 8 min
- `ultimo_ping` desactualizado por error de conexión MySQL → transitorio, se recupera solo
- Bot crasheado y PM2 en `restart_delay` → esperar 60 s y verificar de nuevo

---

### 5. Imágenes fallan — "Invalid URL"

**Causa:** `imagen_url` guardada como ruta relativa en la BD.

**Solución en `pendientes.php`:**
```php
if (!empty($campana['imagen_url']) && str_starts_with($campana['imagen_url'], '/')) {
    $campana['imagen_url'] = 'https://erp.batidospitaya.com' . $campana['imagen_url'];
}
```

---

### 6. Desconexión silenciosa tras inactividad (Zombie Bot)

**Causa:** Chrome aplica background throttling a pestañas headless.

**Solución ya implementada:**
1. Flags `--disable-background-timer-throttling` etc. en `client.js`
2. `sendPresenceAvailable()` cada 60s en el heartbeat
3. `getState()` cada 60s con timeout para detectar congelamiento

---

### 7. `🌙 Fuera del horario de envío` — `.env` no actualiza con `pm2 restart`

**Causa:** `pm2 restart` sin `--update-env` no recarga el `.env`.

**Solución:**
```bash
pm2 restart wsp-clientes --update-env
```

Y en código usar `??` en lugar de `||` para valores de hora:
```js
const hI = parseInt(process.env.HORA_INICIO_ENVIO?.split(':')[0] ?? '7');
```

---

### 8. `stuck in inicializando` — evento `ready` nunca llega

**Síntoma:** `💓 Heartbeat — estado: inicializando | engine: N/A` por más de 5 minutos.

**Causa A — CPU saturado:** Chrome está sincronizando WhatsApp Web pero el servidor no tiene recursos para completar la carga JavaScript en tiempo razonable. Puede tardar 3-10 min en un Droplet 1GB sobrecargado.

**Causa B — Incompatibilidad Chrome/whatsapp-web.js:** Chrome se actualizó automáticamente. El evento `loading_screen` **nunca aparece** entre `authenticated` y el timeout.

**Diagnóstico:**
```bash
# ¿Aparece loading_screen en logs? Si nunca aparece → Causa B (incompatibilidad)
pm2 logs wsp-clientes --lines 50 --nostream | grep -E "loading_screen|authenticated|ready"

# Versión de Chrome
google-chrome-stable --version
```

**Solución Causa A** (el watchdog de 8 min ya lo maneja automáticamente):
```bash
# Si necesitas forzarlo manualmente:
pm2 restart wsp-clientes
```

**Solución Causa B — reinstall limpio:**
```bash
pm2 stop wsp-clientes
cd /var/www/wsp-clientes
rm -rf node_modules package-lock.json
npm install --production
pm2 restart wsp-clientes --update-env
```

**Prevenir auto-actualización de Chrome:**
```bash
apt-mark hold google-chrome-stable
# Para actualizar manualmente cuando quieras:
apt-mark unhold google-chrome-stable && apt upgrade google-chrome-stable
```

---

### 9. Notificaciones transaccionales marcadas como `error` durante reset de Chrome

**Causa:** El `notification_worker` seguía ejecutando su loop de envío cuando Chrome se reiniciaba, y marcaba los mensajes no enviados como `error` en la BD.

**Solución ya implementada en `notification_worker.js`:**
- Verifica `obtenerEstadoActual() !== 'conectado'` antes de cada envío
- Detecta errores de Chrome muerto (`detached Frame`, `Target closed`, `Protocol error`)
- Si Chrome muere mid-loop, **hace `break` sin marcar como `error`** → quedan como `pendiente` para reintento automático en el próximo ciclo de 15s

---

### 10. `Target closed` / `Browser closed` / OOM Killer

**Causa:** Chrome matado por el kernel por memoria insuficiente.

**Diagnóstico:**
```bash
dmesg | grep -i oom
free -h
```

**Fix:** Verificar swap activo, `--disable-gpu` y `--no-sandbox` presentes, considerar upgrade del Droplet.

---

### 11. Mantenimiento de Chrome y whatsapp-web.js

```bash
# Actualizar Chrome (solo cuando sea necesario — ver punto 8)
apt-mark unhold google-chrome-stable
apt update && apt install --only-upgrade google-chrome-stable
apt-mark hold google-chrome-stable

# Actualizar whatsapp-web.js
cd /var/www/wsp-clientes
rm -rf node_modules package-lock.json
npm install --production
pm2 restart wsp-clientes --update-env

# Rotar logs PM2
pm2 install pm2-logrotate
```

---

### 12. `SyntaxError: Identifier 'WSP_INSTANCIA' has already been declared`

**Causa:** Al añadir un bloque nuevo que importa `WSP_INSTANCIA` con `const { WSP_INSTANCIA } = require(...)`, si el archivo ya tenía esa misma declaración más abajo, Node.js lanza SyntaxError.

**Solución:** Usar `process.env.WSP_INSTANCIA` directamente en el nuevo bloque, sin redeclarar:
```js
const _instancia = process.env.WSP_INSTANCIA || 'wsp-clientes';
```

---

### 13. GitHub Actions hace `pm2 restart` que no recarga `ecosystem.config.js`

**Problema:** `pm2 restart <name> --update-env` no recarga cambios en `env:` del `ecosystem.config.js`. Solo recarga variables del `.env`.

**Para que surtan efecto los cambios de ecosystem:**
```bash
pm2 delete wsp-clientes
pm2 start /var/www/wsp-clientes/ecosystem.config.js
pm2 save
```

---

### 14. `reset_solicitado = 1` loop infinito

**Causa:** El botón "Cambiar Número" en el ERP escribe `reset_solicitado = 1`. Si el bot lo lee, borra la sesión y se reinicia, pero si la tabla no tiene la fila del bot (fue borrada), el próximo insert la crea con `reset_solicitado = 1` por defecto y el bot queda en loop eterno.

**Solución vía phpMyAdmin:**
```sql
UPDATE wsp_sesion_vps_ SET reset_solicitado = 0 WHERE instancia = 'wsp-clientes';
```

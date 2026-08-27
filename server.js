const express = require('express');
const { Pool } = require('pg');
const { HDNodeWallet, JsonRpcProvider, id, formatUnits, getAddress } = require('ethers');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

function normalizarEnlaceTelegram(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    let candidate = raw;
    if (candidate.startsWith('@')) candidate = `https://t.me/${candidate.slice(1)}`;
    else if (!/^https?:\/\//i.test(candidate)) candidate = `https://t.me/${candidate.replace(/^\/+/, '')}`;
    let parsed;
    try { parsed = new URL(candidate); } catch (_) { throw new Error('El contacto de Telegram no es válido'); }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!['t.me', 'telegram.me'].includes(host) || !parsed.pathname || parsed.pathname === '/') {
        throw new Error('El enlace debe pertenecer a t.me o telegram.me');
    }
    return parsed.toString();
}

const DIAS_ACTIVOS_DEFAULT = [1, 2, 3, 4, 5];
function normalizarDiasActivos(value) {
    let lista = value;
    if (typeof lista === 'string') {
        try { lista = JSON.parse(lista); } catch (_) { lista = lista.split(','); }
    }
    if (!Array.isArray(lista)) return DIAS_ACTIVOS_DEFAULT.slice();
    const salida = [...new Set(lista.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    return salida.length ? salida : DIAS_ACTIVOS_DEFAULT.slice();
}
function obtenerDiaSemanaLima(date = new Date()) {
    const nombre = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', weekday: 'short' }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nombre);
}
function normalizarFechaLima(value) {
    if (!value) return null;
    const texto = String(value);
    const iso = texto.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const fecha = new Date(value);
    if (Number.isNaN(fecha.getTime())) return null;
    const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(fecha);
    const out = {};
    partes.forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
    return out.year && out.month && out.day ? `${out.year}-${out.month}-${out.day}` : null;
}
async function ensureTaskColumns() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                minimo_retiro NUMERIC(18,6) DEFAULT 10,
                comision_retiro_porcentaje NUMERIC(8,4) DEFAULT 23,
                telegram_soporte_url TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            ALTER TABLE configuracion
            ADD COLUMN IF NOT EXISTS tareas_config JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP,
            ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS tareas_activacion_dia DATE,
            ADD COLUMN IF NOT EXISTS tareas_dias_activos JSONB DEFAULT '[1,2,3,4,5]'::jsonb,
            ADD COLUMN IF NOT EXISTS juegos_config JSONB DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00',
            ADD COLUMN IF NOT EXISTS minimo_retiro NUMERIC(18,6) DEFAULT 10,
            ADD COLUMN IF NOT EXISTS comision_retiro_porcentaje NUMERIC(8,4) DEFAULT 23,
            ADD COLUMN IF NOT EXISTS telegram_soporte_url TEXT DEFAULT ''
        `);
        await pool.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS tareas_completadas_hoy JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS ultima_fecha_tareas TEXT,
            ADD COLUMN IF NOT EXISTS racha_dias INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS cobro_tareas_fecha DATE,
            ADD COLUMN IF NOT EXISTS cobro_tareas_monto NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS plan_activo BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS nivel_autorizado INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS wallet_index INTEGER,
            ADD COLUMN IF NOT EXISTS wallet_created_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS admin_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS admin_active BOOLEAN NOT NULL DEFAULT TRUE
        `);
        await pool.query(`
            ALTER TABLE configuracion
            ADD COLUMN IF NOT EXISTS tareas_config JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS tareas_activacion DATE,
            ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS deposit_scanned_block BIGINT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS minimo_retiro NUMERIC(18,6) DEFAULT 10,
            ADD COLUMN IF NOT EXISTS comision_retiro_porcentaje NUMERIC(8,4) DEFAULT 23,
            ADD COLUMN IF NOT EXISTS telegram_soporte_url TEXT DEFAULT ''
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS polygon_deposits (
                id BIGSERIAL PRIMARY KEY,
                tx_hash TEXT NOT NULL,
                log_index INTEGER NOT NULL DEFAULT 0,
                user_id INTEGER NOT NULL REFERENCES users(id),
                token_contract TEXT NOT NULL,
                from_address TEXT NOT NULL,
                to_address TEXT NOT NULL,
                amount NUMERIC(36, 18) NOT NULL,
                block_number BIGINT NOT NULL,
                confirmations INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                credited_at TIMESTAMPTZ,
                raw_log JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tx_hash, log_index)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_polygon_deposits_user ON polygon_deposits(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_polygon_deposits_status ON polygon_deposits(status)');
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_polygon_deposits_tx_log ON polygon_deposits(tx_hash, log_index)');
    } catch (error) {
        console.error('Error preparando columnas de tareas:', error.message);
    }
}

// ============================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }
        
        req.user = result.rows[0];
        req.userId = decoded.userId;
        next();
    } catch (error) {
        console.error('Error en autenticación:', error);
        return res.status(401).json({ error: 'Token inválido' });
    }
};

// ============================================================
// MIDDLEWARE PARA VERIFICAR SI ES ADMIN
// ============================================================
const ADMIN_PERMISSIONS = ['usuarios', 'tareas', 'actividades', 'depositos', 'retiros', 'configuracion', 'notificaciones', 'minijuegos', 'referidos'];
function normalizarPermisos(value) {
    const source = value && typeof value === 'object' ? value : {};
    return ADMIN_PERMISSIONS.reduce((out, key) => { out[key] = source[key] === true; return out; }, {});
}
function flagTrue(value) {
    return value === true || value === 1 || ['true', '1', 't', 'yes', 'si'].includes(String(value ?? '').trim().toLowerCase());
}
function flagActive(value) {
    return value !== false && !['false', '0', 'f', 'no'].includes(String(value ?? '').trim().toLowerCase());
}
function tienePermisoAdmin(user, permission) {
    if (!user || !flagTrue(user.es_admin) || !flagActive(user.admin_active)) return false;
    if (flagTrue(user.es_super_admin)) return true;
    return normalizarPermisos(user.admin_permissions)[permission] === true;
}
function permisoRequeridoParaRuta(req) {
    const path = String(req.path || '');
    if (/deposit/i.test(path)) return 'depositos';
    if (/notification/i.test(path)) return 'notificaciones';
    if (/minigame|game/i.test(path)) return 'minijuegos';
    if (/task|tarea/i.test(path)) return 'tareas';
    if (/withdraw|retiro|canje/i.test(path)) return 'retiros';
    if (/config|catalog|code|codigo/i.test(path)) return 'configuracion';
    if (/activ|premio|logro|cupon/i.test(path)) return 'actividades';
    if (/refer/i.test(path)) return 'referidos';
    if (/user|usuario/i.test(path)) return 'usuarios';
    return null;
}
const isAdmin = async (req, res, next) => {
    if (!req.user || !flagTrue(req.user.es_admin) || !flagActive(req.user.admin_active)) {
        return res.status(403).json({ error: 'Acceso denegado. Se requieren privilegios de administrador.' });
    }
    // Cuentas antiguas sin permisos configurados conservan compatibilidad total.
    const configured = req.user.admin_permissions && typeof req.user.admin_permissions === 'object' && Object.keys(req.user.admin_permissions).length > 0;
    const required = permisoRequeridoParaRuta(req);
    if (configured && required && !tienePermisoAdmin(req.user, required)) {
        return res.status(403).json({ error: `Acceso denegado. Tu Sub-Admin no tiene permiso para el módulo ${required}.` });
    }
    next();
};
const requireSuperAdmin = [authenticate, async (req, res, next) => {
    if (!req.user || !flagTrue(req.user.es_super_admin) || !flagActive(req.user.admin_active)) {
        return res.status(403).json({ error: 'Solo el SuperAdmin puede realizar esta acción.' });
    }
    next();
}];

// Conexión a NeonTech
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

ensureTaskColumns();

async function ensureNotificationTable() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            tipo TEXT NOT NULL,
            titulo TEXT NOT NULL,
            descripcion TEXT NOT NULL DEFAULT '',
            accion TEXT NOT NULL DEFAULT 'informativa',
            entidad_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            leido BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)');
    } catch (error) { console.error('Error preparando notificaciones:', error.message); }
}
ensureNotificationTable();
async function crearNotificacion({ userId = null, tipo, titulo, descripcion = '', accion = 'informativa', entidadId = null, metadata = {} }) {
    if (!tipo || !titulo) return null;
    const result = await pool.query(`INSERT INTO notifications (user_id, tipo, titulo, descripcion, accion, entidad_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`, [userId, String(tipo), String(titulo), String(descripcion), String(accion), entidadId == null ? null : String(entidadId), JSON.stringify(metadata || {})]);
    return result.rows[0];
}

function derivarDireccionDeposito(walletIndex) {
    const mnemonic = String(process.env.APEX_DEPOSIT_MNEMONIC || '').trim();
    if (!mnemonic) throw new Error('APEX_DEPOSIT_MNEMONIC no está configurada en Render');
    return HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/" + Number(walletIndex)).address;
}
async function asegurarBilleteraUsuario(userId) {
    const actual = await pool.query('SELECT id, polygon_address, wallet_index FROM users WHERE id = $1', [userId]);
    if (!actual.rows.length) throw new Error('Usuario no encontrado');
    const row = actual.rows[0];
    if (row.polygon_address && row.wallet_index !== null && row.wallet_index !== undefined) return row;
    const address = derivarDireccionDeposito(Number(row.id));
    const saved = await pool.query('UPDATE users SET polygon_address = $1, wallet_index = $2, wallet_created_at = COALESCE(wallet_created_at, NOW()) WHERE id = $3 RETURNING id, polygon_address, wallet_index, wallet_created_at', [address, Number(row.id), userId]);
    return saved.rows[0];
}

// ============================================================
// MONITOR DE DEPÓSITOS USDT0 EN POLYGON MAINNET
// ============================================================
const DEPOSIT_MONITOR_VERSION = 'v17-skip-invalid-addresses-alchemy-idempotent';
const POLYGON_TOKEN_CONTRACT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'.toLowerCase();
const POLYGON_TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const POLYGON_TOKEN_DECIMALS = 6;
const DEPOSIT_CONFIRMATIONS = Math.max(1, Number(process.env.DEPOSIT_CONFIRMATIONS || 10));
const DEPOSIT_SCAN_INTERVAL_MS = Math.max(30000, Number(process.env.DEPOSIT_SCAN_INTERVAL_MS || 60000));
const POLYGON_RPC_URLS = String(process.env.POLYGON_RPC_URLS || process.env.POLYGON_RPC_URL || 'https://rpc.ankr.com/polygon,https://polygon.publicnode.com,https://polygon.drpc.org').split(',').map(x => x.trim()).filter(Boolean);
let activeRpcUrl = null;
let monitorRunning = false;
async function rpcCall(method, params) {
    const configuredUrls = method.startsWith('alchemy_') ? POLYGON_RPC_URLS.filter(x => /alchemy\.com/i.test(x)) : POLYGON_RPC_URLS;
    const urls = activeRpcUrl && configuredUrls.includes(activeRpcUrl) ? [activeRpcUrl, ...configuredUrls.filter(x => x !== activeRpcUrl)] : configuredUrls;
    let lastError;
    for (const rpcUrl of urls) {
        try {
            const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
            const raw = await response.text();
            let body;
            try { body = JSON.parse(raw); } catch (_) { body = { error: { message: raw.slice(0, 500) } }; }
            if (!response.ok || body.error) throw new Error(`${body.error?.message || raw.slice(0, 500) || `HTTP ${response.status}`} [${method}]`);
            activeRpcUrl = rpcUrl;
            return body.result;
        } catch (error) { lastError = error; if (activeRpcUrl === rpcUrl) activeRpcUrl = null; }
    }
    throw new Error(`${method}: ${lastError?.message || 'sin RPC disponible'}`);
}
function topicAddress(topic) { return getAddress('0x' + String(topic).slice(-40)).toLowerCase(); }
async function rpcGetLogs(filter) {
    const payload = {
        jsonrpc: '2.0',
        id: Date.now() + Math.floor(Math.random() * 1000),
        method: 'eth_getLogs',
        params: [{
            address: filter.address,
            topics: filter.topics,
            fromBlock: '0x' + Number(filter.fromBlock).toString(16),
            toBlock: '0x' + Number(filter.toBlock).toString(16)
        }]
    };
    const result = await rpcCall(payload.method, payload.params);
    return Array.isArray(result) ? result : [];
}
async function acreditarDeposito(deposito) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM polygon_deposits WHERE id = $1 FOR UPDATE', [deposito.id]);
        if (!locked.rows.length || locked.rows[0].status === 'credited') { await client.query('ROLLBACK'); return false; }
        const d = locked.rows[0];
        const u = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [d.user_id]);
        if (!u.rows.length) throw new Error('Usuario del depósito no encontrado');
        const user = u.rows[0], amount = Number(d.amount || 0), history = Array.isArray(user.historial_detallado) ? user.historial_detallado : [];
        history.push({ tipo: 'deposito', concepto: 'Depósito USDT0 confirmado en Polygon', monto: amount, tx_hash: d.tx_hash, fecha: new Date().toISOString(), estado: 'confirmado', red: 'Polygon Mainnet' });
        await client.query('UPDATE users SET balance = COALESCE(balance,0) + $1, historial_detallado = $2 WHERE id = $3', [amount, JSON.stringify(history), d.user_id]);
        await client.query("UPDATE polygon_deposits SET status = 'credited', credited_at = NOW(), updated_at = NOW() WHERE id = $1", [d.id]);
        await client.query('COMMIT');
        try { await crearNotificacion({ userId: d.user_id, tipo: 'deposito', titulo: 'Depósito acreditado', descripcion: `${amount} USDT0 acreditados en tu saldo`, accion: 'informativa', entidadId: `${d.tx_hash}:${d.log_index}`, metadata: { tx_hash: d.tx_hash, amount, network: 'Polygon Mainnet' } }); } catch (notificationError) { console.error('No se pudo crear notificación de depósito:', notificationError.message); }
        console.log(`Depósito acreditado: ${amount} USDT0 para usuario ${d.user_id}, tx ${d.tx_hash}`);
        return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}
async function obtenerTransferenciasAlchemy(toAddress, fromBlock, toBlock) {
    const transfers = [];
    const maxRange = 1000;
    for (let chunkStart = Math.max(0, fromBlock); chunkStart <= toBlock; chunkStart += maxRange) {
        const chunkEnd = Math.min(toBlock, chunkStart + maxRange - 1);
        let pageKey;
        do {
            const params = {
                fromBlock: '0x' + chunkStart.toString(16),
                toBlock: '0x' + chunkEnd.toString(16),
                toAddress,
                category: ['erc20'],
                contractAddresses: [POLYGON_TOKEN_CONTRACT],
                excludeZeroValue: true,
                withMetadata: false,
                maxCount: '0x3e8'
            };
            if (pageKey) params.pageKey = pageKey;
            console.log(`Monitor Polygon: consultando alchemy_getAssetTransfers ${chunkStart}-${chunkEnd} para ${toAddress}`);
            const result = await rpcCall('alchemy_getAssetTransfers', [params]);
            if (Array.isArray(result?.transfers)) transfers.push(...result.transfers);
            pageKey = result?.pageKey || null;
        } while (pageKey);
    }
    return transfers;
}
async function obtenerLogTransferVerificado(txHash, toAddress) {
    const receipt = await rpcCall('eth_getTransactionReceipt', [txHash]);
    if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return null;
    const wantedTo = String(toAddress).toLowerCase();
    for (const log of receipt.logs) {
        if (String(log.address || '').toLowerCase() !== POLYGON_TOKEN_CONTRACT) continue;
        if (!Array.isArray(log.topics) || log.topics.length < 3 || String(log.topics[0]).toLowerCase() !== POLYGON_TRANSFER_TOPIC.toLowerCase()) continue;
        let to;
        try { to = topicAddress(log.topics[2]); } catch (_) { continue; }
        if (to !== wantedTo) continue;
        let from;
        try { from = topicAddress(log.topics[1]); } catch (_) { from = '0x0000000000000000000000000000000000000000'; }
        return { log, from, to, logIndex: parseInt(log.logIndex || log.index || '0x0', 16), blockNumber: parseInt(receipt.blockNumber || '0x0', 16), blockHash: receipt.blockHash };
    }
    return null;
}
async function monitorDepositosPolygon() {
    if (monitorRunning) return;
    monitorRunning = true;
    if (!process.env.APEX_DEPOSIT_MNEMONIC) { monitorRunning = false; console.warn('Monitor Polygon detenido: falta APEX_DEPOSIT_MNEMONIC'); return; }
    try {
        await ensureTaskColumns();
        const latest = parseInt(await rpcCall('eth_blockNumber', []), 16);
        const configuredLookback = Number(process.env.DEPOSIT_LOOKBACK_BLOCKS || 50000);
        const lookback = Math.min(50000, Math.max(100, Number.isFinite(configuredLookback) ? configuredLookback : 50000));
        const fromBlock = Math.max(0, latest - lookback), toBlock = latest;
        const users = await pool.query("SELECT id, LOWER(polygon_address) AS polygon_address FROM users WHERE polygon_address IS NOT NULL AND polygon_address LIKE '0x%'");
        const validAddress = /^0x[a-f0-9]{40}$/i;
        const invalidUsers = users.rows.filter(u => !validAddress.test(String(u.polygon_address || '')));
        if (invalidUsers.length) console.warn(`Monitor Polygon: ${invalidUsers.length} dirección(es) inválida(s) ignorada(s): ${invalidUsers.map(u => `usuario ${u.id} (${String(u.polygon_address).slice(0, 18)}...)`).join(', ')}`);
        const addressMap = new Map(users.rows.filter(u => validAddress.test(String(u.polygon_address || ''))).map(u => [String(u.polygon_address).toLowerCase(), u.id]));
        if (addressMap.size) {
            console.log(`Monitor Polygon: Transfers API hacia ${addressMap.size} dirección(es), rango ${fromBlock}-${toBlock}`);
            let detected = 0;
            for (const [address, userId] of addressMap.entries()) {
                const transfers = await obtenerTransferenciasAlchemy(address, fromBlock, toBlock);
                for (const transfer of transfers) {
                    const txHash = transfer.hash;
                    if (!txHash) continue;
                    const verified = await obtenerLogTransferVerificado(txHash, address);
                    if (!verified) continue;
                    const amount = Number(transfer.value || 0);
                    if (!(amount > 0)) continue;
                    const inserted = await pool.query(`INSERT INTO polygon_deposits (tx_hash, log_index, user_id, token_contract, from_address, to_address, amount, block_number, confirmations, status, raw_log) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10::jsonb) ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`, [txHash, verified.logIndex, userId, POLYGON_TOKEN_CONTRACT, verified.from, verified.to, amount, verified.blockNumber, Math.max(0, latest - verified.blockNumber + 1), JSON.stringify({ blockHash: verified.blockHash, topics: verified.log.topics, data: verified.log.data, source: 'alchemy_getAssetTransfers' })]);
                    if (inserted.rows.length) { detected++; console.log(`Depósito detectado: ${amount} USDT0 para usuario ${userId}, tx ${txHash}, log_index ${verified.logIndex}`); }
                }
            }
            if (detected) console.log(`Monitor Polygon: ${detected} depósito(s) nuevo(s) registrado(s)`);
            console.log(`Monitor Polygon: Transfers API completada (${fromBlock}-${toBlock})`);
        }
        const pending = await pool.query("SELECT * FROM polygon_deposits WHERE status = 'pending' AND token_contract = $1", [POLYGON_TOKEN_CONTRACT]);
        for (const d of pending.rows) {
            const confirmations = Math.max(0, latest - Number(d.block_number) + 1);
            await pool.query('UPDATE polygon_deposits SET confirmations = $1, updated_at = NOW() WHERE id = $2', [confirmations, d.id]);
            if (confirmations >= DEPOSIT_CONFIRMATIONS) await acreditarDeposito(d);
        }
    } catch (error) { console.error('Monitor Polygon:', error.message); }
    finally { monitorRunning = false; }
}
setTimeout(function(){ console.log(`Monitor Polygon ${DEPOSIT_MONITOR_VERSION}: Alchemy Transfers API + eth_getTransactionReceipt, contrato ${POLYGON_TOKEN_CONTRACT}`); monitorDepositosPolygon(); setInterval(monitorDepositosPolygon, DEPOSIT_SCAN_INTERVAL_MS); }, 12000);

// ============================================================
// RUTAS PÚBLICAS
// ============================================================

app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});
app.get('/api/deposit-monitor-status', (req, res) => {
  res.json({ version: DEPOSIT_MONITOR_VERSION, rpc_mode: 'alchemy_getAssetTransfers_chunked_plus_eth_getTransactionReceipt', rpc_endpoints: POLYGON_RPC_URLS.map(x => { try { return new URL(x).host; } catch (_) { return 'invalid'; } }), batch_size: 500, lookback_blocks: Math.min(50000, Math.max(100, Number.isFinite(Number(process.env.DEPOSIT_LOOKBACK_BLOCKS || 50000)) ? Number(process.env.DEPOSIT_LOOKBACK_BLOCKS || 50000) : 50000)), token_contract: POLYGON_TOKEN_CONTRACT, confirmations: DEPOSIT_CONFIRMATIONS });
});

app.get('/test', (req, res) => {
  res.json({ mensaje: 'Backend funcionando correctamente' });
});

// ============================================================
// NOTIFICACIONES PERSISTENTES
// ============================================================
app.get('/api/admin/notifications', authenticate, isAdmin, async (req, res) => {
    try {
        await ensureNotificationTable();
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
        const r = await pool.query(`SELECT n.*, u.nombre AS usuario, u.apellido, u.telefono FROM notifications n LEFT JOIN users u ON u.id=n.user_id ORDER BY n.created_at DESC LIMIT $1`, [limit]);
        res.json({ notifications: r.rows });
    } catch (e) { console.error('Error cargando notificaciones admin:', e); res.status(500).json({ error: 'No se pudieron cargar las notificaciones' }); }
});
app.get('/api/user/notifications', authenticate, async (req, res) => {
    try {
        await ensureNotificationTable();
        const r = await pool.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.userId]);
        res.json({ notifications: r.rows });
    } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las notificaciones' }); }
});
app.patch('/api/admin/notifications/:id/read', authenticate, isAdmin, async (req, res) => {
    try { const r = await pool.query('UPDATE notifications SET leido=TRUE WHERE id=$1 RETURNING *', [req.params.id]); if (!r.rows.length) return res.status(404).json({error:'Notificación no encontrada'}); res.json({notification:r.rows[0]}); }
    catch (e) { res.status(500).json({error:'No se pudo marcar la notificación'}); }
});
app.patch('/api/user/notifications/:id/read', authenticate, async (req, res) => {
    try { const r = await pool.query('UPDATE notifications SET leido=TRUE WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, req.userId]); if (!r.rows.length) return res.status(404).json({error:'Notificación no encontrada'}); res.json({notification:r.rows[0]}); }
    catch (e) { res.status(500).json({error:'No se pudo marcar la notificación'}); }
});
app.post('/api/admin/notifications/read-all', authenticate, isAdmin, async (req, res) => {
    try { await pool.query('UPDATE notifications SET leido=TRUE WHERE leido=FALSE'); res.json({message:'Notificaciones marcadas como leídas'}); }
    catch (e) { res.status(500).json({error:'No se pudieron marcar las notificaciones'}); }
});
app.delete('/api/admin/notifications', authenticate, isAdmin, async (req, res) => {
    try { await pool.query('DELETE FROM notifications'); res.json({message:'Notificaciones eliminadas'}); }
    catch (e) { res.status(500).json({error:'No se pudieron eliminar las notificaciones'}); }
});

// Registro persistente de depósitos para el panel administrativo.
app.get('/api/admin/deposits', authenticate, isAdmin, async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
        const result = await pool.query(`
            SELECT d.id, d.user_id, d.tx_hash, d.log_index, d.amount,
                   d.block_number, d.confirmations, d.status,
                   d.token_contract, d.created_at, d.credited_at,
                   u.nombre, u.apellido, u.telefono, u.polygon_address
            FROM polygon_deposits d
            LEFT JOIN users u ON u.id = d.user_id
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT $1
        `, [limit]);
        res.json({ deposits: result.rows });
    } catch (e) {
        console.error('Error cargando depósitos admin:', e.message);
        res.status(500).json({ error: 'No se pudo cargar el registro de depósitos' });
    }
});

// ============================================================
// GESTIÓN DE SUB-ADMINS: SOLO SUPERADMIN
// ============================================================
app.get('/api/superadmin/admins', ...requireSuperAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, telefono, nombre, apellido, username,
            es_admin, es_super_admin, admin_permissions, admin_active, fecha_registro
            FROM users WHERE es_admin = TRUE ORDER BY es_super_admin DESC, id ASC`);
        res.json({ admins: result.rows.map(row => ({ ...row, admin_permissions: normalizarPermisos(row.admin_permissions) })) });
    } catch (error) {
        console.error('Error listando administradores:', error);
        res.status(500).json({ error: 'No se pudieron cargar los administradores' });
    }
});
app.post('/api/superadmin/admins', ...requireSuperAdmin, async (req, res) => {
    try {
        const { telefono, nombre, apellido = '', password, password_retiro = '000000', username = null, permissions = {} } = req.body || {};
        if (!telefono || !nombre || !password || String(password).length < 6) {
            return res.status(400).json({ error: 'Teléfono, nombre y contraseña de mínimo 6 caracteres son obligatorios.' });
        }
        if (!/^\d{6,15}$/.test(String(telefono))) return res.status(400).json({ error: 'El teléfono debe contener entre 6 y 15 dígitos.' });
        const normalizedUsername = username ? String(username).trim() : null;
        const exists = await pool.query('SELECT id FROM users WHERE telefono = $1 OR ($2::text IS NOT NULL AND username = $2)', [String(telefono), normalizedUsername]);
        if (exists.rows.length) return res.status(409).json({ error: 'El teléfono o nombre de usuario ya está registrado.' });
        const hashedPassword = await bcrypt.hash(String(password), 10);
        const hashedWithdrawPassword = await bcrypt.hash(String(password_retiro), 10);
        const referralCode = 'APEXADM' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const result = await pool.query(`INSERT INTO users
            (telefono, nombre, apellido, username, password_hash, password_retiro_hash,
             es_admin, es_super_admin, admin_permissions, admin_active, codigo_referido,
             balance, puntos, plan, plan_amount, daily_earnings, cuenta_habilitada,
             referidos, fechas_invito, historial, historial_detallado, historial_codigos,
             codigos_usados, cupones_asignados, logros_asignados, logros_pendientes_aprobar,
             tareas_asignadas, canjes_realizados, logros_reclamados, referidos_directos)
            VALUES ($1,$2,$3,$4,$5,$6,TRUE,FALSE,$7::jsonb,TRUE,$8,0,0,'Sin plan',0,0,TRUE,
                    '{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                    '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb)
            RETURNING id, telefono, nombre, apellido, username, es_admin, es_super_admin, admin_permissions, admin_active`,
            [String(telefono), String(nombre).trim(), String(apellido).trim(), normalizedUsername, hashedPassword, hashedWithdrawPassword, JSON.stringify(normalizarPermisos(permissions)), referralCode]);
        res.status(201).json({ message: 'Sub-Admin creado correctamente', admin: result.rows[0] });
    } catch (error) {
        console.error('Error creando Sub-Admin:', error);
        res.status(500).json({ error: 'No se pudo crear el Sub-Admin. Verifica la estructura de users.' });
    }
});
app.put('/api/superadmin/admins/:id', ...requireSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
        const target = await pool.query('SELECT id, es_super_admin FROM users WHERE id = $1', [id]);
        if (!target.rows.length) return res.status(404).json({ error: 'Administrador no encontrado.' });
        if (target.rows[0].es_super_admin) return res.status(400).json({ error: 'El SuperAdmin principal no se puede degradar.' });
        const fields = []; const values = []; let n = 1;
        if (req.body.permissions !== undefined) { fields.push(`admin_permissions = $${n++}::jsonb`); values.push(JSON.stringify(normalizarPermisos(req.body.permissions))); }
        if (req.body.active !== undefined) { fields.push(`admin_active = $${n++}`); values.push(Boolean(req.body.active)); }
        if (req.body.password) { fields.push(`password_hash = $${n++}`); values.push(await bcrypt.hash(String(req.body.password), 10)); }
        if (!fields.length) return res.status(400).json({ error: 'No hay cambios para guardar.' });
        values.push(id);
        const result = await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${n} RETURNING id, telefono, nombre, apellido, username, es_admin, es_super_admin, admin_permissions, admin_active`, values);
        res.json({ message: 'Permisos actualizados correctamente', admin: result.rows[0] });
    } catch (error) {
        console.error('Error actualizando Sub-Admin:', error);
        res.status(500).json({ error: 'No se pudieron guardar los permisos.' });
    }
});
app.delete('/api/superadmin/admins/:id', ...requireSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const result = await pool.query(`UPDATE users SET es_admin=FALSE, es_super_admin=FALSE, admin_active=FALSE, admin_permissions='{}'::jsonb WHERE id=$1 AND es_super_admin=FALSE RETURNING id`, [id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Sub-Admin no encontrado o no se puede retirar.' });
        res.json({ message: 'Privilegios de Sub-Admin retirados.' });
    } catch (error) {
        console.error('Error retirando Sub-Admin:', error);
        res.status(500).json({ error: 'No se pudo retirar el Sub-Admin.' });
    }
});
// ============================================================
// REGISTRO - CON TODA LA LÓGICA DE REFERIDOS
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { telefono, nombre, apellido, password, passRetiro, codigoInv } = req.body;
    
    // Validaciones
    if (!telefono || !nombre || !apellido || !password || !passRetiro) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
    }
    if (!/^\d{6}$/.test(passRetiro)) {
      return res.status(400).json({ error: 'La contraseña de retiro debe ser 6 dígitos' });
    }

    // Verificar si el teléfono ya está registrado
    const userExists = await pool.query(
      'SELECT * FROM users WHERE telefono = $1',
      [telefono]
    );
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: '⚠️ Este teléfono ya está registrado' });
    }

    // Determinar si es administrador
    const esAdmin = (codigoInv === 'Eamb1714');

    // Generar código de referido
    const referralCodeGenerated = 'APEX' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // La dirección se deriva después de obtener el ID real del usuario.
    const walletAddress = null;

    // Hashear contraseñas
    const hashedPassword = await bcrypt.hash(password, 10);
    const hashedWithdrawPassword = await bcrypt.hash(passRetiro, 10);

    // ============================================================
// PROCESAR CÓDIGO DE INVITACIÓN (VERSIÓN ORIGINAL - FUNCIONA)
// ============================================================
let referidoData = {
  izquierda: null,
  derecha: null,
  lista: []
};
let fechasInvito = {
  primero: null,
  segundo: null,
  fechaRegistro: new Date().toISOString(),
  fechaPrimerPlan: null
};
var telefonoReferidor = null;

if (codigoInv && codigoInv !== 'Eamb1714') {
  const referidoResult = await pool.query(
    'SELECT * FROM users WHERE UPPER(TRIM(codigo_referido)) = UPPER(TRIM($1))',
    [codigoInv]
  );
  
  if (referidoResult.rows.length > 0) {
    const referido = referidoResult.rows[0];
    telefonoReferidor = referido.telefono;
    let lado = '';
    
    // Obtener referidos actuales
    let referidosActuales = referido.referidos || { izquierda: null, derecha: null, lista: [] };
    
    // Asignar lado
    if (!referidosActuales.izquierda) {
      referidosActuales.izquierda = telefono;
      fechasInvito.primero = new Date().toISOString();
      lado = 'izquierda';
    } else if (!referidosActuales.derecha) {
      referidosActuales.derecha = telefono;
      fechasInvito.segundo = new Date().toISOString();
      lado = 'derecha';
    } else {
      // TERCERO: se agrega a la lista pero sin lado (como referido indirecto)
      lado = 'indirecto';
    }

    // Agregar a la lista de referidos SIEMPRE (incluso el tercero)
    if (!referidosActuales.lista) referidosActuales.lista = [];
    referidosActuales.lista.push({
      id: telefono,
      nombre: nombre + ' ' + apellido,
      date: new Date().toISOString(),
      lado: lado,
      commission: 0,
      activo: false  // POR DEFECTO NO ACTIVO (Admin lo activa)
    });

    // Guardar referidos actualizados
    await pool.query(
      'UPDATE users SET referidos = $1 WHERE id = $2',
      [JSON.stringify(referidosActuales), referido.id]
    );

    referidoData = referidosActuales;
  }
}

    // ============================================================
    // CREAR USUARIO CON TODOS LOS DATOS
    // ============================================================
    const result = await pool.query(
    `INSERT INTO users 
     (telefono, nombre, apellido, password_hash, password_retiro_hash, 
      es_admin, codigo_referido, polygon_address, balance, puntos, 
      plan, plan_amount, daily_earnings, cuenta_habilitada, 
      produccion_pausada, produccion_activa, direccion_retiro, 
      direccion_retiro_bloqueada, referidos, fechas_invito, verificado,
      historial, historial_detallado, historial_codigos, codigos_usados,
      codigos_usados_hoy, ultimo_reinicio_codigos, ruleta_usos, cofres_usos,
      dados_usos, premio_ruleta, premio_cofre, premio_dados, cofres_abiertos,
      cupones_asignados, logros_asignados, logros_pendientes_aprobar,
      tareas_asignadas, canjes_realizados, logros_reclamados,
      referidos_directos, descuentoRetiroActivo, check_in_realizado,
      fecha_registro, referido_por)  
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45) 
     RETURNING *`,
    [
        telefono, nombre, apellido, hashedPassword, hashedWithdrawPassword,
        esAdmin, referralCodeGenerated, walletAddress, 0, 0,
        'Sin plan', 0, 0, true,
        false, false, null, false,
        JSON.stringify({ izquierda: null, derecha: null, lista: [] }),
        JSON.stringify(fechasInvito),
        JSON.stringify({ izquierdaCompleto: false, derechaCompleto: false, puedeUsarCodigo: true }),
        JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
        0, null, 0, 0, 0, 0, 0, 0,
        JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
        JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
        JSON.stringify({ izquierda: null, derecha: null }),
        JSON.stringify(null), null,
        new Date().toISOString(),
        telefonoReferidor   
    ]
);

    // Generar token JWT
    const token = jwt.sign(
      { userId: result.rows[0].id, telefono: telefono, role: esAdmin ? 'admin' : 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    let walletData = null;
    try { walletData = await asegurarBilleteraUsuario(result.rows[0].id); }
    catch (walletError) { console.error('No se pudo derivar wallet del usuario:', walletError.message); }
    const mensaje = esAdmin ? '✅ Registro exitoso como ADMINISTRADOR!' : '✅ Registro exitoso!';
    res.status(201).json({
    message: mensaje,
    token: token,
    user: {
        id: result.rows[0].id,
        telefono: telefono,
        nombre: nombre,
        apellido: apellido,
        es_admin: esAdmin,
        codigo_referido: referralCodeGenerated,
        polygon_address: walletData ? walletData.polygon_address : null,
        balance: 0,
        puntos: 0,
        plan: 'Sin plan',
        referidos: referidoData  
    }
});

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error en el servidor: ' + error.message });
  }
});

// ============================================================
// DATOS PÚBLICOS COMPLETOS DEL USUARIO
// ============================================================
function publicUserData(row, referidosOverride) {
    const { password_hash, password_retiro_hash, password, ...safe } = row || {};
    return {
        ...safe,
        balance: Number(safe.balance || 0),
        puntos: Number(safe.puntos || 0),
        plan: safe.plan || 'Sin plan',
        plan_amount: Number(safe.plan_amount || 0),
        daily_earnings: Number(safe.daily_earnings || 0),
        plan_activo: safe.plan_activo !== false,
        cuenta_habilitada: safe.cuenta_habilitada !== false,
        produccion_pausada: Boolean(safe.produccion_pausada),
        nivel_autorizado: Number(safe.nivel_autorizado || 0),
        historial: Array.isArray(safe.historial) ? safe.historial : [],
        historial_detallado: Array.isArray(safe.historial_detallado) ? safe.historial_detallado : [],
        tareas_asignadas: Array.isArray(safe.tareas_asignadas) ? safe.tareas_asignadas : [],
        cupones_asignados: Array.isArray(safe.cupones_asignados) ? safe.cupones_asignados : [],
        logros_asignados: Array.isArray(safe.logros_asignados) ? safe.logros_asignados : [],
        logros_pendientes_aprobar: Array.isArray(safe.logros_pendientes_aprobar) ? safe.logros_pendientes_aprobar : [],
        canjes_realizados: Array.isArray(safe.canjes_realizados) ? safe.canjes_realizados : [],
        logros_reclamados: Array.isArray(safe.logros_reclamados) ? safe.logros_reclamados : [],
        tareas_completadas_hoy: Array.isArray(safe.tareas_completadas_hoy) ? safe.tareas_completadas_hoy : [],
        referidos: referidosOverride || safe.referidos || { izquierda: null, derecha: null, lista: [] },
        es_admin: flagTrue(safe.es_admin),
        es_super_admin: flagTrue(safe.es_super_admin),
        admin_active: flagActive(safe.admin_active)
    };
}
// ============================================================
// LOGIN
// ============================================================
app.post('/api/login', async (req, res) => {
  try {
    const { telefono, password } = req.body;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE telefono = $1',
      [telefono]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    const user = result.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    const token = jwt.sign(
      { userId: user.id, telefono: user.telefono, role: user.es_admin ? 'admin' : 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
    message: 'Login exitoso',
    token,
    user: publicUserData(user)
});
    
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// ============================================================
// VERIFICAR TOKEN
// ============================================================
app.get('/api/verify', authenticate, async (req, res) => {
    try {
        const hoyTareasLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        await pool.query(`UPDATE users SET tareas_completadas_hoy = '[]'::jsonb, ultima_fecha_tareas = $1, cobro_tareas_fecha = NULL, cobro_tareas_monto = 0 WHERE id = $2 AND (ultima_fecha_tareas IS NULL OR ultima_fecha_tareas <> $1)`, [hoyTareasLima, req.userId]);
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
                const userData = result.rows[0];
        const withdrawalConfigResult = await pool.query('SELECT minimo_retiro, comision_retiro_porcentaje, telegram_soporte_url FROM configuracion WHERE id = 1');
        const withdrawalConfigRow = withdrawalConfigResult.rows[0] || {};
        const withdrawalConfig = {
            minimo_retiro: Number(withdrawalConfigRow.minimo_retiro ?? 10),
            comision_retiro_porcentaje: Number(withdrawalConfigRow.comision_retiro_porcentaje ?? 23),
            telegram_soporte_url: String(withdrawalConfigRow.telegram_soporte_url || '')
        };
        const referralsVerify = await pool.query(`
            SELECT id, telefono, nombre, apellido, plan, plan_amount, daily_earnings, fecha_registro, referido_por
            FROM users
            WHERE referido_por = $1
               OR LOWER(TRIM(COALESCE(referido_por, ''))) = LOWER(TRIM($2))
            ORDER BY fecha_registro ASC NULLS LAST, id ASC
        `, [userData.telefono, userData.codigo_referido || '']);
        const referidosEnriquecidos = referralsVerify.rows.map(r => ({
            id: r.telefono,
            telefono: r.telefono,
            nombre: [r.nombre, r.apellido].filter(Boolean).join(' '),
            plan: r.plan || 'Sin plan',
            plan_nombre: r.plan || null,
            plan_actual: r.plan || null,
            plan_amount: Number(r.plan_amount || 0),
            daily_earnings: Number(r.daily_earnings || 0),
            tienePlan: Boolean((r.plan && !['sin plan','sin_plan','null','undefined','ninguno'].includes(String(r.plan).trim().toLowerCase())) || Number(r.plan_amount || 0) > 0 || Number(r.daily_earnings || 0) > 0),
            date: r.fecha_registro,
            referido_por: r.referido_por
        }));
        res.json({ 
            user: publicUserData(userData, { izquierda: null, derecha: null, lista: referidosEnriquecidos }),
            withdrawal_config: withdrawalConfig
        });
    } catch (error) {
        console.error('Error en /api/verify:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ============================================================
// SESIÓN ADMINISTRATIVA
// ============================================================
app.get('/api/admin/session', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = result.rows[0];
    res.json({ user: publicUserData(user), role: user.es_super_admin === true ? 'superadmin' : 'admin' });
  } catch (error) {
    console.error('Error en /api/admin/session:', error.message);
    res.status(500).json({ error: 'No se pudo verificar la sesión administrativa' });
  }
});

// ============================================================
// RUTAS PROTEGIDAS
// ============================================================
app.get('/api/me/wallet', authenticate, async (req, res) => {
  try {
    const wallet = await asegurarBilleteraUsuario(req.userId);
    res.json({ wallet: wallet.polygon_address, index: wallet.wallet_index, created_at: wallet.wallet_created_at, network: 'polygon-mainnet', token_contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' });
  } catch (error) {
    console.error('Error en /api/me/wallet:', error.message);
    res.status(503).json({ error: 'No se pudo preparar la billetera de depósito' });
  }
});
app.get('/api/me/deposits', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, tx_hash, amount, block_number, confirmations, status, created_at, credited_at FROM polygon_deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.userId]);
    res.json({ deposits: result.rows });
  } catch (error) {
    console.error('Error en /api/me/deposits:', error.message);
    res.status(500).json({ error: 'No se pudo cargar el historial de depósitos' });
  }
});
app.post('/api/me/deposits/sync', authenticate, async (req, res) => {
  try {
    await monitorDepositosPolygon();
    const result = await pool.query('SELECT id, tx_hash, amount, block_number, confirmations, status, created_at, credited_at FROM polygon_deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.userId]);
    res.json({ message: 'Sincronización ejecutada', deposits: result.rows });
  } catch (error) {
    console.error('Error sincronizando depósitos:', error.message);
    res.status(503).json({ error: 'No se pudo sincronizar el depósito' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(String(id))) {
      return res.status(404).json({ error: 'Ruta de usuario no válida' });
    }
    
    const result = await pool.query(
      'SELECT id, telefono, nombre, apellido, es_admin, codigo_referido, polygon_address, balance, puntos, plan FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json(result.rows[0]);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

app.get('/api/prizes', async (req, res) => {
  try {
    res.json([]);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// ============================================================
// ACTUALIZAR DATOS DEL USUARIO (NUEVA RUTA)
// ============================================================
app.put('/api/user/update', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;
        
        const updates = { ...req.body };
        const solicitaProgresoDiario = Object.prototype.hasOwnProperty.call(updates, 'tareas_completadas_hoy') || Object.prototype.hasOwnProperty.call(updates, 'ultima_fecha_tareas') || Object.prototype.hasOwnProperty.call(updates, 'cobro_tareas_fecha');
        if (solicitaProgresoDiario) {
            const cfg = await pool.query('SELECT tareas_activacion, tareas_pausadas, tareas_autorizadas, tareas_dias_activos FROM configuracion WHERE id = 1');
            const cfgRow = cfg.rows[0] || {};
            const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
            const valorActivacion = cfgRow.tareas_activacion;
            const fechaActivacion = valorActivacion ? (String(valorActivacion).match(/^\\d{4}-\\d{2}-\\d{2}$/) ? String(valorActivacion).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(valorActivacion))) : null;
            const diaAutorizado = cfgRow.tareas_pausadas !== true && normalizarDiasActivos(cfgRow.tareas_dias_activos).includes(obtenerDiaSemanaLima());
            if (!diaAutorizado) {
                delete updates.tareas_completadas_hoy;
                delete updates.ultima_fecha_tareas;
                delete updates.cobro_tareas_fecha;
                delete updates.cobro_tareas_monto;
                delete updates.racha_dias;
            }
        }
        if (updates.password) {
            updates.password_hash = await bcrypt.hash(String(updates.password), 10);
            delete updates.password;
        }
        if (updates.password_retiro) {
            updates.password_retiro_hash = await bcrypt.hash(String(updates.password_retiro), 10);
            delete updates.password_retiro;
        }
        delete updates.username;
        
        // Construir consulta dinámica
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            // ✅ AGREGAR 'codigos_usados_hoy' y 'ultimo_reinicio_codigos'
            const camposPermitidos = ['balance', 'puntos', 'plan', 'plan_amount', 'daily_earnings', 
                'produccion_activa', 'produccion_inicio', 'produccion_duracion', 'tiempo_restante',
                'recompensa_pendiente', 'puntosPendientes', 'codigo_usado', 'reclamado_hoy',
                'fecha_produccion', 'codigos_usados_hoy', 'codigos_usados', 'ultimo_reinicio_codigos',
                'ruleta_usos', 'cofres_usos', 'dados_usos', 'premio_ruleta', 'premio_cofre', 'premio_dados',
                'cofres_abiertos', 'cupones_asignados', 'logros_asignados', 'logros_pendientes_aprobar',
                'tareas_asignadas', 'tareas_completadas_hoy', 'ultima_fecha_tareas',
                'racha_dias', 'cobro_tareas_fecha', 'cobro_tareas_monto',
                'canjes_realizados', 'logros_reclamados', 'referidos',
                'referidos_directos', 'fechas_invito', 'historial', 'historial_detallado',
                'historial_codigos', 'descuentoRetiroActivo', 'bonusReferidoActivo',
                'direccion_retiro', 'password_retiro',
                'cuenta_habilitada', 'produccion_pausada', 'nivel_autorizado', 'es_admin', 'es_super_admin'
            ];
            
            if (camposPermitidos.includes(key)) {
                fields.push(`${key} = $${paramCount}`);
                if (typeof value === 'object' && value !== null) {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(value);
                }
                paramCount++;
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No hay datos para actualizar' });
        }
        
        values.push(userId);
        const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        
        const result = await pool.query(query, values);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
        // ✅ Enviar TODOS los campos del usuario
        const userData = result.rows[0];
        res.json({ 
            message: 'Usuario actualizado exitosamente', 
            user: {
                id: userData.id,
                telefono: userData.telefono,
                nombre: userData.nombre,
                apellido: userData.apellido,
                es_admin: userData.es_admin,
                es_super_admin: userData.es_super_admin || false,
                codigo_referido: userData.codigo_referido,
                polygon_address: userData.polygon_address,
                balance: Number(userData.balance || 0),
                puntos: Number(userData.puntos || 0),
                plan: userData.plan || 'Sin plan',
                plan_amount: Number(userData.plan_amount || 0),
                daily_earnings: Number(userData.daily_earnings || 0),
                username: userData.username || null,
                password_retiro: userData.password_retiro || userData.password_retiro_hash || '000000',
                direccion_retiro: userData.direccion_retiro || null,
                nivel_autorizado: Number(userData.nivel_autorizado || 0),
                cuenta_habilitada: userData.cuenta_habilitada,
                produccion_pausada: userData.produccion_pausada || false,
                
                codigos_usados_hoy: Number(userData.codigos_usados_hoy || 0),
                ultimo_reinicio_codigos: userData.ultimo_reinicio_codigos || null,
                codigos_usados: userData.codigos_usados || [],
                referidos: userData.referidos || { izquierda: null, derecha: null, lista: [] },
                tareas_completadas_hoy: Array.isArray(userData.tareas_completadas_hoy) ? userData.tareas_completadas_hoy : [],
                ultima_fecha_tareas: userData.ultima_fecha_tareas || null,
                racha_dias: Number(userData.racha_dias || 0),
                cobro_tareas_fecha: userData.cobro_tareas_fecha || null,
                cobro_tareas_monto: Number(userData.cobro_tareas_monto || 0)
            }
        });
        
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});
// ============================================================
// REFERIDOS DEL USUARIO AUTENTICADO
// ============================================================
app.get('/api/user/referrals', authenticate, async (req, res) => {
    try {
        const owner = await pool.query('SELECT id, telefono, codigo_referido, referidos FROM users WHERE id = $1', [req.userId]);
        if (!owner.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        const u = owner.rows[0];
        const stored = u.referidos && typeof u.referidos === 'object' ? u.referidos : { izquierda: null, derecha: null, lista: [] };
        const storedPhones = (Array.isArray(stored.lista) ? stored.lista : []).map(x => x && x.id ? String(x.id) : null).filter(Boolean);
        [stored.izquierda, stored.derecha].forEach(x => { if (x) storedPhones.push(String(x)); });
        const result = await pool.query(`
            SELECT id, telefono, nombre, apellido, plan, plan_amount, daily_earnings,
                   cuenta_habilitada, fecha_registro, referido_por
            FROM users
            WHERE referido_por = $1
               OR LOWER(TRIM(COALESCE(referido_por, ''))) = LOWER(TRIM($2))
               OR telefono = ANY($3::text[])
            ORDER BY fecha_registro ASC NULLS LAST, id ASC
        `, [u.telefono, u.codigo_referido || '', storedPhones]);
        const byPhone = new Map();
        (Array.isArray(stored.lista) ? stored.lista : []).forEach(x => { if (x && x.id) byPhone.set(String(x.id), x); });
        result.rows.forEach(r => byPhone.set(String(r.telefono), {
            id: r.telefono,
            telefono: r.telefono,
            nombre: [r.nombre, r.apellido].filter(Boolean).join(' '),
            plan: r.plan || 'Sin plan',
            plan_nombre: r.plan || null,
            plan_actual: r.plan || null,
            plan_amount: Number(r.plan_amount || 0),
            daily_earnings: Number(r.daily_earnings || 0),
            tienePlan: Boolean((r.plan && !['sin plan','null','undefined','ninguno'].includes(String(r.plan).trim().toLowerCase())) || Number(r.plan_amount || 0) > 0 || Number(r.daily_earnings || 0) > 0),
            date: r.fecha_registro,
            referido_por: r.referido_por,
            activo: r.cuenta_habilitada !== false
        }));
        res.json({
            codigo_referido: u.codigo_referido || null,
            referidos: Array.from(byPhone.values()),
            arbol: stored
        });
    } catch (error) {
        console.error('Error al cargar referidos:', error);
        res.status(500).json({ error: 'No se pudieron cargar los referidos' });
    }
});

// ============================================================
// CONFIGURACIÓN CENTRALIZADA DE TAREAS
// ============================================================
function normalizarPlan(plan) {
    const value = String(plan || '').trim().toLowerCase();
    const match = Object.keys(PLANES_APEX || {}).find(function(name) {
        return name.toLowerCase() === value || value.includes(name.toLowerCase());
    });
    return match || null;
}

const tareasPorDefecto = [
    { id: 'tarea_1', hora: 10, minuto: 0, nombre: 'Tarea 1', icono: '🌅', activo: true },
    { id: 'tarea_2', hora: 12, minuto: 0, nombre: 'Tarea 2', icono: '☀️', activo: true },
    { id: 'tarea_3', hora: 14, minuto: 0, nombre: 'Tarea 3', icono: '🌤️', activo: true },
    { id: 'tarea_4', hora: 16, minuto: 0, nombre: 'Tarea 4', icono: '🌥️', activo: true },
    { id: 'tarea_5', hora: 18, minuto: 0, nombre: 'Tarea 5', icono: '🌆', activo: true }
];

app.get('/api/games/config', authenticate, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS juegos_config JSONB DEFAULT '{}'::jsonb`);
        const r = await pool.query('SELECT juegos_config FROM configuracion WHERE id = 1');
        const cfg = (r.rows[0] && r.rows[0].juegos_config) || {};
        res.json({ ruleta: cfg.ruleta || { premios: [10,15,20,30,50,0] }, cofres: cfg.cofres || { premios: [5,8,10,12,15,20,25,30,50] }, dados: cfg.dados || { premios: [5,10,15,20,25,30] } });
    } catch (e) { console.error('Error config juegos:', e); res.status(500).json({error:'Error obteniendo premios'}); }
});
app.put('/api/admin/games/config', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS juegos_config JSONB DEFAULT '{}'::jsonb`);
        const cfg = req.body || {};
        const r = await pool.query(`INSERT INTO configuracion (id,juegos_config,updated_at) VALUES (1,$1,NOW()) ON CONFLICT (id) DO UPDATE SET juegos_config=$1,updated_at=NOW() RETURNING juegos_config`, [JSON.stringify(cfg)]);
        res.json({message:'Premios guardados', config:r.rows[0].juegos_config});
    } catch (e) { console.error('Error guardando premios:', e); res.status(500).json({error:'Error guardando premios'}); }
});

// ============================================================
// BIBLIOTECA DE 500 MINI JUEGOS / 100 PAQUETES DIARIOS
// ============================================================
const MINI_GAME_TYPES = ['captcha','sequence','target','reaction','pair','count','oddone','order','color','math','pattern','memorypos','tap','safe','connect','quiz','compare','slider','sort','chase'];
const MINI_GAME_ICONS = ['🚀','💎','⚡','🌟','🎯','🪙','🧠','🏆','🔷','🛡️','🔢','🔍','📈','🎨','🧩','🧭','🔗','❓','⚖️','🎚️'];
function construirBibliotecaMiniJuegos(){
    const lista=[];
    const nombres={captcha:'Código de acceso',sequence:'Secuencia relámpago',target:'Objetivo oculto',reaction:'Pulso de reflejos',pair:'Parejas de memoria',count:'Cuenta exacta',oddone:'Encuentra el diferente',order:'Orden numérico',color:'Color correcto',math:'Cálculo rápido',pattern:'Patrón lógico',memorypos:'Memoria de posición',tap:'Toques precisos',safe:'Zona segura',connect:'Conecta iguales',quiz:'Pregunta relámpago',compare:'El mayor gana',slider:'Barra de precisión',sort:'Clasificación rápida',chase:'Persigue el objetivo'};
    const ayuda={captcha:['Escribe el código que aparece en pantalla.','El código generado que se muestra al usuario.'],sequence:['Memoriza la secuencia y repítela en el mismo orden.','La misma secuencia de 4 emojis, sin cambiar el orden.'],target:['Encuentra y pulsa el símbolo objetivo entre los distractores.','El símbolo indicado en la parte superior del reto.'],reaction:['Espera la señal verde y pulsa el botón cuando aparezca.','Pulsar únicamente después de que la señal se vuelva verde.'],pair:['Descubre dos cartas y encuentra una pareja de emojis iguales.','Dos cartas que tengan exactamente el mismo emoji.'],count:['Cuenta los símbolos solicitados y escribe el total.','El número exacto de símbolos mostrados.'],oddone:['Encuentra el único símbolo diferente en la cuadrícula.','La posición marcada como diferente.'],order:['Pulsa los números en orden ascendente.','La secuencia de menor a mayor.'],color:['Pulsa el recuadro del color solicitado.','El recuadro que coincide con el color indicado.'],math:['Resuelve la operación que aparece.','El resultado exacto de la operación.'],pattern:['Completa el patrón seleccionando el elemento que falta.','La opción que continúa correctamente el patrón.'],memorypos:['Memoriza dónde aparece el símbolo y selecciónalo después.','La misma posición donde apareció el símbolo.'],tap:['Pulsa los objetivos luminosos antes de que desaparezcan.','Completar los tres toques correctos.'],safe:['Elige una zona segura entre las opciones.','La casilla marcada como zona segura.'],connect:['Relaciona el símbolo con su pareja equivalente.','La pareja que contiene el mismo símbolo.'],quiz:['Responde la pregunta seleccionando una opción.','La opción correcta de la pregunta.'],compare:['Selecciona el número mayor.','El número de mayor valor.'],slider:['Detén la barra en la zona objetivo.','El indicador dentro de la zona verde.'],sort:['Selecciona los elementos del menor al mayor.','El orden ascendente completo.'],chase:['Pulsa el objetivo que aparece en la zona de juego.','El objetivo resaltado antes de cambiar de posición.']};
    for(let i=1;i<=500;i++){
        const tipo=MINI_GAME_TYPES[(i-1)%MINI_GAME_TYPES.length],variante=Math.floor((i-1)/MINI_GAME_TYPES.length)+1,info=ayuda[tipo];
        lista.push({id:i,nombre:nombres[tipo]+' #'+variante,descripcion:'Reto interactivo '+i+' de la biblioteca APEX',icono:MINI_GAME_ICONS[(i-1)%MINI_GAME_ICONS.length],tipo_interactivo:tipo,variante:variante,instruccion:info[0],respuesta:info[1]});
    }
    return lista;
}
function construirPaquetesMiniJuegos(){
    const biblioteca=construirBibliotecaMiniJuegos(),paquetes=[];
    for(let p=1;p<=100;p++) paquetes.push({id:p,nombre:'Paquete '+p,juegos:biblioteca.slice((p-1)*5,p*5)});
    return paquetes;
}

app.get('/api/admin/minigames/library', authenticate, isAdmin, async (req,res)=>{
    try{const paquetes=construirPaquetesMiniJuegos();const r=await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS minijuegos_activo JSONB DEFAULT '{}'::jsonb`);const q=await pool.query('SELECT minijuegos_activo FROM configuracion WHERE id=1');const activo=q.rows[0]&&q.rows[0].minijuegos_activo||{};res.json({total:500,totalPaquetes:100,paquetes,activo});}
    catch(e){console.error('Error biblioteca mini juegos:',e);res.status(500).json({error:'No se pudo cargar la biblioteca'});}
});
app.get('/api/tasks/minigames', authenticate, async (req,res)=>{
    try{await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS minijuegos_activo JSONB DEFAULT '{}'::jsonb`);const q=await pool.query('SELECT minijuegos_activo FROM configuracion WHERE id=1');const activo=q.rows[0]&&q.rows[0].minijuegos_activo||{};res.json({activo:activo.activo===true,paqueteId:activo.paqueteId||null,fecha:activo.fecha||null,tareas:Array.isArray(activo.tareas)?activo.tareas:[]});}
    catch(e){console.error('Error leyendo mini juegos activos:',e);res.status(500).json({error:'No se pudieron cargar los mini juegos'});}
});
app.put('/api/admin/minigames/activate', authenticate, isAdmin, async (req,res)=>{
    try{
        const paqueteId=Math.max(1,Math.min(100,Number(req.body.paqueteId||0)));if(!Number.isInteger(paqueteId))return res.status(400).json({error:'Paquete inválido'});
        const paquetes=construirPaquetesMiniJuegos(),paquete=paquetes[paqueteId-1];
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS minijuegos_activo JSONB DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP, ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE`);
        const q=await pool.query('SELECT tareas_config FROM configuracion WHERE id=1');const base=Array.isArray(q.rows[0]&&q.rows[0].tareas_config)?q.rows[0].tareas_config:[];
        const tareas=paquete.juegos.map((j,i)=>Object.assign({},base[i]||{},j,{id:'tarea_'+(i+1),nombre:j.nombre,descripcion:j.descripcion,tipo_interactivo:j.tipo_interactivo,icono:j.icono,activo:true}));
        const fecha=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima'}).format(new Date());const payload={activo:true,paqueteId,fecha,tareas};
        const r=await pool.query(`INSERT INTO configuracion(id,minijuegos_activo,tareas_config,tareas_activacion,tareas_pausadas,tareas_autorizadas,updated_at) VALUES(1,$1,$2,NOW(),FALSE,TRUE,NOW()) ON CONFLICT(id) DO UPDATE SET minijuegos_activo=$1,tareas_config=$2,tareas_activacion=NOW(),tareas_pausadas=FALSE,tareas_autorizadas=TRUE,updated_at=NOW() RETURNING minijuegos_activo,tareas_config,tareas_activacion`,[JSON.stringify(payload),JSON.stringify(tareas)]);
        res.json({message:'Paquete '+paqueteId+' activado para hoy',paqueteId,activo:r.rows[0].minijuegos_activo,tareas:r.rows[0].tareas_config});
    }catch(e){console.error('Error activando paquete:',e);res.status(500).json({error:'No se pudo activar el paquete'});}
});

app.get('/api/tasks/config', authenticate, async (req, res) => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00'`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS minijuegos_activo JSONB DEFAULT '{}'::jsonb`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion_dia DATE, ADD COLUMN IF NOT EXISTS tareas_dias_activos JSONB DEFAULT '[1,2,3,4,5]'::jsonb`);
        const result = await pool.query('SELECT tareas_config, tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas, tareas_dias_activos, hora_cobro, minijuegos_activo FROM configuracion WHERE id = 1');
        const row = result.rows[0] || {};
        const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        const fechaActivacion = row.tareas_activacion_dia ? String(row.tareas_activacion_dia).slice(0, 10) : (row.tareas_activacion ? (String(row.tareas_activacion).match(/^\d{4}-\d{2}-\d{2}/) ? String(row.tareas_activacion).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(row.tareas_activacion))) : null);
        const pausadas = row.tareas_pausadas === true;
        const autorizacionExplicita = row.tareas_autorizadas === true;
        const diasActivos = normalizarDiasActivos(row.tareas_dias_activos);
        const diaSemanaActual = obtenerDiaSemanaLima();
        const diaHabilitadoHoy = diasActivos.includes(diaSemanaActual);
        const paqueteActivo = row.minijuegos_activo && row.minijuegos_activo.activo === true && row.minijuegos_activo.fecha === hoyLima;
        const tareasBase = (Array.isArray(row.tareas_config) && row.tareas_config.length ? row.tareas_config : tareasPorDefecto).slice(0, 5);
        const tareasConfiguradas = paqueteActivo && Array.isArray(row.minijuegos_activo.tareas) && row.minijuegos_activo.tareas.length
            ? row.minijuegos_activo.tareas.slice(0, 5).map((j, i) => Object.assign({}, j, {
                hora: tareasBase[i] && tareasBase[i].hora !== undefined ? tareasBase[i].hora : j.hora,
                minuto: tareasBase[i] && tareasBase[i].minuto !== undefined ? tareasBase[i].minuto : j.minuto,
                duracionMinutos: tareasBase[i] && tareasBase[i].duracionMinutos !== undefined ? tareasBase[i].duracionMinutos : j.duracionMinutos,
                sin_horario: tareasBase[i] && tareasBase[i].sin_horario !== undefined ? tareasBase[i].sin_horario : j.sin_horario,
                activo: tareasBase[i] && tareasBase[i].activo !== undefined ? tareasBase[i].activo : j.activo
            }))
            : tareasBase;
        res.json({
            tareas: tareasConfiguradas,
            fecha: row.tareas_activacion || null,
            fechaDia: fechaActivacion,
            hoy: hoyLima,
            pausadas: pausadas,
            // La autorización diaria se determina por la fecha guardada y la pausa.
            // El booleano antiguo puede quedar FALSE después de una pausa y no debe bloquear
            // una reactivación válida del mismo día.
            autorizadasHoy: !pausadas && diaHabilitadoHoy,
            autorizadas: autorizacionExplicita,
            diasActivos,
            diaSemanaActual,
            diaHabilitadoHoy,
            horaCobro: row.hora_cobro || '20:00',
            hora_cobro: row.hora_cobro || '20:00',
            paqueteMiniJuegos: paqueteActivo ? row.minijuegos_activo.paqueteId : null
        });
    } catch (error) {
        console.error('Error obteniendo configuración de tareas:', error);
        res.status(500).json({ error: 'Error al obtener configuración de tareas' });
    }
});

app.post('/api/admin/tasks/activate', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP, ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_activacion_dia DATE`);
        const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        const previo = await pool.query('SELECT tareas_activacion, tareas_activacion_dia FROM configuracion WHERE id = 1');
        const valorPrevio = previo.rows[0]?.tareas_activacion;
        const fechaPrevia = previo.rows[0]?.tareas_activacion_dia ? String(previo.rows[0].tareas_activacion_dia).slice(0, 10) : (valorPrevio ? (String(valorPrevio).match(/^\d{4}-\d{2}-\d{2}/) ? String(valorPrevio).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(valorPrevio))) : null);
        const r = await pool.query(`UPDATE configuracion SET tareas_activacion = NOW(), tareas_activacion_dia = $1::date, tareas_pausadas = FALSE, tareas_autorizadas = TRUE, updated_at = NOW() WHERE id = 1 RETURNING tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas`, [hoyLima]);
        if (fechaPrevia !== hoyLima) {
            await pool.query(`UPDATE users SET tareas_completadas_hoy = '[]'::jsonb, ultima_fecha_tareas = $1, cobro_tareas_fecha = NULL, cobro_tareas_monto = 0`, [hoyLima]);
        }
        if (!r.rows.length) return res.status(404).json({error:'No existe la configuración de tareas'});
        res.json({message:'Tareas activadas para hoy', autorizadasHoy:true, fechaDia:hoyLima, config:r.rows[0]});
    } catch (error) { console.error('Error activando tareas:', error); res.status(500).json({error:'No se pudieron activar las tareas'}); }
});

app.post('/api/admin/tasks/pause', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP, ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_activacion_dia DATE`);
        const r = await pool.query(`UPDATE configuracion SET tareas_pausadas = TRUE, tareas_autorizadas = FALSE, updated_at = NOW() WHERE id = 1 RETURNING tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas`);
        if (!r.rows.length) return res.status(404).json({error:'No existe la configuración de tareas'});
        res.json({message:'Tareas pausadas', config:r.rows[0]});
    } catch (error) { console.error('Error pausando tareas:', error); res.status(500).json({error:'No se pudieron pausar las tareas'}); }
});

app.put('/api/admin/tasks/config', authenticate, isAdmin, async (req, res) => {
    try {
        const tareas = (Array.isArray(req.body.tareas) ? req.body.tareas : tareasPorDefecto).slice(0, 5);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion_dia DATE`);
        const actual = await pool.query('SELECT tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas, hora_cobro FROM configuracion WHERE id = 1');
        const previo = actual.rows[0] || {};
        const fecha = req.body.fecha !== undefined && req.body.fecha !== null ? req.body.fecha : (previo.tareas_activacion || null);
        const pausadas = req.body.pausadas !== undefined ? req.body.pausadas === true : previo.tareas_pausadas === true;
        // Compatibilidad con versiones antiguas del admin: si se envía una fecha
        // junto con pausadas:false, se trata de una activación explícita.
        const activacionPorConfiguracion = req.body.pausadas !== undefined && pausadas === false && fecha !== null;
        const autorizadas = req.body.autorizadas !== undefined ? req.body.autorizadas === true : (activacionPorConfiguracion ? true : previo.tareas_autorizadas === true);
        const fechaDia = normalizarFechaLima(fecha) || normalizarFechaLima(previo.tareas_activacion_dia);
        const horaSolicitada = String(req.body.horaCobro || req.body.hora_cobro || previo.hora_cobro || '20:00');
        const horaCobro = /^([01]\d|2[0-3]):[0-5]\d$/.test(horaSolicitada) ? horaSolicitada : '20:00';
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00'`);
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        const result = await pool.query(
            `INSERT INTO configuracion (id, tareas_config, tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas, hora_cobro, updated_at)
             VALUES (1, $1, $2, $6::date, $3, $4, $5, NOW())
             ON CONFLICT (id) DO UPDATE SET tareas_config = $1, tareas_activacion = $2, tareas_activacion_dia = COALESCE($6::date, configuracion.tareas_activacion_dia), tareas_pausadas = $3, tareas_autorizadas = $4, hora_cobro = $5, updated_at = NOW()
             RETURNING tareas_config, tareas_activacion, tareas_activacion_dia, tareas_pausadas, tareas_autorizadas, hora_cobro`,
            [JSON.stringify(tareas), fecha, pausadas, autorizadas, horaCobro, fechaDia]
        );
        res.json({ message: 'Configuración de tareas actualizada', config: result.rows[0] });
    } catch (error) {
        console.error('Error guardando configuración de tareas:', error);
        res.status(500).json({ error: 'Error al guardar configuración de tareas' });
    }
});

app.put('/api/admin/tasks/schedule', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_dias_activos JSONB DEFAULT '[1,2,3,4,5]'::jsonb`);
        const diasActivos = normalizarDiasActivos(req.body && (req.body.diasActivos ?? req.body.dias_activos));
        const r = await pool.query(`INSERT INTO configuracion (id, tareas_dias_activos, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET tareas_dias_activos = $1::jsonb, updated_at = NOW() RETURNING tareas_dias_activos`, [JSON.stringify(diasActivos)]);
        res.json({ message: 'Días activos guardados', diasActivos: normalizarDiasActivos(r.rows[0].tareas_dias_activos) });
    } catch (error) {
        console.error('Error guardando días activos:', error.message);
        res.status(500).json({ error: 'No se pudieron guardar los días activos' });
    }
});
app.get('/api/catalogs/config', authenticate, async (req,res)=>{try{await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb`);const r=await pool.query('SELECT catalogos_config FROM configuracion WHERE id=1');const c=(r.rows[0]&&r.rows[0].catalogos_config)||{};res.json({canjes:Array.isArray(c.canjes)?c.canjes:[],logros:Array.isArray(c.logros)?c.logros:[],cupones:Array.isArray(c.cupones)?c.cupones:[]})}catch(e){res.status(500).json({error:'Error obteniendo catálogos'})}});
app.put('/api/admin/catalogs/config', authenticate, isAdmin, async (req,res)=>{try{await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb`);const c={canjes:Array.isArray(req.body.canjes)?req.body.canjes:[],logros:Array.isArray(req.body.logros)?req.body.logros:[],cupones:Array.isArray(req.body.cupones)?req.body.cupones:[]};const r=await pool.query(`INSERT INTO configuracion(id,catalogos_config,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET catalogos_config=$1,updated_at=NOW() RETURNING catalogos_config`,[JSON.stringify(c)]);res.json({message:'Catálogos guardados',config:r.rows[0].catalogos_config})}catch(e){console.error(e);res.status(500).json({error:'Error guardando catálogos'})}});

app.post('/api/user/game/prize', authenticate, async (req,res)=>{
  const game=String(req.body.game||'').toLowerCase(); const requestedAmount=Number(req.body.amount||0);
  const usage={ruleta:'ruleta_usos',cofre:'cofres_usos',dados:'dados_usos'}[game];
  const prizeField={ruleta:'premio_ruleta',cofre:'premio_cofre',dados:'premio_dados'}[game];
  if(!usage||!prizeField||!Number.isFinite(requestedAmount)||requestedAmount<0) return res.status(400).json({error:'Premio inválido'});
  const client=await pool.connect();
  try{await client.query('BEGIN'); const q=await client.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`,[req.userId]); if(!q.rows.length) throw new Error('Usuario no encontrado'); const u=q.rows[0]; const amount=Number(u[prizeField]||0); const usos=Number(u[usage]||0); if(amount<=0) {await client.query('ROLLBACK');return res.status(409).json({error:'Esta actividad no tiene un premio configurado por el administrador'});} if(usos<=0) {await client.query('ROLLBACK');return res.status(409).json({error:'No tienes usos disponibles'});} const item={tipo:'juego',juego:game,monto:amount,fecha:new Date().toISOString(),estado:'acreditado'}; const hist=Array.isArray(u.historial_detallado)?u.historial_detallado:[]; const out=await client.query(`UPDATE users SET balance=COALESCE(balance,0)+$1, ${usage}=GREATEST(COALESCE(${usage},0)-1,0), historial_detallado=$2::jsonb WHERE id=$3 RETURNING *`,[amount,JSON.stringify(hist.concat(item)),req.userId]); await client.query('COMMIT'); try { await crearNotificacion({ userId: req.userId, tipo: 'actividad', titulo: 'Premio acreditado', descripcion: `Ganaste ${amount.toFixed(2)} USDT en ${game}`, accion: 'informativa', entidadId: `${game}:${new Date().toISOString().slice(0,10)}:${Date.now()}`, metadata: { game, amount } }); } catch (notificationError) { console.error('No se pudo crear notificación de premio:', notificationError.message); } res.json({message:'Premio acreditado',premio:amount,user:out.rows[0]});}catch(e){try{await client.query('ROLLBACK')}catch(_){} console.error('game prize',e);res.status(500).json({error:'No se pudo acreditar el premio'})}finally{client.release()}
});

// ============================================================
// HORA DE COBRO: LECTURA Y GUARDADO INDEPENDIENTES
// ============================================================
app.get('/api/tasks/claim-time', authenticate, async (req, res) => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00'`);
        const r = await pool.query('SELECT hora_cobro FROM configuracion WHERE id = 1');
        res.json({ horaCobro: (r.rows[0] && r.rows[0].hora_cobro) || '20:00', hora_cobro: (r.rows[0] && r.rows[0].hora_cobro) || '20:00' });
    } catch (e) { console.error('Error leyendo hora de cobro:', e); res.status(500).json({ error: 'No se pudo leer la hora de cobro' }); }
});
app.put('/api/admin/tasks/claim-time', authenticate, isAdmin, async (req, res) => {
    try {
        const hora = String(req.body.horaCobro || req.body.hora_cobro || '').trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return res.status(400).json({ error: 'La hora debe tener formato HH:MM' });
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00'`);
        const r = await pool.query(`INSERT INTO configuracion (id, hora_cobro, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET hora_cobro = $1, updated_at = NOW() RETURNING hora_cobro`, [hora]);
        res.json({ message: 'Hora de cobro guardada en NeonTech', horaCobro: r.rows[0].hora_cobro, hora_cobro: r.rows[0].hora_cobro });
    } catch (e) { console.error('Error guardando hora de cobro:', e); res.status(500).json({ error: 'No se pudo guardar la hora de cobro' }); }
});
// ============================================================
// COBRO DIARIO DE TAREAS: UNA SOLA VEZ POR DÍA
// ============================================================
app.post('/api/user/tasks/claim', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
        if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        const u = result.rows[0];
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS hora_cobro VARCHAR(5) DEFAULT '20:00', ADD COLUMN IF NOT EXISTS tareas_dias_activos JSONB DEFAULT '[1,2,3,4,5]'::jsonb`);
        const cfgResult = await client.query('SELECT tareas_pausadas, tareas_activacion, tareas_activacion_dia, tareas_autorizadas, tareas_dias_activos, hora_cobro FROM configuracion WHERE id = 1');
        const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        const fechaValor = cfgResult.rows[0]?.tareas_activacion;
        const fechaActivacion = fechaValor ? (String(fechaValor).match(/^\d{4}-\d{2}-\d{2}$/) ? String(fechaValor).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(fechaValor))) : null;
        const horaCobro = String(cfgResult.rows[0]?.hora_cobro || '20:00');
        const [hCobro, mCobro] = horaCobro.split(':').map(Number);
        const partesHora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
        const minutoActual = partesHora[0] * 60 + partesHora[1];
        const minutoInicioCobro = hCobro * 60 + mCobro;
        if (minutoActual < minutoInicioCobro) {
            await client.query('ROLLBACK');
            return res.status(423).json({ error: 'Aún no es la hora de realizar el cobro. Estará disponible desde las ' + horaCobro + ' horas.' });
        }
        const diaActivoHoy = cfgResult.rows[0]?.tareas_pausadas !== true && normalizarDiasActivos(cfgResult.rows[0]?.tareas_dias_activos).includes(obtenerDiaSemanaLima());
        if (!diaActivoHoy) {
            await client.query('ROLLBACK');
            return res.status(423).json({ error: cfgResult.rows[0]?.tareas_pausadas === true ? 'Las tareas están pausadas por el administrador' : 'Las tareas no están habilitadas hoy según el calendario' });
        }
        const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        if (u.cobro_tareas_fecha && String(u.cobro_tareas_fecha).slice(0, 10) === hoy) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El cobro de hoy ya fue realizado' });
        }
        const completadas = Array.isArray(u.tareas_completadas_hoy) ? u.tareas_completadas_hoy : [];
        const total = 5;
        if (completadas.length < 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Debes completar al menos una tarea antes de cobrar' });
        }
        const porcentaje = Math.min(completadas.length, total) / total;
        const planDaily = { Trader: 6, Analista: 10, Gestor: 17, Master: 27, Elite: 42 };
        const planNormalizado = normalizarPlan(u.plan);
        const diario = Number(u.daily_earnings || (planNormalizado ? planDaily[planNormalizado] : 0) || 0);
        const planText = String(u.plan || '').trim().toLowerCase();
        const tienePlanActivo = (planText && planText !== 'sin plan' && diario > 0) || Boolean(planNormalizado);
        if (!tienePlanActivo || diario <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Necesitas adquirir un plan activo antes de cobrar tareas' });
        }
        const recompensa = Number((diario * porcentaje).toFixed(2));
        const historial = Array.isArray(u.historial_detallado) ? u.historial_detallado : [];
        historial.push({ tipo: 'tareas_cobro', concepto: `Cobro de tareas ${Math.round(porcentaje * 100)}%`, monto: recompensa, fecha: new Date().toISOString(), estado: 'aprobado' });
        const updated = await client.query(
            `UPDATE users SET balance = COALESCE(balance, 0) + $1, cobro_tareas_fecha = $2, cobro_tareas_monto = $1, historial_detallado = $3 WHERE id = $4 AND (cobro_tareas_fecha IS NULL OR cobro_tareas_fecha <> $2) RETURNING *`,
            [recompensa, hoy, JSON.stringify(historial), req.userId]
        );
        if (!updated.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El cobro de hoy ya fue realizado' });
        }
        await client.query('COMMIT');
        const saved = updated.rows[0];
        res.json({ message: 'Cobro realizado', recompensa, porcentaje: Math.round(porcentaje * 100), user: saved });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en cobro diario:', error);
        res.status(500).json({ error: 'Error al procesar el cobro diario' });
    } finally {
        client.release();
    }
});

// ============================================================
// RUTAS DE ADMINISTRACIÓN
// ============================================================


// ============================================================
// RUTAS PÚBLICAS - VALIDAR CÓDIGOS
// ============================================================
app.post('/api/validate-code', authenticate, async (req, res) => {
    try {
        const { codigo } = req.body;
        
        const result = await pool.query(
            'SELECT * FROM codigos WHERE codigo = $1',
            [codigo]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Código inválido' });
        }
        
        const codigoData = result.rows[0];
        
        if (codigoData.fecha_expiracion && new Date() > new Date(codigoData.fecha_expiracion)) {
            return res.status(400).json({ error: 'Código expirado' });
        }
        
        // ✅ NO marcar como usado. Solo devolver que es válido.
        res.json({ 
            valid: true, 
            puntos: codigoData.puntos || 10,
            message: 'Código válido' 
        });
        
    } catch (error) {
        console.error('Error al validar código:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// Obtener todos los usuarios (solo admin)
app.get('/api/admin/users', authenticate, isAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('🔍 Decoded token:', decoded);
        
        const adminCheck = await pool.query(
            'SELECT id, telefono, nombre, es_admin, es_super_admin FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        console.log('👤 Admin check:', adminCheck.rows[0]);
        
        // ✅ FORZAR: Si el usuario es 999999999, siempre es admin
        if (adminCheck.rows[0]?.telefono === '999999999') {
            // Actualizar en la base de datos
            await pool.query(
                'UPDATE users SET es_admin = true, es_super_admin = true WHERE id = $1',
                [decoded.userId]
            );
            adminCheck.rows[0].es_admin = true;
            adminCheck.rows[0].es_super_admin = true;
        }
        
        if (!adminCheck.rows[0]?.es_admin) {
            console.log('❌ Acceso denegado para usuario:', adminCheck.rows[0]?.telefono);
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const result = await pool.query('SELECT * FROM users ORDER BY id DESC');
        res.json(result.rows);
        
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ============================================================
// CONFIGURACIÓN PÚBLICA PARA USUARIOS AUTENTICADOS
// ============================================================
app.get('/api/config/withdrawal', authenticate, async (req, res) => {
    try {
        await ensureTaskColumns();
        const result = await pool.query('SELECT minimo_retiro, comision_retiro_porcentaje, telegram_soporte_url FROM configuracion WHERE id = 1');
        const row = result.rows[0] || {};
        res.json({ minimo_retiro: Number(row.minimo_retiro ?? 10), comision_retiro_porcentaje: Number(row.comision_retiro_porcentaje ?? 23), telegram_soporte_url: String(row.telegram_soporte_url || '') });
    } catch (error) {
        console.error('Error leyendo configuración de retiro:', error.message);
        res.status(500).json({ error: 'No se pudo cargar la configuración de retiro' });
    }
});
app.get('/api/config/support', async (req, res) => {
    try {
        await ensureTaskColumns();
        const result = await pool.query('SELECT telegram_soporte_url FROM configuracion WHERE id = 1');
        res.json({ telegram_soporte_url: String(result.rows[0]?.telegram_soporte_url || '') });
    } catch (error) {
        console.error('Error leyendo soporte de Telegram:', error.message);
        res.status(500).json({ error: 'No se pudo cargar el contacto de soporte' });
    }
});
// ============================================================
// ADMIN - CONFIGURACIÓN
// ============================================================
app.get('/api/admin/config', ...requireSuperAdmin, async (req, res) => {
    try {
        await ensureTaskColumns();
        // Verificar que la tabla existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                minimo_retiro NUMERIC(18,6) DEFAULT 10,
                comision_retiro_porcentaje NUMERIC(8,4) DEFAULT 23,
                telegram_soporte_url TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        const result = await pool.query('SELECT * FROM configuracion LIMIT 1');
        if (result.rows.length === 0) {
            await pool.query(
                `INSERT INTO configuracion (tiempo_produccion, puntos_por_codigo) VALUES (10, 10)`
            );
            return res.json({ tiempo_produccion: 10, puntos_por_codigo: 10, minimo_retiro: 10, comision_retiro_porcentaje: 23, telegram_soporte_url: '' });
        }
        res.json({
            tiempo_produccion: result.rows[0].tiempo_produccion || 10,
            puntos_por_codigo: result.rows[0].puntos_por_codigo || 10,
            minimo_retiro: Number(result.rows[0].minimo_retiro ?? 10),
            comision_retiro_porcentaje: Number(result.rows[0].comision_retiro_porcentaje ?? 23),
            telegram_soporte_url: String(result.rows[0].telegram_soporte_url || '')
        });
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.put('/api/admin/config', ...requireSuperAdmin, async (req, res) => {
    try {
        await ensureTaskColumns();
        const { tiempo_produccion, puntos_por_codigo, minimo_retiro, comision_retiro_porcentaje, telegram_soporte_url } = req.body;
        
        // Verificar que la tabla existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                minimo_retiro NUMERIC(18,6) DEFAULT 10,
                comision_retiro_porcentaje NUMERIC(8,4) DEFAULT 23,
                telegram_soporte_url TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Insertar o actualizar, conservando valores omitidos por el formulario.
        const actual = await pool.query('SELECT tiempo_produccion, puntos_por_codigo, minimo_retiro, comision_retiro_porcentaje, telegram_soporte_url FROM configuracion WHERE id = 1');
        const previo = actual.rows[0] || {};
        const tiempoFinal = Number(tiempo_produccion) > 0 ? Number(tiempo_produccion) : Number(previo.tiempo_produccion ?? 10);
        const puntosFinal = Number(puntos_por_codigo) > 0 ? Number(puntos_por_codigo) : Number(previo.puntos_por_codigo ?? 10);
        const minimoFinal = minimo_retiro !== undefined && Number(minimo_retiro) >= 0 ? Number(minimo_retiro) : Number(previo.minimo_retiro ?? 10);
        const comisionFinal = comision_retiro_porcentaje !== undefined && Number(comision_retiro_porcentaje) >= 0 && Number(comision_retiro_porcentaje) <= 100 ? Number(comision_retiro_porcentaje) : Number(previo.comision_retiro_porcentaje ?? 23);
        let telegramFinal;
        try {
            telegramFinal = normalizarEnlaceTelegram(telegram_soporte_url !== undefined ? telegram_soporte_url : previo.telegram_soporte_url);
        } catch (validationError) {
            return res.status(400).json({ error: validationError.message });
        }
        await pool.query(
                        `INSERT INTO configuracion (id, tiempo_produccion, puntos_por_codigo, minimo_retiro, comision_retiro_porcentaje, telegram_soporte_url, updated_at) 
             VALUES (1, $1, $2, $3, $4, $5, NOW()) 
             ON CONFLICT (id) DO UPDATE 
             SET tiempo_produccion = $1, puntos_por_codigo = $2, minimo_retiro = $3, comision_retiro_porcentaje = $4, telegram_soporte_url = $5, updated_at = NOW()`,
            [tiempoFinal, puntosFinal, minimoFinal, comisionFinal, telegramFinal]
        );
        res.json({ message: 'Configuración actualizada', minimo_retiro: minimoFinal, comision_retiro_porcentaje: comisionFinal, telegram_soporte_url: telegramFinal });
    } catch (error) {
        console.error('Error al guardar configuración:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ============================================================
// ADMIN - CÓDIGOS
// ============================================================
app.get('/api/admin/codes', authenticate, isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM codigos ORDER BY created_at DESC LIMIT 100');
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener códigos:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.post('/api/admin/codes', authenticate, isAdmin, async (req, res) => {
    try {
        const { codigo, puntos, estado, fechaExpiracion } = req.body;
        
        const result = await pool.query(
            `INSERT INTO codigos (codigo, puntos, estado, created_at, fecha_expiracion) 
             VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
            [codigo, puntos || 10, estado || 'disponible', fechaExpiracion || new Date(Date.now() + 3600000).toISOString()]
        );
        
        res.json({ message: 'Código creado', codigo: result.rows[0] });
    } catch (error) {
        console.error('Error al crear código:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ✅ NUEVA RUTA: Actualizar un código (marcar como usado)
app.put('/api/admin/codes/:id', authenticate, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, usuario_uso, fecha_uso } = req.body;
        
        const result = await pool.query(
            `UPDATE codigos SET 
                estado = COALESCE($1, estado),
                usuario_uso = COALESCE($2, usuario_uso),
                fecha_uso = COALESCE($3, fecha_uso)
             WHERE id = $4 RETURNING *`,
            [estado, usuario_uso, fecha_uso, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Código no encontrado' });
        }
        
        res.json({ message: 'Código actualizado', codigo: result.rows[0] });
    } catch (error) {
        console.error('Error al actualizar código:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// Actualizar usuario (admin)
app.put('/api/admin/user/:id', authenticate, isAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const adminCheck = await pool.query(
            'SELECT es_admin FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (!adminCheck.rows[0]?.es_admin) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const userId = req.params.id;
        const updates = { ...req.body };
        if (updates.password) { updates.password_hash = await bcrypt.hash(String(updates.password), 10); delete updates.password; }
        if (updates.password_retiro) { updates.password_retiro_hash = await bcrypt.hash(String(updates.password_retiro), 10); delete updates.password_retiro; }
        
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        // ✅ AGREGAR 'codigos_usados_hoy' y 'ultimo_reinicio_codigos'
        for (const [key, value] of Object.entries(updates)) {
            const camposPermitidos = ['balance', 'puntos', 'plan', 'cuenta_habilitada', 'produccion_pausada', 
                'ruleta_usos', 'cofres_usos', 'dados_usos', 'premio_ruleta', 'premio_cofre', 'premio_dados', 
                'nivel_autorizado', 'nombre', 'apellido', 'username', 'telefono', 'password_hash', 'password_retiro_hash', 'direccion_retiro', 'plan_amount', 'daily_earnings', 'codigos_usados_hoy', 'ultimo_reinicio_codigos',
                'tareas_asignadas', 'tareas_completadas_hoy', 'ultima_fecha_tareas',
                'racha_dias', 'cobro_tareas_fecha', 'cobro_tareas_monto', 'historial',
                'canjes_realizados', 'cupones_asignados', 'logros_asignados', 'logros_reclamados',
                'referidos', 'fechas_invito', 'historial_detallado', 'direccion_retiro',
                'nombre', 'apellido', 'password_hash', 'password_retiro_hash', 'plan_amount', 'daily_earnings',
                'es_admin', 'es_super_admin'];
            if (camposPermitidos.includes(key)) {
                fields.push(`${key} = $${paramCount}`);
                if (typeof value === 'object' && value !== null) {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(value);
                }
                paramCount++;
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No hay datos para actualizar' });
        }
        
        values.push(userId);
        const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        
        const result = await pool.query(query, values);
        const savedUser = result.rows[0];
        res.json({ message: 'Usuario actualizado', user: savedUser });
        
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});


// ============================================================
// ASIGNAR ACTIVIDADES A USUARIO CON PLAN ACTIVO
// ============================================================
app.put('/api/admin/user/:id/activities', authenticate, isAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Token no proporcionado' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const admin = await pool.query('SELECT es_admin FROM users WHERE id = $1', [decoded.userId]);
        if (!admin.rows[0]?.es_admin) return res.status(403).json({ error: 'Acceso denegado' });
        const id = req.params.id;
        await pool.query(`ALTER TABLE users
            ADD COLUMN IF NOT EXISTS ruleta_usos INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS cofres_usos INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS dados_usos INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS premio_ruleta NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS premio_cofre NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS premio_dados NUMERIC DEFAULT 0`);
        const values = [
            Math.max(0, Math.floor(Number(req.body.ruleta_usos) || 0)),
            Math.max(0, Math.floor(Number(req.body.cofres_usos) || 0)),
            Math.max(0, Math.floor(Number(req.body.dados_usos) || 0)),
            Math.max(0, Number(req.body.premio_ruleta) || 0),
            Math.max(0, Number(req.body.premio_cofre) || 0),
            Math.max(0, Number(req.body.premio_dados) || 0),
            id
        ];
        const result = await pool.query(`UPDATE users SET ruleta_usos=$1, cofres_usos=$2, dados_usos=$3,
            premio_ruleta=$4, premio_cofre=$5, premio_dados=$6 WHERE (id::text=$7 OR telefono=$7) RETURNING *`, values);
        if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ message: 'Actividades asignadas', user: result.rows[0] });
    } catch (error) {
        console.error('Error asignando actividades:', error);
        res.status(500).json({ error: 'No se pudieron guardar las actividades' });
    }
});

// ============================================================
// ELIMINAR USUARIO (ADMIN)
// ============================================================
app.delete('/api/admin/user/:id', authenticate, isAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const adminCheck = await pool.query(
            'SELECT es_admin FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (!adminCheck.rows[0]?.es_admin) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        
        const userId = req.params.id;
        
        // Verificar que no estemos eliminando al propio admin
        if (parseInt(userId) === decoded.userId) {
            return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
        }
        
        const result = await pool.query(
            'DELETE FROM users WHERE id = $1 RETURNING *',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
        res.json({ message: 'Usuario eliminado', user: result.rows[0] });
        
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});


// ============================================================
// COMANDOS TRANSACCIONALES DEL SISTEMA APEX
// ============================================================
const PLANES_APEX = {
    Trader: { amount: 250, daily: 6 },
    Analista: { amount: 500, daily: 10 },
    Gestor: { amount: 800, daily: 17 },
    Master: { amount: 1200, daily: 27 },
    Elite: { amount: 1800, daily: 42 }
};

async function registrarMovimiento(client, userId, tipo, monto, concepto, metadata = {}) {
    const r = await client.query('SELECT historial_detallado FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const historial = Array.isArray(r.rows[0]?.historial_detallado) ? r.rows[0].historial_detallado : [];
    historial.push({ tipo, monto: Number(monto || 0), concepto, fecha: new Date().toISOString(), estado: 'aprobado', ...metadata });
    return historial;
}

app.post('/api/admin/user/:id/balance', authenticate, isAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const delta = Number(req.body.delta);
        if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'El ajuste de saldo debe ser un número distinto de cero' });
        await client.query('BEGIN');
        const current = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!current.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Usuario no encontrado' }); }
        const oldBalance = Number(current.rows[0].balance || 0);
        const newBalance = oldBalance + delta;
        if (newBalance < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El saldo no puede quedar negativo' }); }
        const history = await registrarMovimiento(client, req.params.id, delta > 0 ? 'admin_saldo_agregado' : 'admin_saldo_retirado', delta, req.body.concepto || 'Ajuste administrativo', { adminId: req.userId });
        const updated = await client.query('UPDATE users SET balance = $1, historial_detallado = $2 WHERE id = $3 RETURNING *', [newBalance, JSON.stringify(history), req.params.id]);
        await client.query('COMMIT');
        try { await crearNotificacion({ userId: req.params.id, tipo: 'saldo', titulo: delta > 0 ? 'Saldo agregado por administración' : 'Saldo ajustado por administración', descripcion: `${delta > 0 ? '+' : ''}${delta.toFixed(2)} USDT. ${req.body.concepto || 'Ajuste administrativo'}`, accion: 'informativa', entidadId: `saldo:${req.userId}:${Date.now()}`, metadata: { delta, adminId: req.userId, oldBalance, newBalance } }); } catch (notificationError) { console.error('No se pudo crear notificación de saldo:', notificationError.message); }
        res.json({ message: 'Saldo actualizado', user: updated.rows[0], oldBalance, newBalance });
    } catch (error) { await client.query('ROLLBACK'); console.error(error); res.status(500).json({ error: 'No se pudo actualizar el saldo' }); } finally { client.release(); }
});

app.post('/api/admin/user/:id/points', authenticate, isAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const delta = Number(req.body.delta);
        if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'El ajuste de puntos debe ser un número distinto de cero' });
        await client.query('BEGIN');
        const current = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!current.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Usuario no encontrado' }); }
        const oldPoints = Number(current.rows[0].puntos || 0);
        const newPoints = oldPoints + delta;
        if (newPoints < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Los puntos no pueden quedar negativos' }); }
        const history = await registrarMovimiento(client, req.params.id, delta > 0 ? 'admin_puntos_agregados' : 'admin_puntos_retirados', 0, req.body.concepto || 'Ajuste de puntos', { puntos: delta, adminId: req.userId });
        const updated = await client.query('UPDATE users SET puntos = $1, historial_detallado = $2 WHERE id = $3 RETURNING *', [newPoints, JSON.stringify(history), req.params.id]);
        await client.query('COMMIT');
        try { await crearNotificacion({ userId: req.params.id, tipo: 'puntos', titulo: delta > 0 ? 'Puntos agregados por administración' : 'Puntos ajustados por administración', descripcion: `${delta > 0 ? '+' : ''}${delta} puntos. ${req.body.concepto || 'Ajuste administrativo'}`, accion: 'informativa', entidadId: `puntos:${req.userId}:${Date.now()}`, metadata: { delta, adminId: req.userId, oldPoints, newPoints } }); } catch (notificationError) { console.error('No se pudo crear notificación de puntos:', notificationError.message); }
        res.json({ message: 'Puntos actualizados', user: updated.rows[0], oldPoints, newPoints });
    } catch (error) { await client.query('ROLLBACK'); console.error(error); res.status(500).json({ error: 'No se pudieron actualizar los puntos' }); } finally { client.release(); }
});

app.post('/api/user/withdraw', authenticate, async (req, res) => {
    const { amount, password, address } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({error:'El monto debe ser mayor que cero'});
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const q = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.userId]);
        if (!q.rows.length) throw new Error('Usuario no encontrado');
        const u=q.rows[0];
        const userHistory=Array.isArray(u.historial)?u.historial:[];
        const pendingWithdrawal=userHistory.find(function(item){
            const kind=String(item && (item.type || item.tipo) || '').toLowerCase();
            const status=String(item && (item.status || item.estado) || '').toLowerCase();
            return kind==='retiro' && status==='pendiente';
        });
        if(pendingWithdrawal){
            await client.query('ROLLBACK');
            return res.status(409).json({error:'Ya tienes un retiro pendiente. Podrás solicitar otro cuando el administrador lo apruebe o lo rechace.'});
        }
        const stored=u.password_retiro_hash || u.password_retiro;
        const valid=stored ? (String(stored).startsWith('$2') ? await bcrypt.compare(String(password||''),String(stored)) : String(password||'')===String(stored)) : false;
        if (!valid) { await client.query('ROLLBACK'); return res.status(401).json({error:'Contraseña incorrecta'}); }
        const configResult = await client.query('SELECT minimo_retiro, comision_retiro_porcentaje FROM configuracion WHERE id = 1');
        const config = configResult.rows[0] || {};
        const minimoRetiro = Number(config.minimo_retiro ?? 10);
        const comisionPorcentaje = Number(config.comision_retiro_porcentaje ?? 23);
        if (value < minimoRetiro) { await client.query('ROLLBACK'); return res.status(400).json({error:`El retiro mínimo es de ${minimoRetiro.toFixed(2)} USDT0`}); }
        const addr=String(address || u.direccion_retiro || '');
        if (!addr.startsWith('0x')) { await client.query('ROLLBACK'); return res.status(400).json({error:'Dirección de retiro no configurada'}); }
        if (Number(u.balance||0) < value) { await client.query('ROLLBACK'); return res.status(400).json({error:'Saldo insuficiente'}); }
        const commission=value*(comisionPorcentaje/100), net=value-commission, item={type:'retiro',amount:value,commission,commissionPercentage:comisionPorcentaje,netAmount:net,date:new Date().toISOString(),status:'pendiente',address:addr};
        const hist=Array.isArray(u.historial)?u.historial:[]; hist.push(item);
        const detail=Array.isArray(u.historial_detallado)?u.historial_detallado:[]; detail.push({tipo:'retiro',concepto:'Retiro de $'+value.toFixed(2),monto:value,comision:commission,neto:net,fecha:item.date,estado:'pendiente'});
        const updated=await client.query('UPDATE users SET balance=balance-$1,historial=$2,historial_detallado=$3 WHERE id=$4 RETURNING balance,historial,historial_detallado',[value,JSON.stringify(hist),JSON.stringify(detail),req.userId]);
        await client.query('COMMIT'); res.json({message:'Solicitud de retiro enviada',user:updated.rows[0]});
    } catch(e) { try{await client.query('ROLLBACK')}catch{}; console.error('Error retiro:',e); res.status(500).json({error:'Error en el servidor'}); } finally { client.release(); }
});

app.post('/api/user/plan/purchase', authenticate, async (req, res) => {
    const plan = PLANES_APEX[req.body.plan];
    if (!plan) return res.status(400).json({ error: 'Plan inválido' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
        const u = current.rows[0];
        const balance = Number(u.balance || 0);
        if (balance < plan.amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Saldo insuficiente' }); }
        if (u.plan && u.plan !== 'Sin plan' && Number(u.plan_amount || 0) >= plan.amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ya tienes este plan o uno superior' }); }
        const history = await registrarMovimiento(client, req.userId, 'compra_plan', -plan.amount, 'Compra del plan ' + req.body.plan, { plan: req.body.plan });
        const updated = await client.query('UPDATE users SET balance = $1, plan = $2, plan_amount = $3, daily_earnings = $4, historial_detallado = $5 WHERE id = $6 RETURNING *', [balance - plan.amount, req.body.plan, plan.amount, plan.daily, JSON.stringify(history), req.userId]);
        await client.query('COMMIT');
        res.json({ message: 'Plan adquirido', user: updated.rows[0] });
    } catch (error) { await client.query('ROLLBACK'); console.error(error); res.status(500).json({ error: 'No se pudo adquirir el plan' }); } finally { client.release(); }
});

app.post('/api/admin/user/:id/pause', authenticate, isAdmin, async (req, res) => {
    const paused = req.body.paused !== false;
    const result = await pool.query('UPDATE users SET produccion_pausada = $1 WHERE id = $2 RETURNING *', [paused, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: paused ? 'Usuario pausado' : 'Usuario reanudado', user: result.rows[0] });
});

app.post('/api/admin/user/:id/authorize-plan', authenticate, isAdmin, async (req, res) => {
    const level = Number(req.body.level || 0);
    if (!Number.isInteger(level) || level < 0 || level > 5) return res.status(400).json({ error: 'Nivel de autorización inválido' });
    const result = await pool.query('UPDATE users SET nivel_autorizado = $1 WHERE id = $2 RETURNING *', [level, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Autorización actualizada', user: result.rows[0] });
});

app.post('/api/admin/user/:id/task/assign', authenticate, isAdmin, async (req,res)=>{
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const key = String(req.params.id || '').trim();
        const q = await client.query('SELECT * FROM users WHERE id::text=$1 OR telefono=$1 LIMIT 1 FOR UPDATE', [key]);
        if (!q.rows.length) throw new Error('Usuario no encontrado');
        const u = q.rows[0];
        const t = req.body && req.body.tarea ? req.body.tarea : req.body;
        if (!t || !t.tareaId || !t.tareaNombre) throw new Error('Tarea inválida');
        const ts = Array.isArray(u.tareas_asignadas) ? u.tareas_asignadas : [];
        if (ts.some(x => String(x.tareaId) === String(t.tareaId) && (x.estado === 'pendiente' || x.estado === 'completada'))) {
            throw new Error('La tarea ya está asignada a este usuario');
        }
        const tarea = {
            tareaId: String(t.tareaId), tareaNombre: String(t.tareaNombre),
            tareaDescripcion: String(t.tareaDescripcion || t.descripcion || ''),
            tipo_recompensa: String(t.tipo_recompensa || 'puntos'), cantidad: Number(t.cantidad || 0),
            puntos: String(t.tipo_recompensa || 'puntos') === 'puntos' ? Number(t.cantidad || 0) : 0,
            estado: 'pendiente', fechaAsignacion: new Date().toISOString(),
            diasVencimiento: (Number(t.diasVencimiento || t.dias_vencimiento || t.dias || 0) > 0) ? Number(t.diasVencimiento || t.dias_vencimiento || t.dias) : ((t.fechaVencimiento && t.fechaAsignacion) ? Math.max(1, Math.round((new Date(t.fechaVencimiento).getTime() - new Date(t.fechaAsignacion).getTime()) / 86400000)) : 3),
            fechaVencimiento: t.fechaVencimiento || null, comprobante: null, fechaCompletado: null
        };
        ts.push(tarea);
        const r = await client.query('UPDATE users SET tareas_asignadas=$1::jsonb WHERE id=$2 RETURNING *', [JSON.stringify(ts), u.id]);
        await client.query('COMMIT');
        res.json({message:'Tarea asignada', user:r.rows[0], tarea});
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} console.error('Error asignando tarea:', e); res.status(400).json({error:e.message}); }
    finally { client.release(); }
});
app.post('/api/admin/user/:id/task/approve', authenticate, isAdmin, async (req,res)=>{
 const client=await pool.connect(); try{await client.query('BEGIN');const q=await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rows.length)throw new Error('Usuario no encontrado');const u=q.rows[0],i=Number(req.body.index),ts=Array.isArray(u.tareas_asignadas)?u.tareas_asignadas:[],t=ts[i];if(!t)throw new Error('Tarea no encontrada');if(t.estado==='aprobada')throw new Error('Tarea ya aprobada');t.estado='aprobada';t.fechaAprobacion=new Date().toISOString();if(req.body.nota!==undefined)t.notaAdmin=String(req.body.nota);const qty=Number(t.cantidad||0),points=t.tipo_recompensa==='usdt'?0:qty,money=t.tipo_recompensa==='usdt'?qty:0;const h=Array.isArray(u.historial_detallado)?u.historial_detallado:[];h.push({tipo:'tarea',concepto:'Tarea aprobada: '+(t.tareaNombre||t.nombre||'Actividad'),puntos:points,monto:money,nota:t.notaAdmin||null,fecha:new Date().toISOString(),estado:'aprobado'});const r=await client.query('UPDATE users SET tareas_asignadas=$1,puntos=COALESCE(puntos,0)+$2,balance=COALESCE(balance,0)+$3,historial_detallado=$4 WHERE id=$5 RETURNING *',[JSON.stringify(ts),points,money,JSON.stringify(h),req.params.id]);await client.query('COMMIT');res.json({message:'Tarea aprobada',user:r.rows[0]});}catch(e){try{await client.query('ROLLBACK')}catch{}res.status(400).json({error:e.message})}finally{client.release()}
});
app.post('/api/admin/user/:id/task/reject', authenticate, isAdmin, async (req,res)=>{try{const q=await pool.query('SELECT tareas_asignadas FROM users WHERE id=$1',[req.params.id]);if(!q.rows.length)return res.status(404).json({error:'Usuario no encontrado'});const ts=q.rows[0].tareas_asignadas||[],t=ts[Number(req.body.index)];if(!t)return res.status(404).json({error:'Tarea no encontrada'});t.estado='rechazada';t.fechaRechazo=new Date().toISOString();t.notaAdmin=String(req.body.nota||'');const r=await pool.query('UPDATE users SET tareas_asignadas=$1 WHERE id=$2 RETURNING *',[JSON.stringify(ts),req.params.id]);res.json({message:'Tarea rechazada',user:r.rows[0]});}catch(e){res.status(500).json({error:'Error procesando tarea'})}});
app.post('/api/admin/user/:id/withdraw/approve', authenticate, isAdmin, async (req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rows.length)throw new Error('Usuario no encontrado');const u=q.rows[0],h=Array.isArray(u.historial)?u.historial:[];const requestedDate=String(req.body.fecha||'');let i=Number(req.body.index);if(requestedDate){const found=h.findIndex(function(item){return item&&item.type==='retiro'&&item.status==='pendiente'&&String(item.date)===requestedDate});if(found>=0)i=found}const w=h[i];if(!w||w.type!=='retiro'||w.status!=='pendiente')throw new Error('Retiro pendiente no encontrado');w.status='aprobado';w.approvedAt=new Date().toISOString();w.nota_admin=String(req.body.nota||'');w.direccion_envio=w.address||u.direccion_retiro||null;const d=Array.isArray(u.historial_detallado)?u.historial_detallado:[];d.push({tipo:'retiro',concepto:'Retiro aprobado'+(w.nota_admin?'. Nota: '+w.nota_admin:''),monto:Number(w.amount||0),comision:Number(w.commission||0),neto:Number(w.netAmount||w.amount||0),fecha:new Date().toISOString(),estado:'aprobado'});const r=await client.query('UPDATE users SET historial=$1,historial_detallado=$2 WHERE id=$3 RETURNING *',[JSON.stringify(h),JSON.stringify(d),req.params.id]);await client.query('COMMIT');res.json({message:'Retiro aprobado',user:r.rows[0]})}catch(e){try{await client.query('ROLLBACK')}catch{}res.status(400).json({error:e.message})}finally{client.release()}});
app.post('/api/admin/user/:id/withdraw/reject', authenticate, isAdmin, async (req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rows.length)throw new Error('Usuario no encontrado');const u=q.rows[0],h=Array.isArray(u.historial)?u.historial:[];const requestedDate=String(req.body.fecha||'');let i=Number(req.body.index);if(requestedDate){const found=h.findIndex(function(item){return item&&item.type==='retiro'&&item.status==='pendiente'&&String(item.date)===requestedDate});if(found>=0)i=found}const w=h[i];if(!w||w.type!=='retiro'||w.status!=='pendiente')throw new Error('Retiro pendiente no encontrado');w.status='rechazado';w.rejectedAt=new Date().toISOString();const amount=Number(w.amount||0);const d=Array.isArray(u.historial_detallado)?u.historial_detallado:[];d.push({tipo:'retiro_reembolso',concepto:'Saldo devuelto por retiro rechazado',monto:amount,fecha:new Date().toISOString(),estado:'aprobado'});const r=await client.query('UPDATE users SET balance=COALESCE(balance,0)+$1,historial=$2,historial_detallado=$3 WHERE id=$4 RETURNING *',[amount,JSON.stringify(h),JSON.stringify(d),req.params.id]);await client.query('COMMIT');res.json({message:'Retiro rechazado y saldo devuelto',user:r.rows[0]})}catch(e){try{await client.query('ROLLBACK')}catch{}res.status(400).json({error:e.message})}finally{client.release()}});
// ============================================================
// INICIAR SERVIDOR
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
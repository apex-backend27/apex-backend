const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

async function ensureTaskColumns() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            ALTER TABLE configuracion
            ADD COLUMN IF NOT EXISTS tareas_config JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP,
            ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS juegos_config JSONB DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb
        `);
        await pool.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS tareas_completadas_hoy JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS ultima_fecha_tareas TEXT,
            ADD COLUMN IF NOT EXISTS racha_dias INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS cobro_tareas_fecha DATE,
            ADD COLUMN IF NOT EXISTS cobro_tareas_monto NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS plan_activo BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS nivel_autorizado INTEGER DEFAULT 0
        `);
        await pool.query(`
            ALTER TABLE configuracion
            ADD COLUMN IF NOT EXISTS tareas_config JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS tareas_activacion DATE,
            ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT false
        `);
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
const isAdmin = async (req, res, next) => {
    if (!req.user || !req.user.es_admin) {
        return res.status(403).json({ error: 'Acceso denegado. Se requieren privilegios de administrador.' });
    }
    next();
};

// Conexión a NeonTech
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

ensureTaskColumns();

// ============================================================
// RUTAS PÚBLICAS
// ============================================================

app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

app.get('/test', (req, res) => {
  res.json({ mensaje: 'Backend funcionando correctamente' });
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

    // Generar dirección de wallet
    const walletAddress = '0x' + Math.random().toString(16).substring(2, 42);

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
        polygon_address: walletAddress,
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
        referidos: referidosOverride || safe.referidos || { izquierda: null, derecha: null, lista: [] }
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
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        
                const userData = result.rows[0];
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
            user: publicUserData(userData, { izquierda: null, derecha: null, lista: referidosEnriquecidos })
        });
    } catch (error) {
        console.error('Error en /api/verify:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ============================================================
// RUTAS PROTEGIDAS
// ============================================================
app.get('/api/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
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
                referidos: userData.referidos || { izquierda: null, derecha: null, lista: [] }
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

app.get('/api/tasks/config', authenticate, async (req, res) => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        const result = await pool.query('SELECT tareas_config, tareas_activacion, tareas_pausadas, tareas_autorizadas FROM configuracion WHERE id = 1');
        const row = result.rows[0] || {};
        const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        const fechaActivacion = row.tareas_activacion ? (String(row.tareas_activacion).match(/^\d{4}-\d{2}-\d{2}$/) ? String(row.tareas_activacion).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(row.tareas_activacion))) : null;
        const pausadas = row.tareas_pausadas === true;
        const autorizacionExplicita = row.tareas_autorizadas === true;
        res.json({
            tareas: (Array.isArray(row.tareas_config) && row.tareas_config.length ? row.tareas_config : tareasPorDefecto).slice(0, 5),
            fecha: row.tareas_activacion || null,
            fechaDia: fechaActivacion,
            hoy: hoyLima,
            pausadas: pausadas,
            autorizadasHoy: !pausadas && fechaActivacion === hoyLima
        });
    } catch (error) {
        console.error('Error obteniendo configuración de tareas:', error);
        res.status(500).json({ error: 'Error al obtener configuración de tareas' });
    }
});

app.post('/api/admin/tasks/activate', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP, ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE`);
        const r = await pool.query(`UPDATE configuracion SET tareas_activacion = NOW(), tareas_pausadas = FALSE, tareas_autorizadas = TRUE, updated_at = NOW() WHERE id = 1 RETURNING tareas_activacion, tareas_pausadas`);
        if (!r.rows.length) return res.status(404).json({error:'No existe la configuración de tareas'});
        res.json({message:'Tareas activadas para hoy', config:r.rows[0]});
    } catch (error) { console.error('Error activando tareas:', error); res.status(500).json({error:'No se pudieron activar las tareas'}); }
});

app.post('/api/admin/tasks/pause', authenticate, isAdmin, async (req, res) => {
    try {
        await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tareas_activacion TIMESTAMP, ADD COLUMN IF NOT EXISTS tareas_pausadas BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS tareas_autorizadas BOOLEAN DEFAULT FALSE`);
        const r = await pool.query(`UPDATE configuracion SET tareas_pausadas = TRUE, tareas_autorizadas = FALSE, updated_at = NOW() WHERE id = 1 RETURNING tareas_activacion, tareas_pausadas`);
        if (!r.rows.length) return res.status(404).json({error:'No existe la configuración de tareas'});
        res.json({message:'Tareas pausadas', config:r.rows[0]});
    } catch (error) { console.error('Error pausando tareas:', error); res.status(500).json({error:'No se pudieron pausar las tareas'}); }
});

app.put('/api/admin/tasks/config', authenticate, isAdmin, async (req, res) => {
    try {
        const tareas = (Array.isArray(req.body.tareas) ? req.body.tareas : tareasPorDefecto).slice(0, 5);
        const fecha = req.body.fecha || null;
        const pausadas = req.body.pausadas === true;
        const autorizadas = req.body.autorizadas !== undefined ? req.body.autorizadas === true : (!pausadas && Boolean(fecha));
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        const result = await pool.query(
            `INSERT INTO configuracion (id, tareas_config, tareas_activacion, tareas_pausadas, tareas_autorizadas, updated_at)
             VALUES (1, $1, $2, $3, $4, NOW())
             ON CONFLICT (id) DO UPDATE SET tareas_config = $1, tareas_activacion = $2, tareas_pausadas = $3, tareas_autorizadas = $4, updated_at = NOW()
             RETURNING tareas_config, tareas_activacion, tareas_pausadas, tareas_autorizadas`,
            [JSON.stringify(tareas), fecha, pausadas, autorizadas]
        );
        res.json({ message: 'Configuración de tareas actualizada', config: result.rows[0] });
    } catch (error) {
        console.error('Error guardando configuración de tareas:', error);
        res.status(500).json({ error: 'Error al guardar configuración de tareas' });
    }
});

app.get('/api/catalogs/config', authenticate, async (req,res)=>{try{await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb`);const r=await pool.query('SELECT catalogos_config FROM configuracion WHERE id=1');const c=(r.rows[0]&&r.rows[0].catalogos_config)||{};res.json({canjes:Array.isArray(c.canjes)?c.canjes:[],logros:Array.isArray(c.logros)?c.logros:[]})}catch(e){res.status(500).json({error:'Error obteniendo catálogos'})}});
app.put('/api/admin/catalogs/config', authenticate, isAdmin, async (req,res)=>{try{await pool.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS catalogos_config JSONB DEFAULT '{}'::jsonb`);const c={canjes:Array.isArray(req.body.canjes)?req.body.canjes:[],logros:Array.isArray(req.body.logros)?req.body.logros:[]};const r=await pool.query(`INSERT INTO configuracion(id,catalogos_config,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET catalogos_config=$1,updated_at=NOW() RETURNING catalogos_config`,[JSON.stringify(c)]);res.json({message:'Catálogos guardados',config:r.rows[0].catalogos_config})}catch(e){console.error(e);res.status(500).json({error:'Error guardando catálogos'})}});

app.post('/api/user/game/prize', authenticate, async (req,res)=>{
  const game=String(req.body.game||'').toLowerCase(); const requestedAmount=Number(req.body.amount||0);
  const usage={ruleta:'ruleta_usos',cofre:'cofres_usos',dados:'dados_usos'}[game];
  const prizeField={ruleta:'premio_ruleta',cofre:'premio_cofre',dados:'premio_dados'}[game];
  if(!usage||!prizeField||!Number.isFinite(requestedAmount)||requestedAmount<0) return res.status(400).json({error:'Premio inválido'});
  const client=await pool.connect();
  try{await client.query('BEGIN'); const q=await client.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`,[req.userId]); if(!q.rows.length) throw new Error('Usuario no encontrado'); const u=q.rows[0]; const amount=Number(u[prizeField]||0); const usos=Number(u[usage]||0); if(amount<=0) {await client.query('ROLLBACK');return res.status(409).json({error:'Esta actividad no tiene un premio configurado por el administrador'});} if(usos<=0) {await client.query('ROLLBACK');return res.status(409).json({error:'No tienes usos disponibles'});} const item={tipo:'juego',juego:game,monto:amount,fecha:new Date().toISOString(),estado:'acreditado'}; const hist=Array.isArray(u.historial_detallado)?u.historial_detallado:[]; const out=await client.query(`UPDATE users SET balance=COALESCE(balance,0)+$1, ${usage}=GREATEST(COALESCE(${usage},0)-1,0), historial_detallado=$2::jsonb WHERE id=$3 RETURNING *`,[amount,JSON.stringify(hist.concat(item)),req.userId]); await client.query('COMMIT'); res.json({message:'Premio acreditado',premio:amount,user:out.rows[0]});}catch(e){try{await client.query('ROLLBACK')}catch(_){} console.error('game prize',e);res.status(500).json({error:'No se pudo acreditar el premio'})}finally{client.release()}
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
        const cfgResult = await client.query('SELECT tareas_pausadas, tareas_activacion, tareas_autorizadas FROM configuracion WHERE id = 1');
        const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        const fechaValor = cfgResult.rows[0]?.tareas_activacion;
        const fechaActivacion = fechaValor ? (String(fechaValor).match(/^\d{4}-\d{2}-\d{2}$/) ? String(fechaValor).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(fechaValor))) : null;
        // MODO PRUEBAS TEMPORAL: no bloquear el cobro por pausa o autorización diaria.
        // El control diario se volverá a activar después de validar todo el flujo.
        const modoPruebas = true;
        if (!modoPruebas && (cfgResult.rows[0]?.tareas_pausadas === true || fechaActivacion !== hoyLima)) {
            await client.query('ROLLBACK');
            return res.status(423).json({ error: fechaActivacion !== hoyLima ? 'Las tareas del nuevo día aún no han sido autorizadas por el administrador' : 'Las tareas están pausadas por el administrador' });
        }
        const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
        if (u.cobro_tareas_fecha && String(u.cobro_tareas_fecha).slice(0, 10) === hoy) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El cobro de hoy ya fue realizado' });
        }
        const completadas = Array.isArray(u.tareas_completadas_hoy) ? u.tareas_completadas_hoy : [];
        const total = 5;
        if (completadas.length < total) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Debes completar las 5 tareas antes de cobrar' });
        }
        const porcentaje = 1;
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
app.get('/api/admin/users', async (req, res) => {
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
// ADMIN - CONFIGURACIÓN
// ============================================================
app.get('/api/admin/config', authenticate, isAdmin, async (req, res) => {
    try {
        // Verificar que la tabla existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        const result = await pool.query('SELECT * FROM configuracion LIMIT 1');
        if (result.rows.length === 0) {
            await pool.query(
                `INSERT INTO configuracion (tiempo_produccion, puntos_por_codigo) VALUES (10, 10)`
            );
            return res.json({ tiempo_produccion: 10, puntos_por_codigo: 10 });
        }
        res.json({
            tiempo_produccion: result.rows[0].tiempo_produccion || 10,
            puntos_por_codigo: result.rows[0].puntos_por_codigo || 10
        });
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.put('/api/admin/config', authenticate, isAdmin, async (req, res) => {
    try {
        const { tiempo_produccion, puntos_por_codigo } = req.body;
        
        // Verificar que la tabla existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                tiempo_produccion INTEGER DEFAULT 10,
                puntos_por_codigo INTEGER DEFAULT 10,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Insertar o actualizar
        await pool.query(
            `INSERT INTO configuracion (id, tiempo_produccion, puntos_por_codigo, updated_at) 
             VALUES (1, $1, $2, NOW()) 
             ON CONFLICT (id) DO UPDATE 
             SET tiempo_produccion = $1, puntos_por_codigo = $2, updated_at = NOW()`,
            [tiempo_produccion || 10, puntos_por_codigo || 10]
        );
        
        res.json({ message: 'Configuración actualizada' });
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
app.put('/api/admin/user/:id', async (req, res) => {
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
                'nivel_autorizado', 'nombre', 'apellido', 'username', 'password_hash', 'password_retiro_hash', 'direccion_retiro', 'plan_amount', 'daily_earnings', 'codigos_usados_hoy', 'ultimo_reinicio_codigos',
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
app.put('/api/admin/user/:id/activities', async (req, res) => {
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
app.delete('/api/admin/user/:id', async (req, res) => {
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
        res.json({ message: 'Puntos actualizados', user: updated.rows[0], oldPoints, newPoints });
    } catch (error) { await client.query('ROLLBACK'); console.error(error); res.status(500).json({ error: 'No se pudieron actualizar los puntos' }); } finally { client.release(); }
});

app.post('/api/user/withdraw', authenticate, async (req, res) => {
    const { amount, password, address } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 30) return res.status(400).json({error:'Monto mínimo $30'});
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const q = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.userId]);
        if (!q.rows.length) throw new Error('Usuario no encontrado');
        const u=q.rows[0];
        const stored=u.password_retiro_hash || u.password_retiro;
        const valid=stored ? (String(stored).startsWith('$2') ? await bcrypt.compare(String(password||''),String(stored)) : String(password||'')===String(stored)) : false;
        if (!valid) { await client.query('ROLLBACK'); return res.status(401).json({error:'Contraseña incorrecta'}); }
        const addr=String(address || u.direccion_retiro || '');
        if (!addr.startsWith('0x')) { await client.query('ROLLBACK'); return res.status(400).json({error:'Dirección de retiro no configurada'}); }
        if (Number(u.balance||0) < value) { await client.query('ROLLBACK'); return res.status(400).json({error:'Saldo insuficiente'}); }
        const commission=value*0.23, net=value-commission, item={type:'retiro',amount:value,commission,netAmount:net,date:new Date().toISOString(),status:'pendiente',address:addr};
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
app.post('/api/admin/user/:id/withdraw/reject', authenticate, isAdmin, async (req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rows.length)throw new Error('Usuario no encontrado');const u=q.rows[0],h=Array.isArray(u.historial)?u.historial:[],i=Number(req.body.index),w=h[i];if(!w||w.type!=='retiro'||w.status!=='pendiente')throw new Error('Retiro pendiente no encontrado');w.status='rechazado';w.rejectedAt=new Date().toISOString();const amount=Number(w.amount||0);const d=Array.isArray(u.historial_detallado)?u.historial_detallado:[];d.push({tipo:'retiro_reembolso',concepto:'Saldo devuelto por retiro rechazado',monto:amount,fecha:new Date().toISOString(),estado:'aprobado'});const r=await client.query('UPDATE users SET balance=COALESCE(balance,0)+$1,historial=$2,historial_detallado=$3 WHERE id=$4 RETURNING *',[amount,JSON.stringify(h),JSON.stringify(d),req.params.id]);await client.query('COMMIT');res.json({message:'Retiro rechazado y saldo devuelto',user:r.rows[0]})}catch(e){try{await client.query('ROLLBACK')}catch{}res.status(400).json({error:e.message})}finally{client.release()}});
// ============================================================
// INICIAR SERVIDOR
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
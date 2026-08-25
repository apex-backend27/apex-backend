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
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS tareas_completadas_hoy JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS ultima_fecha_tareas TEXT,
            ADD COLUMN IF NOT EXISTS racha_dias INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS cobro_tareas_fecha DATE,
            ADD COLUMN IF NOT EXISTS cobro_tareas_monto NUMERIC DEFAULT 0
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
    'SELECT * FROM users WHERE codigo_referido = $1',
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
    user: {
        id: user.id,
        telefono: user.telefono,
        nombre: user.nombre,
        apellido: user.apellido,
        es_admin: user.es_admin,
        codigo_referido: user.codigo_referido,
        polygon_address: user.polygon_address,
        balance: user.balance,
        puntos: user.puntos || 0,
        plan: user.plan || 'Sin plan',
        referidos: user.referidos || { izquierda: null, derecha: null, lista: [] }  
    }
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
        
        res.json({ 
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
                cuenta_habilitada: userData.cuenta_habilitada !== false,
                produccion_pausada: userData.produccion_pausada || false,
                password_retiro: userData.password_retiro || userData.password_retiro_hash || '000000',
                username: userData.username || null,
                nivel_autorizado: Number(userData.nivel_autorizado || 0),
                direccion_retiro: userData.direccion_retiro || null,
                // ✅ ESTOS SON LOS CAMPOS IMPORTANTES
                codigos_usados_hoy: Number(userData.codigos_usados_hoy || 0),
                codigos_usados: userData.codigos_usados || [],
                ultimo_reinicio_codigos: userData.ultimo_reinicio_codigos || null,
                historial: userData.historial || [],
                historial_detallado: userData.historial_detallado || [],
                historial_codigos: userData.historial_codigos || [],
                ruleta_usos: Number(userData.ruleta_usos || 0),
                cofres_usos: Number(userData.cofres_usos || 0),
                dados_usos: Number(userData.dados_usos || 0),
                premio_ruleta: Number(userData.premio_ruleta || 0),
                premio_cofre: Number(userData.premio_cofre || 0),
                premio_dados: Number(userData.premio_dados || 0),
                tareas_asignadas: userData.tareas_asignadas || [],
                tareas_completadas_hoy: userData.tareas_completadas_hoy || [],
                ultima_fecha_tareas: userData.ultima_fecha_tareas || null,
                racha_dias: Number(userData.racha_dias || 0),
                cobro_tareas_fecha: userData.cobro_tareas_fecha || null,
                cobro_tareas_monto: Number(userData.cobro_tareas_monto || 0),
                referidos: userData.referidos || { izquierda: null, derecha: null, lista: [] }
            }
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
        
        const updates = req.body;
        
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

app.get('/api/tasks/config', authenticate, async (req, res) => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        const result = await pool.query('SELECT tareas_config, tareas_activacion, tareas_pausadas FROM configuracion WHERE id = 1');
        const row = result.rows[0] || {};
        res.json({
            tareas: Array.isArray(row.tareas_config) && row.tareas_config.length ? row.tareas_config : tareasPorDefecto,
            fecha: row.tareas_activacion || null,
            pausadas: row.tareas_pausadas === true
        });
    } catch (error) {
        console.error('Error obteniendo configuración de tareas:', error);
        res.status(500).json({ error: 'Error al obtener configuración de tareas' });
    }
});

app.put('/api/admin/tasks/config', authenticate, isAdmin, async (req, res) => {
    try {
        const tareas = Array.isArray(req.body.tareas) ? req.body.tareas : tareasPorDefecto;
        const fecha = req.body.fecha || null;
        const pausadas = req.body.pausadas === true;
        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (id SERIAL PRIMARY KEY, tiempo_produccion INTEGER DEFAULT 10, puntos_por_codigo INTEGER DEFAULT 10, updated_at TIMESTAMP DEFAULT NOW())`);
        const result = await pool.query(
            `INSERT INTO configuracion (id, tareas_config, tareas_activacion, tareas_pausadas, updated_at)
             VALUES (1, $1, $2, $3, NOW())
             ON CONFLICT (id) DO UPDATE SET tareas_config = $1, tareas_activacion = $2, tareas_pausadas = $3, updated_at = NOW()
             RETURNING tareas_config, tareas_activacion, tareas_pausadas`,
            [JSON.stringify(tareas), fecha, pausadas]
        );
        res.json({ message: 'Configuración de tareas actualizada', config: result.rows[0] });
    } catch (error) {
        console.error('Error guardando configuración de tareas:', error);
        res.status(500).json({ error: 'Error al guardar configuración de tareas' });
    }
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
        const cfgResult = await client.query('SELECT tareas_pausadas FROM configuracion WHERE id = 1');
        if (cfgResult.rows[0]?.tareas_pausadas === true) {
            await client.query('ROLLBACK');
            return res.status(423).json({ error: 'Las tareas están pausadas por el administrador' });
        }
        const hoy = new Date().toISOString().slice(0, 10);
        if (u.cobro_tareas_fecha && String(u.cobro_tareas_fecha).slice(0, 10) === hoy) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El cobro de hoy ya fue realizado' });
        }
        const completadas = Array.isArray(u.tareas_completadas_hoy) ? u.tareas_completadas_hoy : [];
        const total = 5;
        const porcentaje = Math.min(total, completadas.length) / total;
        if (porcentaje <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Debes completar al menos una tarea' });
        }
        const planDaily = { Trader: 6, Analista: 10, Gestor: 17, Master: 27, Elite: 42 };
        const planNormalizado = normalizarPlan(u.plan);
        const diario = Number(u.daily_earnings || (planNormalizado ? planDaily[planNormalizado] : 0) || 0);
        if (!planNormalizado || diario <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Necesitas adquirir un plan activo antes de cobrar tareas' });
        }
        const recompensa = Number((diario * porcentaje).toFixed(2));
        const historial = Array.isArray(u.historial_detallado) ? u.historial_detallado : [];
        historial.push({ tipo: 'tareas_cobro', concepto: `Cobro de tareas ${Math.round(porcentaje * 100)}%`, monto: recompensa, fecha: new Date().toISOString(), estado: 'aprobado' });
        const updated = await client.query(
            `UPDATE users SET balance = COALESCE(balance, 0) + $1, cobro_tareas_fecha = $2, cobro_tareas_monto = $1, historial_detallado = $3 WHERE id = $4 RETURNING *`,
            [recompensa, hoy, JSON.stringify(historial), req.userId]
        );
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
        const updates = req.body;
        
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        // ✅ AGREGAR 'codigos_usados_hoy' y 'ultimo_reinicio_codigos'
        for (const [key, value] of Object.entries(updates)) {
            const camposPermitidos = ['balance', 'puntos', 'plan', 'cuenta_habilitada', 'produccion_pausada', 
                'ruleta_usos', 'cofres_usos', 'dados_usos', 'premio_ruleta', 'premio_cofre', 'premio_dados', 
                'nivel_autorizado', 'codigos_usados_hoy', 'ultimo_reinicio_codigos',
                'tareas_asignadas', 'tareas_completadas_hoy', 'ultima_fecha_tareas',
                'racha_dias', 'cobro_tareas_fecha', 'cobro_tareas_monto', 'historial',
                'referidos', 'fechas_invito', 'historial_detallado', 'direccion_retiro',
                'nombre', 'apellido', 'username', 'password', 'password_retiro', 'plan_amount', 'daily_earnings',
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
    const result = await pool.query('UPDATE users SET nivel_autorizado = $1 WHERE id = $2 RETURNING *', [level, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Autorización actualizada', user: result.rows[0] });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
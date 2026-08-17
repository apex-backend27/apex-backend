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
    // PROCESAR CÓDIGO DE INVITACIÓN (con toda la lógica)
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

    if (codigoInv && codigoInv !== 'Eamb1714') {
      const referidoResult = await pool.query(
        'SELECT * FROM users WHERE codigo_referido = $1',
        [codigoInv]
      );
      
      if (referidoResult.rows.length > 0) {
        const referido = referidoResult.rows[0];
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
          lado = 'extra (sin lado)';
        }

        // Agregar a la lista de referidos
        if (!referidosActuales.lista) referidosActuales.lista = [];
        referidosActuales.lista.push({
          id: telefono,
          nombre: nombre + ' ' + apellido,
          date: new Date().toISOString(),
          lado: lado,
          commission: 0
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
        fecha_registro) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44) 
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
        new Date().toISOString()
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
        referidos: referidoData  // ✅ AGREGAR ESTO
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
        referidos: user.referidos || { izquierda: null, derecha: null, lista: [] }  // ✅ AGREGAR ESTO
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
        // Obtener el usuario COMPLETO de la base de datos
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
        password_retiro: userData.password_retiro_hash || '000000',
        direccion_retiro: userData.direccion_retiro || null,
        historial: userData.historial || [],
        historial_detallado: userData.historial_detallado || [],
        historial_codigos: userData.historial_codigos || [],
        ruleta_usos: Number(userData.ruleta_usos || 0),
        cofres_usos: Number(userData.cofres_usos || 0),
        dados_usos: Number(userData.dados_usos || 0),
        premio_ruleta: Number(userData.premio_ruleta || 0),
        premio_cofre: Number(userData.premio_cofre || 0),
        premio_dados: Number(userData.premio_dados || 0),
        referidos: userData.referidos || { izquierda: null, derecha: null, lista: [] }  // ✅ AGREGAR ESTO
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
            // Solo actualizar campos que existen en la tabla
            const camposPermitidos = ['balance', 'puntos', 'plan', 'plan_amount', 'daily_earnings', 
    'produccion_activa', 'produccion_inicio', 'produccion_duracion', 'tiempo_restante',
    'recompensa_pendiente', 'puntosPendientes', 'codigo_usado', 'reclamado_hoy',
    'fecha_produccion', 'codigos_usados_hoy', 'codigos_usados', 'ultimo_reinicio_codigos',
    'ruleta_usos', 'cofres_usos', 'dados_usos', 'premio_ruleta', 'premio_cofre', 'premio_dados',
    'cofres_abiertos', 'cupones_asignados', 'logros_asignados', 'logros_pendientes_aprobar',
    'tareas_asignadas', 'canjes_realizados', 'logros_reclamados', 'referidos',
    'referidos_directos', 'fechas_invito', 'historial', 'historial_detallado',
    'historial_codigos', 'descuentoRetiroActivo', 'bonusReferidoActivo',
    'direccion_retiro', 'password_retiro',
    'cuenta_habilitada', 'produccion_pausada', 'nivel_autorizado', 'es_admin', 'es_super_admin'
];
            
            if (camposPermitidos.includes(key)) {
                fields.push(`${key} = $${paramCount}`);
                // Si es JSON, convertirlo a string
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
        cuenta_habilitada: userData.cuenta_habilitada,
        produccion_pausada: userData.produccion_pausada || false
    }
});
        
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error en el servidor' });
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
        
        for (const [key, value] of Object.entries(updates)) {
            const camposPermitidos = ['balance', 'puntos', 'plan', 'cuenta_habilitada', 'produccion_pausada', 'ruleta_usos', 'cofres_usos', 'dados_usos', 'premio_ruleta', 'premio_cofre', 'premio_dados', 'nivel_autorizado'];
            if (camposPermitidos.includes(key)) {
                fields.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No hay datos para actualizar' });
        }
        
        values.push(userId);
        const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        
        const result = await pool.query(query, values);
        res.json({ message: 'Usuario actualizado', user: result.rows[0] });
        
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
// INICIAR SERVIDOR
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
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
        JSON.stringify(referidoData),
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
        balance: 0
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
        balance: user.balance
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
app.get('/api/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, telefono, nombre, apellido, es_admin, codigo_referido, polygon_address, balance FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
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
// INICIAR SERVIDOR
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
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

// 🔌 Conexión a NeonTech
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🏠 Ruta raíz (NUEVA)
app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

// ✅ Ruta de prueba
app.get('/test', (req, res) => {
  res.json({ mensaje: 'Backend funcionando correctamente' });
});


app.post('/api/register', async (req, res) => {
  try {
    const { telefono, nombre, apellido, password, passRetiro, codigoInv } = req.body;
    
    // 1. Validar campos
    if (!telefono || !nombre || !apellido || !password || !passRetiro) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
    }
    if (!/^\d{6}$/.test(passRetiro)) {
      return res.status(400).json({ error: 'La contraseña de retiro debe ser 6 dígitos' });
    }

    // 2. Verificar si el teléfono ya está registrado
    const userExists = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [telefono]
    );
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: '⚠️ Este teléfono ya está registrado' });
    }

    // 3. Determinar si es administrador
    const esAdmin = (codigoInv === 'Eamb1714');

    // 4. Generar código de referido
    const referralCodeGenerated = 'APEX' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // 5. Generar dirección de wallet (igual que antes)
    const walletAddress = '0x' + Math.random().toString(16).substring(2, 42);

    // 6. Hashear contraseñas (NUNCA guardar en texto plano)
    const hashedPassword = await bcrypt.hash(password, 10);
    const hashedWithdrawPassword = await bcrypt.hash(passRetiro, 10);

    // 7. Crear el objeto usuario (igual que en tu frontend)
    const nuevoUsuario = {
      telefono: telefono,
      nombre: nombre,
      apellido: apellido,
      password_hash: hashedPassword,
      password_retiro_hash: hashedWithdrawPassword,
      balance: 0,
      puntos: 0,
      plan: 'Sin plan',
      plan_amount: 0,
      daily_earnings: 0,
      es_admin: esAdmin,
      cuenta_habilitada: true,
      produccion_pausada: false,
      produccion_activa: false,
      codigo_referido: referralCodeGenerated,
      polygon_address: walletAddress,
      direccion_retiro: null,
      direccion_retiro_bloqueada: false,
      referidos: { izquierda: null, derecha: null, lista: [] },
      fechas_invito: { primero: null, segundo: null, fechaRegistro: new Date().toISOString(), fechaPrimerPlan: null },
      verificado: { izquierdaCompleto: false, derechaCompleto: false, puedeUsarCodigo: true },
      historial: [],
      historial_detallado: [],
      codigos_usados_hoy: 0,
      codigos_usados: [],
      ultimo_reinicio_codigos: null,
      ruleta_usos: 0,
      cofres_usos: 0,
      dados_usos: 0,
      premio_ruleta: 0,
      premio_cofre: 0,
      premio_dados: 0,
      cofres_abiertos: [],
      cupones_asignados: [],
      logros_asignados: [],
      logros_pendientes_aprobar: [],
      tareas_asignadas: [],
      canjes_realizados: [],
      logros_reclamados: [],
      check_in_realizado: null,
      descuentoRetiroActivo: null,
      fecha_registro: new Date().toISOString(),
      referidos_directos: { izquierda: null, derecha: null },
      historial_codigos: []
    };

    // 8. PROCESAR CÓDIGO DE INVITACIÓN (exactamente igual que antes)
    if (codigoInv && codigoInv !== 'Eamb1714') {
      const referidoResult = await pool.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [codigoInv]
      );
      
      if (referidoResult.rows.length > 0) {
        const referido = referidoResult.rows[0];
        // Aquí va la misma lógica de asignación de lado (izquierda/derecha)
        // y actualización de la lista de referidos
        // (Lo implementamos en el paso 2)
      }
    }

    // 9. Guardar en la base de datos
    const result = await pool.query(
      `INSERT INTO users 
       (phone, nombre, apellido, password_hash, password_retiro_hash, balance, puntos, plan, plan_amount, daily_earnings, es_admin, cuenta_habilitada, produccion_pausada, produccion_activa, codigo_referido, polygon_address, direccion_retiro, direccion_retiro_bloqueada, referidos, fechas_invito, verificado, historial, historial_detallado, codigos_usados_hoy, codigos_usados, ultimo_reinicio_codigos, ruleta_usos, cofres_usos, dados_usos, premio_ruleta, premio_cofre, premio_dados, cofres_abiertos, cupones_asignados, logros_asignados, logros_pendientes_aprobar, tareas_asignadas, canjes_realizados, logros_reclamados, check_in_realizado, descuentoRetiroActivo, fecha_registro, referidos_directos, historial_codigos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44) 
       RETURNING *`,
      [
        telefono, nombre, apellido, hashedPassword, hashedWithdrawPassword,
        0, 0, 'Sin plan', 0, 0, esAdmin, true, false, false,
        referralCodeGenerated, walletAddress, null, false,
        JSON.stringify(nuevoUsuario.referidos),
        JSON.stringify(nuevoUsuario.fechas_invito),
        JSON.stringify(nuevoUsuario.verificado),
        JSON.stringify(nuevoUsuario.historial),
        JSON.stringify(nuevoUsuario.historial_detallado),
        0, JSON.stringify([]), null,
        0, 0, 0, 0, 0, 0,
        JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
        JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), null, null,
        new Date().toISOString(),
        JSON.stringify(nuevoUsuario.referidos_directos),
        JSON.stringify([])
      ]
    );

    // 10. Generar token JWT
    const token = jwt.sign(
      { userId: result.rows[0].id, phone: telefono, role: esAdmin ? 'admin' : 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // 11. Responder al frontend
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
        polygon_address: walletAddress
      }
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📝 Ruta de registro de usuario
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, fullName, phone, address, referralCode } = req.body;
    
    // Verificar si el usuario ya existe
    const userExists = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'El usuario o email ya existe' });
    }
    
    // Hashear contraseña
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Generar código de referido único
    const referralCodeGenerated = username.substring(0, 4) + Math.random().toString(36).substring(2, 6);
    
    // Generar dirección de wallet (placeholder por ahora)
    const walletAddress = `wallet_${username}_${Date.now()}`;
    
    // Insertar usuario en la base de datos
    const result = await pool.query(
      `INSERT INTO users 
       (username, email, password_hash, full_name, phone, address, wallet_address, referral_code, referred_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING id, username, email, wallet_address, referral_code`,
      [username, email, hashedPassword, fullName, phone, address, walletAddress, referralCodeGenerated, referralCode || null]
    );
    
    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 🔑 Ruta de login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Buscar usuario por email
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    const user = result.rows[0];
    
    // Verificar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    // Generar token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      message: 'Login exitoso',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.balance,
        walletAddress: user.wallet_address,
        referralCode: user.referral_code
      }
    });
    
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 👤 Ruta para obtener datos del usuario
app.get('/api/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT id, username, email, full_name, phone, address, wallet_address, balance, referral_code, role FROM users WHERE id = $1',
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

// 🎁 Ruta para obtener premios
app.get('/api/prizes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM prizes WHERE is_active = true ORDER BY cost ASC'
    );
    
    res.json(result.rows);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📦 Ruta para obtener transacciones de un usuario
app.get('/api/user/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
      [id]
    );
    
    res.json(result.rows);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// ➕ Ruta para crear una transacción
app.post('/api/transactions', async (req, res) => {
  try {
    const { userId, type, amount, paymentMethod, reference } = req.body;
    
    const result = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, payment_method, reference, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') 
       RETURNING *`,
      [userId, type, amount, paymentMethod, reference]
    );
    
    res.status(201).json(result.rows[0]);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 🚀 Iniciar servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
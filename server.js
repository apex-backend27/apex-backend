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
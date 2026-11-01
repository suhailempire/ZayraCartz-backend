require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Self-Healing DB Setup
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) UNIQUE NOT NULL,
        value TEXT NOT NULL
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS utr_number VARCHAR(50);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_courier VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100);
    `);

    // Default UPI ID: Isko Admin Panel me jaakar badal sakte hain
    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('store_upi_name', 'ZayraCartz')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Master Admin Sync
    const hash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ('Master Admin', 'zayracarts@gmail.com', '9876543210', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'`,
      [hash]
    );
    console.log('Self-hosted UPI Engine Active.');
  } catch (err) {
    console.error('Init notice:', err.message);
  }
})();

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Auth token missing' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalid' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Admin access required' });
};

// ---------------- PUBLIC APIS ----------------
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Error loading settings' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Inventory load error' });
  }
});

// Self-Hosted Zero-Gateway Checkout
app.post('/api/checkout/create-order', async (req, res) => {
  const { 
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method, utr_number 
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Cart empty' });

  try {
    const pIds = items.map(i => i.product_id);
    const dbProds = await pool.query('SELECT id, title, price, stock FROM products WHERE id = ANY($1)', [pIds]);
    const prodMap = new Map(dbProds.rows.map(p => [p.id, p]));

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const prod = prodMap.get(item.product_id);
      if (!prod) return res.status(400).json({ error: 'Product unavailable' });
      subtotal += parseFloat(prod.price) * item.quantity;
      validatedItems.push({ product_id: prod.id, title: prod.title, price: prod.price, quantity: item.quantity });
    }

    const shipping_fee = subtotal > 999 ? 0 : 79;
    const total_amount = subtotal + shipping_fee;
    const order_number = 'ZC-' + Date.now().toString().slice(-6);

    const payment_status = (payment_method === 'DIRECT_UPI' && utr_number) ? 'VERIFYING' : 'PENDING';

    const result = await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        items, subtotal, shipping_fee, total_amount, payment_method, payment_status, utr_number
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [order_number, customer_name, customer_email, customer_phone, shipping_street, shipping_city, shipping_state, shipping_pincode, JSON.stringify(validatedItems), subtotal, shipping_fee, total_amount, payment_method, payment_status, utr_number || null]
    );

    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ADMIN APIS ----------------
app.post('/api/auth/login', async (req, res) => {
  let { email, password } = req.body;
  email = (email || '').trim().toLowerCase();
  password = (password || '').trim();

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Auth failed' });
  }
});

app.get('/api/admin/metrics', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const stock = await pool.query("SELECT COUNT(*) as count FROM products WHERE stock < 5 AND is_active = true");
    const prods = await pool.query("SELECT COUNT(*) as count FROM products WHERE is_active = true");

    res.json({
      totalRevenue: rev.rows[0].total || 0,
      totalOrders: ord.rows[0].count,
      lowStockCount: stock.rows[0].count,
      totalProducts: prods.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics error' });
  }
});

app.get('/api/admin/orders', authenticateJWT, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
});

app.put('/api/admin/orders/:id/status', authenticateJWT, requireAdmin, async (req, res) => {
  const { order_status, payment_status } = req.body;
  const result = await pool.query(
    `UPDATE orders SET 
      order_status = COALESCE($1, order_status),
      payment_status = COALESCE($2, payment_status)
     WHERE id = $3 RETURNING *`,
    [order_status, payment_status, req.params.id]
  );
  res.json(result.rows[0]);
});

app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  const { store_upi_id } = req.body;
  if (store_upi_id) {
    await pool.query("INSERT INTO store_settings (key, value) VALUES ('store_upi_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [store_upi_id]);
  }
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  const p = path.join(__dirname, 'public', 'admin.html');
  const r = path.join(__dirname, 'admin.html');
  res.sendFile(fs.existsSync(p) ? p : r);
});

app.get('*', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  const r = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(p) ? p : r);
});

app.listen(PORT, () => {
  console.log(`ZayraCartz server running on port ${PORT}`);
});

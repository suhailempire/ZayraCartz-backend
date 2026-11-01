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

// Phone gallery ki high-res photos upload hone ke liye 15MB limit
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Self-Healing DB Schema
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

    // Default Settings
    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('announcement_text', 'Free Express Shipping Across India | Wear Your Vibe.'),
      ('hero_title', 'The Minimal Drop'),
      ('hero_subtitle', 'Heavyweight Everyday Streetwear & Apparel.')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Master Admin Sync
    const hash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ('Master Admin', 'zayracarts@gmail.com', '9876543210', $1, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'
    `, [hash]);

    console.log('✅ ZayraCartz Professional Engine Online.');
  } catch (err) {
    console.error('Init Notice:', err.message);
  }
})();

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Auth token missing' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'zayracartz_master_secret_jwt_2026', (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Admin permission required' });
};

// ---------------- PUBLIC APIS ----------------
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: 'Settings error' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

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
    const validated = [];
    for (const item of items) {
      const prod = prodMap.get(item.product_id);
      if (!prod) return res.status(400).json({ error: 'Product unavailable' });
      subtotal += parseFloat(prod.price) * item.quantity;
      validated.push({ product_id: prod.id, title: prod.title, price: prod.price, quantity: item.quantity, size: item.size || 'M' });
    }

    const shipping_fee = subtotal > 999 ? 0 : 79;
    const total_amount = subtotal + shipping_fee;
    const order_number = 'ZC-' + Date.now().toString().slice(-6);

    const payment_status = (payment_method === 'DIRECT_UPI' && utr_number) ? 'PAID_VERIFYING' : 'PENDING';
    const order_status = (payment_method === 'DIRECT_UPI') ? 'CONFIRMED' : 'PLACED';

    const result = await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        items, subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status, utr_number
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [order_number, customer_name, customer_email, customer_phone, shipping_street, shipping_city, shipping_state, shipping_pincode, JSON.stringify(validated), subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status, utr_number || null]
    );

    // Stock decrement
    for (const it of validated) {
      await pool.query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [it.quantity, it.product_id]);
    }

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

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'zayracartz_master_secret_jwt_2026', { expiresIn: '15d' });
    res.json({ token, user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Auth failed' });
  }
});

app.get('/api/admin/metrics', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID' OR payment_status = 'PAID_VERIFYING'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const prods = await pool.query("SELECT COUNT(*) as count FROM products WHERE is_active = true");
    const recent = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 8");

    res.json({
      totalRevenue: rev.rows[0].total || 0,
      totalOrders: ord.rows[0].count,
      totalProducts: prods.rows[0].count,
      recentOrders: recent.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics error' });
  }
});

// Products CRUD + EDIT
app.get('/api/admin/products', authenticateJWT, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
  res.json(result.rows);
});

app.post('/api/admin/products', authenticateJWT, requireAdmin, async (req, res) => {
  const { title, slug, price, stock, sku, images, sizes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO products (title, slug, price, stock, sku, images, sizes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, slug || `item-${Date.now()}`, price, stock, sku, images || [], sizes || ['S','M','L','XL']]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/products/:id', authenticateJWT, requireAdmin, async (req, res) => {
  const { title, price, stock, sku, images } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products SET 
        title = COALESCE($1, title),
        price = COALESCE($2, price),
        stock = COALESCE($3, stock),
        sku = COALESCE($4, sku),
        images = COALESCE($5, images)
       WHERE id = $6 RETURNING *`,
      [title, price, stock, sku, images, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/api/admin/products/:id', authenticateJWT, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Orders Management
app.get('/api/admin/orders', authenticateJWT, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
});

app.put('/api/admin/orders/:id/status', authenticateJWT, requireAdmin, async (req, res) => {
  const { order_status, payment_status, tracking_courier, tracking_number } = req.body;
  const result = await pool.query(
    `UPDATE orders SET 
      order_status = COALESCE($1, order_status),
      payment_status = COALESCE($2, payment_status),
      tracking_courier = COALESCE($3, tracking_courier),
      tracking_number = COALESCE($4, tracking_number)
     WHERE id = $5 RETURNING *`,
    [order_status, payment_status, tracking_courier, tracking_number, req.params.id]
  );
  res.json(result.rows[0]);
});

// Save Store Settings & Banners
app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  const settings = req.body;
  for (const [k, v] of Object.entries(settings)) {
    if (v !== undefined) {
      await pool.query('INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, String(v)]);
    }
  }
  res.json({ success: true });
});

// Smart Routes
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

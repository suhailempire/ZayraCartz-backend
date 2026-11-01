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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

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

    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('announcement_text', 'Free Express Shipping Across India | Wear Your Vibe.'),
      ('hero_title', 'The Core Drop'),
      ('hero_subtitle', 'Official Minimalist Streetwear Collection')
      ON CONFLICT (key) DO NOTHING;
    `);

    const hash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ('Master Admin', 'zayracarts@gmail.com', '9876543210', $1, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'
    `, [hash]);

    console.log('✅ ZayraCartz UTR Verification Engine Online.');
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

// SECURE ORDER CREATION WITH STRICT UTR CHECK
app.post('/api/checkout/create-order', async (req, res) => {
  const {
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method, utr_number
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Cart empty' });

  // 1. Strict UTR Validation for UPI Orders
  if (payment_method === 'DIRECT_UPI') {
    const cleanUtr = (utr_number || '').trim();

    // Exactly 12 digits
    if (!/^\d{12}$/.test(cleanUtr)) {
      return res.status(400).json({ error: 'Invalid UTR! Please enter the exact 12-digit numeric Reference Number from your GPay/PhonePe receipt.' });
    }

    // Dummy numbers like 000000000000, 111111111111, 123456789012 block
    if (/^(\d)\1{11}$/.test(cleanUtr) || cleanUtr === '123456789012') {
      return res.status(400).json({ error: 'Fake UTR detected! Please enter genuine bank transaction reference.' });
    }

    // Duplicate Check: Same UTR cannot be used twice
    const dup = await pool.query('SELECT id FROM orders WHERE utr_number = $1', [cleanUtr]);
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: 'This UTR has already been submitted for another order!' });
    }
  }

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

    // UPI orders start as AWAITING_VERIFICATION and ON_HOLD
    const payment_status = (payment_method === 'DIRECT_UPI') ? 'AWAITING_VERIFICATION' : 'PENDING';
    const order_status = (payment_method === 'DIRECT_UPI') ? 'ON_HOLD' : 'PLACED';

    const result = await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        items, subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status, utr_number
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [order_number, customer_name, customer_email, customer_phone, shipping_street, shipping_city, shipping_state, shipping_pincode, JSON.stringify(validated), subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status, utr_number ? utr_number.trim() : null]
    );

    // Decrement stock
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
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const prods = await pool.query("SELECT COUNT(*) as count FROM products WHERE is_active = true");
    const pendingUtr = await pool.query("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'AWAITING_VERIFICATION'");

    res.json({
      totalRevenue: rev.rows[0].total || 0,
      totalOrders: ord.rows[0].count,
      totalProducts: prods.rows[0].count,
      pendingUtrCount: pendingUtr.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics error' });
  }
});

app.get('/api/admin/orders', authenticateJWT, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
});

// 1-CLICK UTR VERIFY OR REJECT
app.put('/api/admin/orders/:id/verify-pay', authenticateJWT, requireAdmin, async (req, res) => {
  const { action } = req.body; // 'APPROVE' ya 'REJECT'
  try {
    if (action === 'APPROVE') {
      await pool.query(
        `UPDATE orders SET payment_status = 'PAID', order_status = 'CONFIRMED' WHERE id = $1`,
        [req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE orders SET payment_status = 'FAILED_FAKE_UTR', order_status = 'CANCELLED' WHERE id = $1`,
        [req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Status update error' });
  }
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

// Products & Settings
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
  const { title, price, stock, images } = req.body;
  const result = await pool.query(
    `UPDATE products SET title = COALESCE($1, title), price = COALESCE($2, price), stock = COALESCE($3, stock), images = COALESCE($4, images) WHERE id = $5 RETURNING *`,
    [title, price, stock, images, req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/admin/products/:id', authenticateJWT, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
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

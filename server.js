require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

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

// SELF-HEALING DATABASE MIGRATION (Purani tables ko bina error ke update karega)
(async () => {
  try {
    // 1. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email VARCHAR(180) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(120);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'admin';
    `);

    // 2. Products Table (Auto-repair all columns)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL, price NUMERIC(10,2) NOT NULL);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS title VARCHAR(255);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(80) DEFAULT 'fashion';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS compare_price NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT ARRAY[]::TEXT[];
      ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT DEFAULT 100;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    // 3. Orders Table (Auto-repair order fields)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_number VARCHAR(40) UNIQUE NOT NULL);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'COD';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'PENDING';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_status VARCHAR(40) DEFAULT 'PLACED';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS utr_number VARCHAR(50);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_courier VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    // 4. Store Settings Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (key VARCHAR(50) PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO store_settings (key, value) VALUES ('store_upi_id', 'zayracarts@gmail.com') ON CONFLICT (key) DO NOTHING;
    `);

    // 5. Master Admin Auto-Sync
    const adminHash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ('Master Admin', 'zayracarts@gmail.com', '9876543210', $1, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'
    `, [adminHash]);

    // 6. Seed 4 Universal Flipkart-Style Products if empty
    const pCheck = await pool.query('SELECT COUNT(*) FROM products');
    if (parseInt(pCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO products (title, category, price, compare_price, images, description, variants) VALUES
        (
          'Zayra Signature Heavyweight Oversized Tee',
          'fashion', 899, 1499,
          ARRAY['https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800'],
          '100% Super-combed 240 GSM breathable cotton. Drop-shoulder streetwear fit.',
          '[{"name":"S","price":899,"mrp":1499},{"name":"M","price":899,"mrp":1499},{"name":"L","price":899,"mrp":1499},{"name":"XL","price":949,"mrp":1599},{"name":"XXL","price":999,"mrp":1699}]'::jsonb
        ),
        (
          'Zayra Stealth Retro Runner Sneakers',
          'shoes', 1999, 3499,
          ARRAY['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800'],
          'High-traction cushioned rubber sole with breathable mesh upper for daily comfort.',
          '[{"name":"UK 7","price":1999,"mrp":3499},{"name":"UK 8","price":1999,"mrp":3499},{"name":"UK 9","price":1999,"mrp":3499},{"name":"UK 10","price":2099,"mrp":3699}]'::jsonb
        ),
        (
          'Zayra Oudh Noir Extrait De Parfum',
          'fragrance', 899, 1499,
          ARRAY['https://images.unsplash.com/photo-1594035910387-fea47794261f?w=800'],
          'Long-lasting luxury smoky amber & oud extrait. Projects 12-14 hours on fabric.',
          '[{"name":"50 ml","price":899,"mrp":1499},{"name":"100 ml","price":1499,"mrp":2499}]'::jsonb
        ),
        (
          'Zayra Royal Chronograph Black Dial Watch',
          'watches', 1499, 2999,
          ARRAY['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800'],
          'Matte black alloy case with scratch-resistant mineral glass and quartz movement.',
          '[{"name":"Steel Chain","price":1499,"mrp":2999},{"name":"Leather Strap Edition","price":1699,"mrp":3299}]'::jsonb
        );
      `);
    }

    console.log('✅ ZayraCartz Engine & Database Synced.');
  } catch (err) {
    console.error('Migration notice:', err.message);
  }
})();

// JWT Middleware
const authAdmin = (req, res, next) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth token missing' });
  jwt.verify(token, 'zayra_jwt_secret_2026', (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired' });
    req.user = user;
    next();
  });
};

// ---------------- PUBLIC APIS ----------------
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) {
    res.json({ store_upi_id: 'zayracarts@gmail.com' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database fetch error' });
  }
});

app.get('/api/orders/track/:num', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE order_number = $1', [req.params.num.trim().toUpperCase()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Tracking service error' });
  }
});

app.post('/api/checkout/create-order', async (req, res) => {
  const { customer_name, customer_phone, shipping_address, items, payment_method, utr_number } = req.body;
  if (!customer_name || !customer_phone || !shipping_address || !items || items.length === 0) {
    return res.status(400).json({ error: 'All fields required.' });
  }

  if (payment_method === 'DIRECT_UPI') {
    const cleanUtr = (utr_number || '').trim();
    if (!/^\d{12}$/.test(cleanUtr)) {
      return res.status(400).json({ error: 'Please enter exact 12-digit UTR from your UPI payment receipt.' });
    }
    if (/^(\d)\1{11}$/.test(cleanUtr) || cleanUtr === '123456789012') {
      return res.status(400).json({ error: 'Fake UTR detected! Please enter genuine bank transaction reference.' });
    }
    const dup = await pool.query('SELECT id FROM orders WHERE utr_number = $1', [cleanUtr]);
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: 'This UTR has already been submitted for another order!' });
    }
  }

  try {
    let total = items.reduce((sum, item) => sum + (parseFloat(item.price) * parseInt(item.quantity)), 0);
    const order_number = 'ZC-' + Date.now().toString().slice(-6);
    const payment_status = payment_method === 'DIRECT_UPI' ? 'AWAITING_VERIFICATION' : 'PENDING';
    const order_status = payment_method === 'DIRECT_UPI' ? 'ON_HOLD' : 'PLACED';

    const result = await pool.query(`
      INSERT INTO orders (order_number, customer_name, customer_phone, shipping_address, items, total_amount, payment_method, payment_status, order_status, utr_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
    `, [order_number, customer_name, customer_phone, shipping_address, JSON.stringify(items), total, payment_method, payment_status, order_status, utr_number || null]);

    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ADMIN APIS ----------------
app.post('/api/auth/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, 'zayra_jwt_secret_2026', { expiresIn: '15d' });
    res.json({ token, user: { id: rows[0].id, full_name: rows[0].full_name, email: rows[0].email } });
  } catch (err) {
    res.status(500).json({ error: 'Auth failed' });
  }
});

app.get('/api/admin/metrics', authAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = 'PAID'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const prods = await pool.query("SELECT COUNT(*) as count FROM products WHERE is_active = true");
    const pendingUtr = await pool.query("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'AWAITING_VERIFICATION'");

    res.json({
      totalRevenue: rev.rows[0].total,
      totalOrders: ord.rows[0].count,
      totalProducts: prods.rows[0].count,
      pendingUtrCount: pendingUtr.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics error' });
  }
});

app.get('/api/admin/orders', authAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  res.json(rows);
});

app.put('/api/admin/orders/:id/verify-pay', authAdmin, async (req, res) => {
  const { action } = req.body;
  const pStatus = action === 'APPROVE' ? 'PAID' : 'FAILED_FAKE_UTR';
  const oStatus = action === 'APPROVE' ? 'CONFIRMED' : 'CANCELLED';
  await pool.query('UPDATE orders SET payment_status = $1, order_status = $2 WHERE id = $3', [pStatus, oStatus, req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/products', authAdmin, async (req, res) => {
  const { title, category, price, compare_price, images, description, variants } = req.body;
  const result = await pool.query(`
    INSERT INTO products (title, category, price, compare_price, images, description, variants)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [title, category || 'fashion', price, compare_price || (price * 1.4), images || [], description || '', JSON.stringify(variants || [])]);
  res.status(201).json(result.rows[0]);
});

app.delete('/api/admin/products/:id', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Fallback Routes
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), err => {
    if (err) res.sendFile(path.join(__dirname, 'admin.html'));
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

app.listen(PORT, () => {
  console.log(`🚀 ZayraCartz server online on port ${PORT}`);
});

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

// Security & High Payload Parsers (Phone gallery HD photos ke liye)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// Smart Static Serving (Root aur Public folder dono check karega)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Neon PostgreSQL Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Self-Healing Database Initialization
(async () => {
  try {
    // 1. Zaroori tables aur columns ensure karna
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

    // 2. Default Store Settings
    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('announcement_text', 'Complimentary Express Shipping Across India | Wear Your Vibe.'),
      ('hero_title', 'Elevate Everyday Aesthetic'),
      ('hero_subtitle', 'Heavyweight luxury cotton apparel curated for effortless individuality and streetwear comfort.')
      ON CONFLICT (key) DO NOTHING;
    `);

    // 3. Master Admin Login Guarantee Sync
    const adminEmail = 'zayracarts@gmail.com';
    const adminPass = 'ZayraAdmin@2026';
    const hash = await bcrypt.hash(adminPass, 10);
    
    await pool.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ('Master Admin', $1, '9876543210', $2, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'
    `, [adminEmail, hash]);

    console.log('✅ ZayraCartz Master Engine & Admin Ready.');
  } catch (err) {
    console.error('Init Error Notice:', err.message);
  }
})();

// JWT Authentication Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Auth token missing' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'zayracartz_master_secret_jwt_2026', (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired, please login again' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Admin permission required' });
};

// ==========================================
// 1. PUBLIC STOREFRONT APIS
// ==========================================

// Public Store Settings
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// Active Product Catalog
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// Customer Live Order Tracking Lookup
app.get('/api/orders/track/:order_number', async (req, res) => {
  try {
    const num = req.params.order_number.trim().toUpperCase();
    const result = await pool.query(
      'SELECT order_number, customer_name, total_amount, order_status, payment_status, tracking_courier, tracking_number, created_at FROM orders WHERE order_number = $1',
      [num]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Tracking service error' });
  }
});

// Secure Checkout with Strict Anti-Fake UTR Verification
app.post('/api/checkout/create-order', async (req, res) => {
  const {
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method, utr_number
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

  // Strict UTR Checks for UPI
  if (payment_method === 'DIRECT_UPI') {
    const cleanUtr = (utr_number || '').trim();

    // Exactly 12 digits
    if (!/^\d{12}$/.test(cleanUtr)) {
      return res.status(400).json({ error: 'Invalid UTR! Please enter the exact 12-digit numeric Reference Number from your GPay/PhonePe receipt.' });
    }

    // Block obvious dummy numbers
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

    // Auto decrement inventory stock
    for (const it of validated) {
      await pool.query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [it.quantity, it.product_id]);
    }

    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Order creation failed: ' + err.message });
  }
});

// ==========================================
// 2. ADMIN CONSOLE APIS
// ==========================================

// Admin Login
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'zayracartz_master_secret_jwt_2026',
      { expiresIn: '15d' }
    );
    res.json({ token, user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Auth failed' });
  }
});

// Admin Metrics & Stats
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

// Admin Orders
app.get('/api/admin/orders', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// 1-Click UTR Verification: Approve or Reject
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

// Order Fulfillment & Tracking Update
app.put('/api/admin/orders/:id/status', authenticateJWT, requireAdmin, async (req, res) => {
  const { order_status, payment_status, tracking_courier, tracking_number } = req.body;
  try {
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
  } catch (err) {
    res.status(500).json({ error: 'Order update error' });
  }
});

// Products CRUD
app.get('/api/admin/products', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
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
  try {
    const result = await pool.query(
      `UPDATE products SET 
        title = COALESCE($1, title),
        price = COALESCE($2, price),
        stock = COALESCE($3, stock),
        images = COALESCE($4, images)
       WHERE id = $5 RETURNING *`,
      [title, price, stock, images, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Update error' });
  }
});

app.delete('/api/admin/products/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete error' });
  }
});

// Dynamic Settings Update
app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      if (v !== undefined) {
        await pool.query('INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, String(v)]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Settings update failed' });
  }
});

// Orders CSV Export
app.get('/api/admin/export/orders.csv', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT order_number, customer_name, customer_phone, total_amount, payment_method, payment_status, utr_number, order_status, shipping_street, shipping_city, shipping_pincode, created_at FROM orders ORDER BY created_at DESC');
    let csv = 'Order No,Customer,Phone,Amount,Payment Method,Payment Status,UTR Number,Order Status,Address,City,Pincode,Date\n';
    rows.forEach(r => {
      csv += `"${r.order_number}","${r.customer_name}","${r.customer_phone}",${r.total_amount},"${r.payment_method}","${r.payment_status}","${r.utr_number || '-'}","${r.order_status}","${r.shipping_street}","${r.shipping_city}","${r.shipping_pincode}","${r.created_at.toISOString()}"\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('ZayraCartz_Orders.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).send('CSV export generation error');
  }
});

// ==========================================
// 3. SMART ANTI-CRASH FALLBACK ROUTES
// ==========================================
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
  console.log(`🚀 ZayraCartz Master Server running on port ${PORT}`);
});

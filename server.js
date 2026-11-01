require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & Body Parsers
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Smart Static Serving (Root aur Public folder dono check karega)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Neon PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Self-Healing Database Setup & Admin Auto-Sync
(async () => {
  try {
    // 1. Zaroori columns aur tables ensure karna
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

    // 2. Default UPI ID aur Settings insert karna
    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('whatsapp_number', '919876543210')
      ON CONFLICT (key) DO NOTHING;
    `);

    // 3. Master Admin Login Guarantee Sync
    const adminEmail = 'zayracarts@gmail.com';
    const adminPassword = 'ZayraAdmin@2026';
    const hash = await bcrypt.hash(adminPassword, 10);
    
    await pool.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ('Master Admin', $1, '9876543210', $2, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'
    `, [adminEmail, hash]);

    console.log('✅ ZayraCartz Engine & Master Admin Ready.');
  } catch (err) {
    console.error('Init Error Notice:', err.message);
  }
})();

// JWT Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Auth token missing' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'zayracartz_master_secret_jwt_2026', (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired, login again' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Access denied: Admin role required' });
};

// ==========================================
// 1. AUTHENTICATION APIS
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  let { email, password } = req.body;
  email = (email || '').trim().toLowerCase();
  password = (password || '').trim();

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

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

    res.json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Authentication service failed' });
  }
});

// ==========================================
// 2. STOREFRONT PUBLIC APIS
// ==========================================
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.get('/api/products', async (req, res) => {
  const { search, sort } = req.query;
  let q = 'SELECT * FROM products WHERE is_active = true';
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    q += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`;
  }
  if (sort === 'price_asc') q += ' ORDER BY price ASC';
  else if (sort === 'price_desc') q += ' ORDER BY price DESC';
  else q += ' ORDER BY created_at DESC';

  try {
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Checkout Order Creation
app.post('/api/checkout/create-order', async (req, res) => {
  const {
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method, utr_number
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

  try {
    // Validate inventory and prices server-side
    const pIds = items.map(i => i.product_id);
    const dbProds = await pool.query('SELECT id, title, price, stock FROM products WHERE id = ANY($1)', [pIds]);
    const prodMap = new Map(dbProds.rows.map(p => [p.id, p]));

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const prod = prodMap.get(item.product_id);
      if (!prod) return res.status(400).json({ error: 'Product unavailable' });
      subtotal += parseFloat(prod.price) * item.quantity;
      validatedItems.push({
        product_id: prod.id,
        title: prod.title,
        price: prod.price,
        quantity: item.quantity,
        size: item.size || 'M'
      });
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
      [
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        JSON.stringify(validatedItems), subtotal, shipping_fee, total_amount,
        payment_method, payment_status, utr_number || null
      ]
    );

    // Auto-decrement inventory stock
    for (const it of validatedItems) {
      await pool.query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [it.quantity, it.product_id]);
    }

    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Order creation failed: ' + err.message });
  }
});

// Customer UTR Submission Route
app.post('/api/checkout/submit-utr', async (req, res) => {
  const { order_id, utr_number } = req.body;
  if (!order_id || !utr_number) return res.status(400).json({ error: 'Order ID and UTR number required' });

  try {
    await pool.query(
      `UPDATE orders 
       SET utr_number = $1, payment_status = 'VERIFYING' 
       WHERE id::text = $2 OR order_number = $2`,
      [utr_number.trim(), order_id]
    );
    res.json({ success: true, message: 'UTR submitted for verification' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record UTR' });
  }
});

// ==========================================
// 3. ADMIN MANAGEMENT APIS
// ==========================================
app.get('/api/admin/metrics', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID' OR order_status = 'DELIVERED'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const stock = await pool.query("SELECT COUNT(*) as count FROM products WHERE stock < 5 AND is_active = true");
    const prods = await pool.query("SELECT COUNT(*) as count FROM products WHERE is_active = true");
    const recent = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 6");

    res.json({
      totalRevenue: rev.rows[0].total || 0,
      totalOrders: ord.rows[0].count,
      lowStockCount: stock.rows[0].count,
      totalProducts: prods.rows[0].count,
      recentOrders: recent.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics failure' });
  }
});

// Admin Products CRUD
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
      [title, slug, price, stock, sku, images, sizes || ['S','M','L','XL']]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Product save error: ' + err.message });
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

// Admin Orders & Dispatch
app.get('/api/admin/orders', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Orders retrieval error' });
  }
});

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

app.put('/api/admin/orders/:id/verify-pay', authenticateJWT, requireAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query(
      `UPDATE orders SET payment_status = $1, order_status = 'CONFIRMED' WHERE id = $2`,
      [status || 'PAID', req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Store Settings
app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  const { store_upi_id, whatsapp_number, cod_enabled, upi_enabled } = req.body;
  const updates = [
    ['store_upi_id', store_upi_id],
    ['whatsapp_number', whatsapp_number],
    ['cod_enabled', cod_enabled !== undefined ? String(cod_enabled) : undefined],
    ['upi_enabled', upi_enabled !== undefined ? String(upi_enabled) : undefined]
  ];

  try {
    for (const [k, v] of updates) {
      if (v !== undefined) {
        await pool.query(
          `INSERT INTO store_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2`,
          [k, v]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Settings update failed' });
  }
});

// Orders CSV Export for Courier / Accounts
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
// 4. SMART ANTI-CRASH FALLBACK ROUTES
// ==========================================
app.get('/admin', (req, res) => {
  const p = path.join(__dirname, 'public', 'admin.html');
  const r = path.join(__dirname, 'admin.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  if (fs.existsSync(r)) return res.sendFile(r);
  res.send('Admin file not found.');
});

app.get('*', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  const r = path.join(__dirname, 'index.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  if (fs.existsSync(r)) return res.sendFile(r);
  res.send('Storefront index.html not found.');
});

app.listen(PORT, () => {
  console.log(`🚀 ZayraCartz server online and listening on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Razorpay = require('razorpay');
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

// Self-Healing Database Initialization
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) UNIQUE NOT NULL,
        value TEXT NOT NULL
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_courier VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100);
    `);

    // Default settings
    await pool.query(`
      INSERT INTO store_settings (key, value) VALUES
      ('upi_enabled', 'true'),
      ('cod_enabled', 'true'),
      ('store_upi_id', 'zayracarts@gmail.com'),
      ('whatsapp_number', '919876543210')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Sync Master Admin
    const hash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ('Master Admin', 'zayracarts@gmail.com', '9876543210', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'`,
      [hash]
    );
    console.log('ZayraCartz system & admin ready.');
  } catch (err) {
    console.error('Init notice:', err.message);
  }
})();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
});

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

// ---------------- AUTH API ----------------
app.post('/api/auth/login', async (req, res) => {
  let { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  email = email.trim().toLowerCase();
  password = password.trim();

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

// ---------------- PUBLIC STOREFRONT APIS ----------------
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
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/checkout/create-order', async (req, res) => {
  const { 
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method, coupon_code 
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
      validatedItems.push({ product_id: prod.id, title: prod.title, price: prod.price, quantity: item.quantity, size: item.size || 'M' });
    }

    // Coupon discount logic
    let discount = 0;
    if (coupon_code) {
      const cp = await pool.query('SELECT * FROM coupons WHERE code = UPPER($1) AND is_active = true', [coupon_code]);
      if (cp.rows.length > 0) {
        const c = cp.rows[0];
        discount = c.discount_type === 'percentage' ? (subtotal * (parseFloat(c.discount_value) / 100)) : parseFloat(c.discount_value);
      }
    }

    const shipping_fee = subtotal > 999 ? 0 : 79;
    const total_amount = Math.max(0, subtotal - discount + shipping_fee);
    const order_number = 'ZC-' + Date.now().toString().slice(-6);

    let gateway_order_id = null;
    if (payment_method === 'ONLINE_UPI') {
      try {
        const rzpOrder = await razorpay.orders.create({
          amount: Math.round(total_amount * 100),
          currency: 'INR',
          receipt: order_number
        });
        gateway_order_id = rzpOrder.id;
      } catch (e) {
        console.log('Razorpay fallback (test keys not provided)');
      }
    }

    const result = await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        items, subtotal, shipping_fee, discount_amount, total_amount, payment_method, gateway_order_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [order_number, customer_name, customer_email, customer_phone, shipping_street, shipping_city, shipping_state, shipping_pincode, JSON.stringify(validatedItems), subtotal, shipping_fee, discount, total_amount, payment_method, gateway_order_id]
    );

    // Auto decrement inventory
    for (const it of validatedItems) {
      await pool.query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [it.quantity, it.product_id]);
    }

    res.status(201).json({ order: result.rows[0], razorpay_order_id: gateway_order_id, razorpay_key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ADMIN MASTER APIS ----------------
app.get('/api/admin/metrics', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID' OR order_status = 'DELIVERED'");
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

// Products CRUD
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
      [title, slug, price, stock, sku, images, sizes || ['S','M','L','XL']]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id', authenticateJWT, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.put('/api/admin/products/:id/stock', authenticateJWT, requireAdmin, async (req, res) => {
  const { stock, price } = req.body;
  await pool.query('UPDATE products SET stock = $1, price = $2 WHERE id = $3', [stock, price, req.params.id]);
  res.json({ success: true });
});

// Orders & Fulfillment
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

// Coupons
app.get('/api/admin/coupons', authenticateJWT, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM coupons ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/admin/coupons', authenticateJWT, requireAdmin, async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount } = req.body;
  const result = await pool.query(
    `INSERT INTO coupons (code, discount_type, discount_value, min_order_amount)
     VALUES (UPPER($1), $2, $3, $4) RETURNING *`,
    [code, discount_type, discount_value, min_order_amount]
  );
  res.status(201).json(result.rows[0]);
});

app.delete('/api/admin/coupons/:id', authenticateJWT, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Store Settings (Payment methods toggle, WhatsApp)
app.post('/api/admin/settings', authenticateJWT, requireAdmin, async (req, res) => {
  const { upi_enabled, cod_enabled, store_upi_id, whatsapp_number } = req.body;
  const updates = [
    ['upi_enabled', String(upi_enabled)],
    ['cod_enabled', String(cod_enabled)],
    ['store_upi_id', store_upi_id],
    ['whatsapp_number', whatsapp_number]
  ];
  for (const [k, v] of updates) {
    if (v !== undefined) {
      await pool.query('INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, v]);
    }
  }
  res.json({ success: true });
});

// CSV Export
app.get('/api/admin/export/orders.csv', authenticateJWT, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT order_number, customer_name, customer_phone, total_amount, payment_method, payment_status, order_status, shipping_street, shipping_city, shipping_pincode, created_at FROM orders ORDER BY created_at DESC');
  let csv = 'Order No,Customer,Phone,Amount,Payment Method,Payment Status,Order Status,Address,City,Pincode,Date\n';
  rows.forEach(r => {
    csv += `"${r.order_number}","${r.customer_name}","${r.customer_phone}",${r.total_amount},"${r.payment_method}","${r.payment_status}","${r.order_status}","${r.shipping_street}","${r.shipping_city}","${r.shipping_pincode}","${r.created_at.toISOString()}"\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment('ZayraCartz_Orders.csv');
  res.send(csv);
});

// Fallback Routes
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
  console.log(`Server online on port ${PORT}`);
});

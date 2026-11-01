require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

// AUTO-SYNC MASTER ADMIN CREDENTIALS (Guaranteed Fix)
(async () => {
  try {
    const adminEmail = 'zayracarts@gmail.com';
    const hash = await bcrypt.hash('ZayraAdmin@2026', 10);
    await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ('Master Admin', $1, '9876543210', $2, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'`,
      [adminEmail, hash]
    );
    console.log('Master Admin synced successfully: zayracarts@gmail.com');
  } catch (err) {
    console.error('Admin sync notice:', err.message);
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

// 1. Auth APIs with Auto-Trim for Mobile Keyboards
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

// 2. Product APIs
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

// 3. Checkout APIs
app.post('/api/checkout/create-order', async (req, res) => {
  const { 
    customer_name, customer_email, customer_phone,
    shipping_street, shipping_city, shipping_state, shipping_pincode,
    items, payment_method 
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
      if (!prod) return res.status(400).json({ error: `Product unavailable` });
      subtotal += parseFloat(prod.price) * item.quantity;
      validatedItems.push({ product_id: prod.id, title: prod.title, price: prod.price, quantity: item.quantity });
    }

    const shipping_fee = subtotal > 999 ? 0 : 79;
    const total_amount = subtotal + shipping_fee;
    const order_number = 'ZC-' + Date.now().toString().slice(-6);

    let gateway_order_id = null;
    if (payment_method === 'ONLINE_UPI') {
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(total_amount * 100),
        currency: 'INR',
        receipt: order_number
      });
      gateway_order_id = rzpOrder.id;
    }

    const result = await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        items, subtotal, shipping_fee, total_amount, payment_method, gateway_order_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [order_number, customer_name, customer_email, customer_phone, shipping_street, shipping_city, shipping_state, shipping_pincode, JSON.stringify(validatedItems), subtotal, shipping_fee, total_amount, payment_method, gateway_order_id]
    );

    res.status(201).json({ order: result.rows[0], razorpay_order_id: gateway_order_id, razorpay_key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Admin APIs
app.get('/api/admin/metrics', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const rev = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'PAID'");
    const ord = await pool.query("SELECT COUNT(*) as count FROM orders");
    const stock = await pool.query("SELECT COUNT(*) as count FROM products WHERE stock < 5");
    const recent = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5");

    res.json({
      totalRevenue: rev.rows[0].total || 0,
      totalOrders: ord.rows[0].count,
      lowStockCount: stock.rows[0].count,
      recentOrders: recent.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics error' });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin', (req, res) => {
  const publicAdmin = path.join(__dirname, 'public', 'admin.html');
  const rootAdmin = path.join(__dirname, 'admin.html');
  if (fs.existsSync(publicAdmin)) return res.sendFile(publicAdmin);
  if (fs.existsSync(rootAdmin)) return res.sendFile(rootAdmin);
  res.send('Admin dashboard file not found on server.');
});

app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.send('Storefront index.html not found on server.');
});

app.listen(PORT, () => {
  console.log(`ZayraCartz server running on port ${PORT}`);
});

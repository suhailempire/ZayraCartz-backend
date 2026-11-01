/**
 * ZayraCartz Enterprise Platform Server Engine
 * Stack: Node.js (v20+ LTS), Express, PostgreSQL (pg driver)
 * All monetary calculations handled in integer minor units (Paise)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

// 1. STRICT ENVIRONMENT VALIDATION
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
for (const envVar of REQUIRED_ENV) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing mandatory environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';
const BCRYPT_SALT_ROUNDS = 12;

// 2. DATABASE CLIENT POOL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client pool', err);
});

// 3. EXPRESS ENGINE CONFIGURATION
const app = express();

app.use(helmet({
  contentSecurityPolicy: false, // Customized for inline dynamic store assets
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Adaptive Rate Limiter: Protects APIs from brute-force & denial of service
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 300, // Max requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please throttle your connections.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 Hour
  max: 15, // Max 15 login attempts per hour per IP
  message: { error: 'Excessive authentication attempts. Account locked for 60 minutes.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// Serve static frontend assets from public and root fallbacks
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ----------------------------------------------------------------------------
// 4. SECURITY & AUTHORIZATION MIDDLEWARES
// ----------------------------------------------------------------------------

/**
 * Verify JWT Token and bind authenticated user to the request context
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied: Authentication token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({ error: 'Session expired or token invalid.' });
    }
    req.user = decodedUser;
    next();
  });
};

/**
 * Role-Based Access Control Enforcement Guard
 * @param {Array<string>} permittedRoles
 */
const requireRole = (permittedRoles) => {
  return (req, res, next) => {
    if (!req.user || !permittedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: Requires one of the following permissions: [${permittedRoles.join(', ')}]`
      });
    }
    next();
  };
};

/**
 * Centralized Audit Logger Service
 */
async function recordAuditLog(client, actorId, action, entityName, entityId, oldState, newState, ipAddress) {
  try {
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_name, entity_id, old_state, new_state, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorId, action, entityName, String(entityId), JSON.stringify(oldState), JSON.stringify(newState), ipAddress]
    );
  } catch (err) {
    console.error('Non-blocking Audit Log Failure:', err.message);
  }
}

// ----------------------------------------------------------------------------
// 5. AUTHENTICATION & STAFF ROSTER APIS
// ----------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  const { full_name, email, phone, password } = req.body;

  if (!full_name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Valid full name, email, and minimum 8-character password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email address already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const insertRes = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, full_name, email, role, created_at`,
      [full_name.trim(), normalizedEmail, phone ? phone.trim() : null, passwordHash]
    );

    const newUser = insertRes.rows[0];
    await client.query('COMMIT');

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      message: 'Account successfully registered.',
      token,
      user: newUser
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration Exception:', err);
    res.status(500).json({ error: 'Internal system fault during registration.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password credentials are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const userRes = await pool.query(
      'SELECT id, full_name, email, password_hash, role, is_active FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid identification credentials.' });
    }

    const user = userRes.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact administration.' });
    }

    const isMatch = await bcrypt.compare(password.trim(), user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid identification credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Authentication successful.',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login Exception:', err);
    res.status(500).json({ error: 'Authentication engine failure.' });
  }
});

// ----------------------------------------------------------------------------
// 6. PRODUCT CATALOG & PRICING ENGINE (STOREFRONT)
// ----------------------------------------------------------------------------

app.get('/api/products', async (req, res) => {
  const { category, search, sort, min_price, max_price, limit = 40, offset = 0 } = req.query;

  let baseQuery = `
    SELECT
      p.id, p.title, p.slug, p.short_description, p.base_price_paise, p.compare_at_price_paise,
      p.brand, p.tax_rate_percent, c.name as category_name, c.slug as category_slug,
      json_agg(
        json_build_object(
          'id', pv.id,
          'sku', pv.sku,
          'title', pv.title,
          'price_paise', pv.price_paise,
          'compare_at_price_paise', pv.compare_at_price_paise,
          'stock_quantity', pv.stock_quantity,
          'attributes', pv.attributes,
          'images', pv.images
        ) ORDER BY pv.price_paise ASC
      ) AS variants
    FROM products p
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN product_variants pv ON p.id = pv.product_id AND pv.is_active = TRUE
    WHERE p.is_active = TRUE
  `;

  const queryParams = [];

  if (category) {
    queryParams.push(category);
    baseQuery += ` AND c.slug = $${queryParams.length}`;
  }

  if (search) {
    queryParams.push(`%${search.trim()}%`);
    baseQuery += ` AND (p.title ILIKE $${queryParams.length} OR p.description ILIKE $${queryParams.length} OR p.brand ILIKE $${queryParams.length})`;
  }

  if (min_price) {
    queryParams.push(parseInt(min_price, 10));
    baseQuery += ` AND p.base_price_paise >= $${queryParams.length}`;
  }

  if (max_price) {
    queryParams.push(parseInt(max_price, 10));
    baseQuery += ` AND p.base_price_paise <= $${queryParams.length}`;
  }

  baseQuery += ` GROUP BY p.id, c.name, c.slug`;

  if (sort === 'price_asc') {
    baseQuery += ` ORDER BY p.base_price_paise ASC`;
  } else if (sort === 'price_desc') {
    baseQuery += ` ORDER BY p.base_price_paise DESC`;
  } else {
    baseQuery += ` ORDER BY p.created_at DESC`;
  }

  queryParams.push(Math.min(parseInt(limit, 10), 100));
  baseQuery += ` LIMIT $${queryParams.length}`;

  queryParams.push(parseInt(offset, 10));
  baseQuery += ` OFFSET $${queryParams.length}`;

  try {
    const result = await pool.query(baseQuery, queryParams);
    res.json({
      count: result.rows.length,
      products: result.rows
    });
  } catch (err) {
    console.error('Catalog Fetch Error:', err);
    res.status(500).json({ error: 'Failed to retrieve products from inventory.' });
  }
});

app.get('/api/products/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const productQuery = `
      SELECT
        p.*, c.name as category_name, c.slug as category_slug,
        json_agg(
          json_build_object(
            'id', pv.id,
            'sku', pv.sku,
            'title', pv.title,
            'price_paise', pv.price_paise,
            'compare_at_price_paise', pv.compare_at_price_paise,
            'stock_quantity', pv.stock_quantity,
            'attributes', pv.attributes,
            'images', pv.images,
            'weight_grams', pv.weight_grams
          ) ORDER BY pv.id ASC
        ) AS variants
      FROM products p
      JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_variants pv ON p.id = pv.product_id AND pv.is_active = TRUE
      WHERE p.slug = $1 AND p.is_active = TRUE
      GROUP BY p.id, c.name, c.slug
    `;

    const result = await pool.query(productQuery, [slug]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'The requested product was not found.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Product Details Exception:', err);
    res.status(500).json({ error: 'System fault while retrieving product specifications.' });
  }
});

// ----------------------------------------------------------------------------
// 7. CHECKOUT ENGINE: ATOMIC STOCK RESERVATION & ORDER CREATION
// ----------------------------------------------------------------------------

app.post('/api/checkout/orders', async (req, res) => {
  const {
    customer_name,
    customer_email,
    customer_phone,
    shipping_street,
    shipping_city,
    shipping_state,
    shipping_pincode,
    items, // Array of { variant_id, quantity }
    payment_method,
    coupon_code
  } = req.body;

  // Validation
  if (!customer_name || !customer_email || !customer_phone || !shipping_street || !shipping_pincode) {
    return res.status(400).json({ error: 'All mandatory recipient delivery fields must be completed.' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Checkout cart must contain at least one line item.' });
  }

  if (!['ONLINE_GATEWAY', 'DIRECT_UPI_QR', 'COD'].includes(payment_method)) {
    return res.status(400).json({ error: 'Invalid or unsupported payment mechanism selected.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    let calculatedSubtotalPaise = 0n;
    const verifiedOrderItems = [];

    // Verify each line item directly against the DB with row-level locks
    for (const item of items) {
      const variantId = parseInt(item.variant_id, 10);
      const requestedQty = parseInt(item.quantity, 10);

      if (isNaN(variantId) || isNaN(requestedQty) || requestedQty <= 0) {
        throw new Error('Malformed checkout item structure.');
      }

      // SELECT FOR UPDATE enforces a lock on this inventory row until transaction commit
      const variantRes = await client.query(
        `SELECT pv.id, pv.sku, pv.title as variant_title, pv.price_paise, pv.stock_quantity,
                p.id as product_id, p.title as product_title, p.is_active as product_active
         FROM product_variants pv
         JOIN products p ON pv.product_id = p.id
         WHERE pv.id = $1 AND pv.is_active = TRUE
         FOR UPDATE`,
        [variantId]
      );

      if (variantRes.rows.length === 0) {
        throw new Error(`Variant SKU identified by ID [${variantId}] is unavailable.`);
      }

      const variant = variantRes.rows[0];

      if (!variant.product_active) {
        throw new Error(`Product [${variant.product_title}] is currently inactive.`);
      }

      if (variant.stock_quantity < requestedQty) {
        throw new Error(
          `Insufficient inventory for [${variant.product_title} - ${variant.variant_title}]. Available: ${variant.stock_quantity}, Requested: ${requestedQty}`
        );
      }

      const unitPricePaise = BigInt(variant.price_paise);
      const lineTotalPaise = unitPricePaise * BigInt(requestedQty);
      calculatedSubtotalPaise += lineTotalPaise;

      verifiedOrderItems.push({
        product_id: variant.product_id,
        variant_id: variant.id,
        sku_snapshot: variant.sku,
        title_snapshot: variant.product_title,
        variant_title_snapshot: variant.variant_title,
        unit_price_paise: unitPricePaise,
        quantity: requestedQty,
        total_line_paise: lineTotalPaise
      });

      // Atomically decrement stock
      const newStock = variant.stock_quantity - requestedQty;
      await client.query(
        'UPDATE product_variants SET stock_quantity = $1, updated_at = NOW() WHERE id = $2',
        [newStock, variant.id]
      );

      // Record inventory change in ledger
      await client.query(
        `INSERT INTO inventory_ledger (variant_id, change_quantity, balance_after, movement_type, reference_id, notes)
         VALUES ($1, $2, $3, 'SALE_DEDUCTION', 'PENDING_CHECKOUT', 'Atomic stock decrement at checkout')`,
        [variant.id, -requestedQty, newStock]
      );
    }

    // Coupon verification
    let discountPaise = 0n;
    let couponId = null;

    if (coupon_code) {
      const couponRes = await client.query(
        `SELECT * FROM coupons
         WHERE code = UPPER($1) AND is_active = TRUE
           AND starts_at <= NOW() AND expires_at >= NOW()
         FOR UPDATE`,
        [coupon_code.trim()]
      );

      if (couponRes.rows.length > 0) {
        const coupon = couponRes.rows[0];
        if (calculatedSubtotalPaise >= BigInt(coupon.min_order_paise)) {
          couponId = coupon.id;
          if (coupon.discount_type === 'PERCENTAGE') {
            const rawDiscount = (calculatedSubtotalPaise * BigInt(coupon.discount_value)) / 100n;
            discountPaise = coupon.max_discount_paise ?
              (rawDiscount > BigInt(coupon.max_discount_paise) ? BigInt(coupon.max_discount_paise) : rawDiscount) :
              rawDiscount;
          } else {
            discountPaise = BigInt(coupon.discount_value);
          }

          // Increment usage
          await client.query('UPDATE coupons SET times_used = times_used + 1 WHERE id = $1', [coupon.id]);
        }
      }
    }

    // Free delivery above ₹999 (99900 paise); otherwise ₹79 (7900 paise) flat
    const shippingFeePaise = calculatedSubtotalPaise >= 99900n ? 0n : 7900n;
    const finalTotalPaise = calculatedSubtotalPaise - discountPaise + shippingFeePaise;

    const orderNumber = `ZC-${Date.now().toString().slice(-6)}-${crypto.randomInt(100, 999)}`;

    const orderInsertRes = await client.query(
      `INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        shipping_street, shipping_city, shipping_state, shipping_pincode,
        subtotal_paise, shipping_fee_paise, discount_paise, total_amount_paise,
        order_status, payment_status, payment_method, coupon_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PLACED', 'PENDING', $14, $15)
      RETURNING *`,
      [
        orderNumber,
        req.user ? req.user.id : null,
        customer_name.trim(),
        customer_email.trim().toLowerCase(),
        customer_phone.trim(),
        shipping_street.trim(),
        shipping_city.trim(),
        shipping_state.trim(),
        shipping_pincode.trim(),
        calculatedSubtotalPaise.toString(),
        shippingFeePaise.toString(),
        discountPaise.toString(),
        finalTotalPaise.toString(),
        payment_method,
        couponId
      ]
    );

    const createdOrder = orderInsertRes.rows[0];

    // Insert order line items snapshot
    for (const lineItem of verifiedOrderItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id, product_id, variant_id, sku_snapshot, title_snapshot,
          variant_title_snapshot, unit_price_paise, quantity, total_line_paise
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          createdOrder.id,
          lineItem.product_id,
          lineItem.variant_id,
          lineItem.sku_snapshot,
          lineItem.title_snapshot,
          lineItem.variant_title_snapshot,
          lineItem.unit_price_paise.toString(),
          lineItem.quantity,
          lineItem.total_line_paise.toString()
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Order created with inventory reservation.',
      order: {
        id: createdOrder.id,
        order_number: createdOrder.order_number,
        total_amount_paise: createdOrder.total_amount_paise,
        formatted_total_inr: (Number(createdOrder.total_amount_paise) / 100).toFixed(2),
        payment_method: createdOrder.payment_method,
        order_status: createdOrder.order_status
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkout Transaction Rolled Back:', err.message);
    res.status(400).json({ error: err.message || 'Checkout failed due to transactional conflict.' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// 8. LOGISTICS & PUBLIC ORDER TRACKING
// ----------------------------------------------------------------------------

app.get('/api/orders/track/:order_number', async (req, res) => {
  const { order_number } = req.params;

  try {
    const query = `
      SELECT
        o.order_number, o.customer_name, o.order_status, o.payment_status,
        o.total_amount_paise, o.created_at,
        s.courier_partner, s.tracking_number, s.shipping_status,
        s.estimated_delivery
      FROM orders o
      LEFT JOIN shipments s ON o.id = s.order_id
      WHERE o.order_number = $1
    `;

    const result = await pool.query(query, [order_number.trim().toUpperCase()]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No order was found matching this identifier.' });
    }

    const o = result.rows[0];
    res.json({
      order_number: o.order_number,
      customer_name: o.customer_name,
      order_status: o.order_status,
      payment_status: o.payment_status,
      total_inr: (Number(o.total_amount_paise) / 100).toFixed(2),
      courier_partner: o.courier_partner || 'Warehouse Fulfillment Center',
      tracking_number: o.tracking_number || null,
      shipping_status: o.shipping_status || 'PROCESSING_IN_WAREHOUSE',
      estimated_delivery: o.estimated_delivery,
      placed_at: o.created_at
    });
  } catch (err) {
    console.error('Tracking Lookup Exception:', err);
    res.status(500).json({ error: 'Tracking service lookup failure.' });
  }
});

// ----------------------------------------------------------------------------
// 9. PROTECTED ADMIN CONSOLE OPERATIONS
// ----------------------------------------------------------------------------

app.get(
  '/api/admin/metrics',
  authenticateToken,
  requireRole(['owner', 'admin']),
  async (req, res) => {
    try {
      const revenueRes = await pool.query(
        `SELECT COALESCE(SUM(total_amount_paise), 0) as verified_sales
         FROM orders WHERE payment_status = 'PAID'`
      );

      const ordersCountRes = await pool.query(
        `SELECT
           COUNT(*) as total_orders,
           COUNT(*) FILTER (WHERE order_status = 'PLACED') as pending_orders,
           COUNT(*) FILTER (WHERE order_status = 'DELIVERED') as completed_orders
         FROM orders`
      );

      const stockAlertRes = await pool.query(
        `SELECT COUNT(*) as low_stock_count
         FROM product_variants
         WHERE stock_quantity < 5 AND is_active = TRUE`
      );

      const recentOrders = await pool.query(
        `SELECT id, order_number, customer_name, customer_phone, total_amount_paise,
                payment_status, order_status, created_at
         FROM orders
         ORDER BY created_at DESC
         LIMIT 10`
      );

      res.json({
        metrics: {
          gross_sales_paise: revenueRes.rows[0].verified_sales,
          gross_sales_inr: (Number(revenueRes.rows[0].verified_sales) / 100).toFixed(2),
          total_orders: parseInt(ordersCountRes.rows[0].total_orders, 10),
          pending_orders: parseInt(ordersCountRes.rows[0].pending_orders, 10),
          completed_orders: parseInt(ordersCountRes.rows[0].completed_orders, 10),
          low_stock_variants: parseInt(stockAlertRes.rows[0].low_stock_count, 10)
        },
        recent_orders: recentOrders.rows
      });
    } catch (err) {
      console.error('Metrics Retrieval Exception:', err);
      res.status(500).json({ error: 'Failed to aggregate administrative metrics.' });
    }
  }
);

app.post(
  '/api/admin/products',
  authenticateToken,
  requireRole(['owner', 'admin', 'catalog_manager']),
  async (req, res) => {
    const {
      title, slug, short_description, description, category_id,
      brand, base_price_paise, compare_at_price_paise, variants
    } = req.body;

    if (!title || !slug || !category_id || !base_price_paise || !variants || !Array.isArray(variants)) {
      return res.status(400).json({ error: 'Title, unique slug, category, base price, and at least one variant are required.' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const prodRes = await client.query(
        `INSERT INTO products (title, slug, short_description, description, category_id, brand, base_price_paise, compare_at_price_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [title, slug.trim().toLowerCase(), short_description, description, category_id, brand || 'ZayraCartz', base_price_paise, compare_at_price_paise || null]
      );

      const newProduct = prodRes.rows[0];

      for (const v of variants) {
        await client.query(
          `INSERT INTO product_variants (product_id, sku, title, price_paise, compare_at_price_paise, stock_quantity, attributes, images)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newProduct.id, v.sku.trim().toUpperCase(), v.title, v.price_paise, v.compare_at_price_paise || null, v.stock_quantity || 0, JSON.stringify(v.attributes || {}), v.images || []]
        );
      }

      await recordAuditLog(
        client, req.user.id, 'CREATE_PRODUCT', 'products', newProduct.id,
        null, { title, slug, variants_count: variants.length }, req.ip
      );

      await client.query('COMMIT');
      res.status(201).json({ message: 'Product and variants created successfully.', product: newProduct });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Product Creation Error:', err);
      res.status(400).json({ error: err.message || 'Product creation failed.' });
    } finally {
      client.release();
    }
  }
);

// Fallback HTML Router
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) res.status(404).send('Administrative console file not found.');
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(404).send('Storefront index file not found.');
  });
});

// ----------------------------------------------------------------------------
// 10. SYSTEM BOOTSTRAP & SEED CHECK
// ----------------------------------------------------------------------------

async function initializeBootstrap() {
  const client = await pool.connect();
  try {
    // Auto-seed Owner if zero users exist
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count, 10) === 0) {
      const defaultEmail = 'zayracarts@gmail.com';
      const defaultPassword = 'ZayraAdmin@2026';
      const hashedPass = await bcrypt.hash(defaultPassword, BCRYPT_SALT_ROUNDS);

      await client.query(
        `INSERT INTO users (full_name, email, phone, password_hash, role, is_active, is_verified)
         VALUES ('ZayraCartz Owner', $1, '9876543210', $2, 'owner', TRUE, TRUE)`,
        [defaultEmail, hashedPass]
      );
      console.log(`[BOOTSTRAP] Default Owner Account seeded: ${defaultEmail}`);
    }
  } catch (err) {
    console.error('[BOOTSTRAP WARNING] Seeding check interrupted:', err.message);
  } finally {
    client.release();
  }
}

app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(` ZayraCartz Production Engine Listening on Port ${PORT}`);
  console.log(` Standard: Integer Minor Units (Paise) | Strict RBAC   `);
  console.log(`=======================================================`);
  await initializeBootstrap();
});

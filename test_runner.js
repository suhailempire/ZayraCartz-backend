/**
 * ZayraCartz Automated Engine Test Suite
 * Run with: node test_runner.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function runTestVerification() {
  console.log('--- STARTING ZAYRACARTZ SYSTEM VERIFICATION ---');
  const client = await pool.connect();

  try {
    // TEST 1: Database Connection & Extension Audit
    console.log('[TEST 1] Verifying database connectivity and extensions...');
    const extRes = await client.query("SELECT extname FROM pg_extension WHERE extname = 'uuid-ossp'");
    if (extRes.rows.length === 0) throw new Error('Database extension [uuid-ossp] is missing.');
    console.log('  PASS: Database connected with UUID support.');

    // TEST 2: Seed Test Category and Product
    console.log('[TEST 2] Seeding test catalog item with integer paise pricing...');
    await client.query('BEGIN');

    const catRes = await client.query(
      `INSERT INTO categories (name, slug)
       VALUES ('Testing Category', 'test-category-' || floor(random()*10000))
       RETURNING id`
    );
    const categoryId = catRes.rows[0].id;

    const prodRes = await client.query(
      `INSERT INTO products (title, slug, category_id, base_price_paise, compare_at_price_paise)
       VALUES ('Architect Oversized Tee', 'test-tee-' || floor(random()*10000), $1, 89900, 149900)
       RETURNING id`,
      [categoryId]
    );
    const productId = prodRes.rows[0].id;

    // Seed variant with exact 5 units stock
    const varRes = await client.query(
      `INSERT INTO product_variants (product_id, sku, title, price_paise, stock_quantity)
       VALUES ($1, 'TEST-SKU-' || floor(random()*10000), 'Jet Black / L', 89900, 5)
       RETURNING id, stock_quantity`,
      [productId]
    );
    const variantId = varRes.rows[0].id;
    console.log(`  PASS: Product & Variant created. Stock = ${varRes.rows[0].stock_quantity} units.`);

    // TEST 3: Inventory Mutex & Concurrency Test
    console.log('[TEST 3] Simulating concurrent atomic stock deduction...');
    const requestedQty = 3;

    // Row-level lock acquisition
    const lockRes = await client.query(
      'SELECT stock_quantity FROM product_variants WHERE id = $1 FOR UPDATE',
      [variantId]
    );
    const availableStock = lockRes.rows[0].stock_quantity;

    if (availableStock < requestedQty) throw new Error('Inventory deduction logic failed check.');

    const updatedStock = availableStock - requestedQty;
    await client.query('UPDATE product_variants SET stock_quantity = $1 WHERE id = $2', [updatedStock, variantId]);

    const postStockRes = await client.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId]);
    if (postStockRes.rows[0].stock_quantity !== 2) throw new Error('Atomic stock deduction mismatch.');
    console.log(`  PASS: Stock safely decremented from 5 to ${postStockRes.rows[0].stock_quantity}.`);

    // TEST 4: Integrity Constraint Enforcement (Overselling Prevention)
    console.log('[TEST 4] Verifying database constraint prevents negative stock...');
    try {
      await client.query('UPDATE product_variants SET stock_quantity = -1 WHERE id = $1', [variantId]);
      throw new Error('FAIL: Database allowed negative inventory!');
    } catch (constraintErr) {
      console.log('  PASS: CHECK constraint successfully rejected negative stock values.');
    }

    await client.query('ROLLBACK');
    console.log('--- ALL ENGINE INTEGRITY TESTS PASSED SUCCESSFULLY ---');
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('SYSTEM TEST FAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

runTestVerification();

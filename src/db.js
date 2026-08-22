import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_SETTINGS = {
  gold_source_url: "https://www.goodreturns.in/gold-rates/surat.html",
  silver_price_per_gram: 300,
  making_charge_type: "flat_per_gram",
  making_charge_value: 1500,
  profit_multiplier: 1.9,
  usd_conversion_rate: 97,
  final_adjustment_percent: 4,
  max_price_change_percent: 15,
};

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      gold_source_url TEXT NOT NULL,
      silver_price_per_gram NUMERIC NOT NULL,
      making_charge_type TEXT NOT NULL,
      making_charge_value NUMERIC NOT NULL,
      profit_multiplier NUMERIC NOT NULL,
      usd_conversion_rate NUMERIC NOT NULL,
      final_adjustment_percent NUMERIC NOT NULL,
      max_price_change_percent NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_rates (
      id SERIAL PRIMARY KEY,
      price_24k NUMERIC NOT NULL,
      price_18k NUMERIC NOT NULL,
      price_14k NUMERIC NOT NULL,
      price_10k NUMERIC NOT NULL,
      source TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_update_runs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      total_variants INT DEFAULT 0,
      updated_count INT DEFAULT 0,
      skipped_count INT DEFAULT 0,
      blocked_count INT DEFAULT 0,
      error_message TEXT,
      gold_rate_id INT REFERENCES gold_rates(id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_update_items (
      id SERIAL PRIMARY KEY,
      run_id INT NOT NULL REFERENCES price_update_runs(id) ON DELETE CASCADE,
      product_id TEXT,
      variant_id TEXT,
      product_title TEXT,
      variant_title TEXT,
      sku TEXT,
      metal TEXT,
      old_price NUMERIC,
      new_price NUMERIC,
      change_percent NUMERIC,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const existing = await pool.query("SELECT id FROM settings WHERE id = 1");
  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO settings (
        id, gold_source_url, silver_price_per_gram, making_charge_type,
        making_charge_value, profit_multiplier, usd_conversion_rate,
        final_adjustment_percent, max_price_change_percent
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        DEFAULT_SETTINGS.gold_source_url,
        DEFAULT_SETTINGS.silver_price_per_gram,
        DEFAULT_SETTINGS.making_charge_type,
        DEFAULT_SETTINGS.making_charge_value,
        DEFAULT_SETTINGS.profit_multiplier,
        DEFAULT_SETTINGS.usd_conversion_rate,
        DEFAULT_SETTINGS.final_adjustment_percent,
        DEFAULT_SETTINGS.max_price_change_percent,
      ]
    );
  }

  console.log("[DB] Tables ready.");
}

export async function getSettings() {
  const { rows } = await pool.query("SELECT * FROM settings WHERE id = 1");
  return rows[0];
}

export async function updateSettings(fields) {
  const allowed = [
    "gold_source_url", "silver_price_per_gram", "making_charge_type",
    "making_charge_value", "profit_multiplier", "usd_conversion_rate",
    "final_adjustment_percent", "max_price_change_percent",
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) throw new Error("No valid settings fields provided.");

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map((k) => fields[k]);

  const { rows } = await pool.query(
    `UPDATE settings SET ${setClause}, updated_at = now() WHERE id = 1 RETURNING *`,
    values
  );
  return rows[0];
}

export async function saveGoldRate({ price24k, price18k, price14k, price10k, source }) {
  const { rows } = await pool.query(
    `INSERT INTO gold_rates (price_24k, price_18k, price_14k, price_10k, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [price24k, price18k, price14k, price10k, source]
  );
  return rows[0];
}

export async function getLatestGoldRate() {
  const { rows } = await pool.query(
    "SELECT * FROM gold_rates ORDER BY fetched_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

export async function createRun(goldRateId) {
  const { rows } = await pool.query(
    `INSERT INTO price_update_runs (gold_rate_id, status) VALUES ($1, 'running') RETURNING *`,
    [goldRateId]
  );
  return rows[0];
}

export async function addRunItem(runId, item) {
  await pool.query(
    `INSERT INTO price_update_items (
      run_id, product_id, variant_id, product_title, variant_title,
      sku, metal, old_price, new_price, change_percent, status, reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      runId, item.productId || null, item.variantId || null,
      item.productTitle || null, item.variantTitle || null,
      item.sku || null, item.metal || null,
      item.oldPrice ?? null, item.newPrice ?? null, item.changePercent ?? null,
      item.status, item.reason || null,
    ]
  );
}

export async function completeRun(runId, { status, totalVariants, updatedCount, skippedCount, blockedCount, errorMessage }) {
  const { rows } = await pool.query(
    `UPDATE price_update_runs SET
      status = $1, completed_at = now(), total_variants = $2,
      updated_count = $3, skipped_count = $4, blocked_count = $5, error_message = $6
     WHERE id = $7 RETURNING *`,
    [status, totalVariants, updatedCount, skippedCount, blockedCount, errorMessage || null, runId]
  );
  return rows[0];
}

export async function getLatestRunWithItems() {
  const runResult = await pool.query(
    "SELECT * FROM price_update_runs ORDER BY started_at DESC LIMIT 1"
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const itemsResult = await pool.query(
    "SELECT * FROM price_update_items WHERE run_id = $1 ORDER BY id ASC",
    [run.id]
  );

  return { run, items: itemsResult.rows };
}

export default pool;

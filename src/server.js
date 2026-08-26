import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

import { initDb, getSettings, updateSettings, saveGoldRate, getLatestGoldRate, createRun, addRunItem, completeRun, getLatestRunWithItems } from "./db.js";
import { fetchGoldRate } from "./scraper.js";
import { getAccessToken, fetchAllVariants, fetchVariantsByIds, fetchCollections, fetchProductsInCollection, fetchProductVariants, updateVariantPrice } from "./shopify-client.js";
import { evaluateVariant, validateGoldRates } from "./pricing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

app.use(express.json());

function validateShopifyIdToken(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    return res.status(401).json({ error: "Missing Shopify ID token." });
  }

  const token = auth.slice(7);

  try {
    const payload = jwt.verify(token, SHOPIFY_CLIENT_SECRET, {
      algorithms: ["HS256"],
      audience: SHOPIFY_CLIENT_ID,
    });

    if (!payload.iss || !payload.dest) throw new Error("Missing issuer/destination.");

    const issuerHost = new URL(payload.iss).hostname;
    const destinationHost = new URL(payload.dest).hostname;

    if (issuerHost !== destinationHost) throw new Error("Issuer and destination do not match.");

    req.shopifyToken = payload;
    next();
  } catch (error) {
    console.error("Shopify ID token validation failed:", error.message);
    res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    return res.status(401).json({ error: "Invalid Shopify ID token." });
  }
}

const SETTINGS_FIELDS = {
  gold_source_url: "string",
  silver_price_per_gram: "number",
  making_charge_type: "enum",
  making_charge_value: "number",
  profit_multiplier: "number",
  usd_conversion_rate: "number",
  final_adjustment_percent: "number",
  max_price_change_percent: "number",
};

function validateSettingsPayload(body) {
  const clean = {};

  for (const [key, type] of Object.entries(SETTINGS_FIELDS)) {
    if (!(key in body)) continue;
    const value = body[key];

    if (type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new Error(`${key} must be a valid number.`);
      clean[key] = num;
    } else if (type === "enum") {
      if (!["flat_per_gram", "percent_of_metal"].includes(value)) {
        throw new Error(`${key} must be "flat_per_gram" or "percent_of_metal".`);
      }
      clean[key] = value;
    } else {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
      clean[key] = value.trim();
    }
  }

  if (Object.keys(clean).length === 0) throw new Error("No valid settings fields provided.");
  return clean;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", validateShopifyIdToken, (req, res) => {
  res.json({ status: "ok", shop: req.shopifyToken.dest });
});

app.get("/api/settings", validateShopifyIdToken, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", validateShopifyIdToken, async (req, res) => {
  try {
    const clean = validateSettingsPayload(req.body || {});
    const updated = await updateSettings(clean);
    res.json({ settings: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/fetch-gold-rate", validateShopifyIdToken, async (req, res) => {
  try {
    const settings = await getSettings();
    const rate = await fetchGoldRate(settings.gold_source_url);

    const saved = await saveGoldRate({
      price24k: rate.price24k,
      price18k: rate.price18k,
      price14k: rate.price14k,
      price10k: rate.price10k,
      source: rate.source,
    });

    res.json({ goldRate: saved });
  } catch (error) {
    console.error("[FETCH-GOLD-RATE] FAILED:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gold-rate/latest", validateShopifyIdToken, async (req, res) => {
  try {
    const rate = await getLatestGoldRate();
    res.json({ goldRate: rate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/collections", validateShopifyIdToken, async (req, res) => {
  try {
    const token = await getAccessToken();
    const collections = await fetchCollections(token);
    res.json({ collections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/products", validateShopifyIdToken, async (req, res) => {
  try {
    const { collectionId, search, cursor } = req.query;
    if (!collectionId) return res.status(400).json({ error: "collectionId is required." });

    const token = await getAccessToken();
    const result = await fetchProductsInCollection(token, collectionId, search || "", cursor || null);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/product-variants", validateShopifyIdToken, async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) return res.status(400).json({ error: "productId is required." });

    const token = await getAccessToken();
    const result = await fetchProductVariants(token, productId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/update-prices", validateShopifyIdToken, async (req, res) => {
  let run;

  try {
    const settings = await getSettings();
    const goldRate = await getLatestGoldRate();

    if (!goldRate) {
      return res.status(400).json({
        error: 'No gold rate fetched yet. Click "Fetch Latest Gold Rate" first.',
      });
    }

    const goldRatesForPricing = {
      price_24k: goldRate.price_24k,
      price_18k: goldRate.price_18k,
      price_14k: goldRate.price_14k,
      price_10k: goldRate.price_10k,
    };

    validateGoldRates(goldRatesForPricing);

    const requestedVariantIds = Array.isArray(req.body?.variantIds)
      ? req.body.variantIds.filter((id) => typeof id === "string" && id.trim())
      : [];

    run = await createRun(goldRate.id);

    const token = await getAccessToken();

    const variants =
      requestedVariantIds.length > 0
        ? await fetchVariantsByIds(token, requestedVariantIds)
        : (await fetchAllVariants(token)).variants;

    let updatedCount = 0;
    let skippedCount = 0;
    let blockedCount = 0;
    const updatedItems = [];
    const skippedItems = [];

    for (const variant of variants) {
      const evaluation = evaluateVariant(variant, goldRatesForPricing, settings);

      if (evaluation.status === "skipped") {
        skippedCount++;
        await addRunItem(run.id, evaluation);
        skippedItems.push(evaluation);
        continue;
      }

      if (evaluation.status === "blocked") {
        blockedCount++;
        await addRunItem(run.id, evaluation);
        skippedItems.push(evaluation);
        continue;
      }

      try {
        await updateVariantPrice(token, evaluation.productId, evaluation.variantId, evaluation.newPrice);

        const updatedItem = { ...evaluation, status: "updated" };
        updatedCount++;
        await addRunItem(run.id, updatedItem);
        updatedItems.push(updatedItem);
      } catch (updateError) {
        const failedItem = { ...evaluation, status: "failed", reason: updateError.message };
        blockedCount++;
        await addRunItem(run.id, failedItem);
        skippedItems.push(failedItem);
      }
    }

    await completeRun(run.id, {
      status: "completed",
      totalVariants: variants.length,
      updatedCount,
      skippedCount,
      blockedCount,
    });

    res.json({
      runId: run.id,
      scope: requestedVariantIds.length > 0 ? "selected" : "full_catalog",
      summary: {
        total: variants.length,
        updated: updatedCount,
        skipped: skippedCount,
        blocked: blockedCount,
      },
      updatedItems,
      skippedItems,
      goldRate,
    });
  } catch (error) {
    console.error("[UPDATE-PRICES] FAILED:", error);

    if (run) {
      await completeRun(run.id, {
        status: "failed",
        totalVariants: 0,
        updatedCount: 0,
        skippedCount: 0,
        blockedCount: 0,
        errorMessage: error.message,
      }).catch(() => {});
    }

    res.status(500).json({ error: error.message || "Price update failed." });
  }
});

app.get("/api/latest-run", validateShopifyIdToken, async (req, res) => {
  try {
    const latest = await getLatestRunWithItems();
    if (!latest) return res.json({ run: null, updatedItems: [], skippedItems: [] });

    const updatedItems = latest.items.filter((item) => item.status === "updated");
    const skippedItems = latest.items.filter((item) => item.status !== "updated");
    res.json({ run: latest.run, updatedItems, skippedItems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Jewelry Price Automation dashboard running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

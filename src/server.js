import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { analyzePrices } from "./shopify-dry-run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const GITHUB_RAW_GOLD_PRICES_URL = process.env.GITHUB_RAW_GOLD_PRICES_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE || "main.yml";

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

async function fetchGoldPrices() {
  if (!GITHUB_RAW_GOLD_PRICES_URL) return null;
  try {
    const response = await fetch(GITHUB_RAW_GOLD_PRICES_URL);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/api/settings", validateShopifyIdToken, async (req, res) => {
  const rates = await fetchGoldPrices();

  res.json({
    goldSource: "GoodReturns — Surat",
    silverPricePerGram: 300,
    makingChargePercent: 12,
    profitMultiplier: 1.9,
    usdConversionRate: 97,
    finalAdjustmentPercent: 4,
    maxPriceChangePercent: 15,
    automationIntervalHours: 3,
    currentRates: rates,
    lastUpdated: rates?.updatedAt || null,
  });
});

app.get("/api/preview", validateShopifyIdToken, async (req, res) => {
  const rates = await fetchGoldPrices();

  if (!rates) {
    return res.status(503).json({ error: "Gold price data is unavailable right now." });
  }

  try {
    const { results, summary } = await analyzePrices(rates);
    res.json({ results, summary, goldPrices: rates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/trigger-run", validateShopifyIdToken, async (req, res) => {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return res.status(500).json({
      error: "GitHub trigger not configured (missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO env vars).",
    });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    res.json({ status: "triggered" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", validateShopifyIdToken, (req, res) => {
  res.json({ status: "ok", shop: req.shopifyToken.dest });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jewelry Price Automation dashboard running on port ${PORT}`);
});

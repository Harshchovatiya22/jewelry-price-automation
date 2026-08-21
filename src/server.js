import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const GITHUB_RAW_GOLD_PRICES_URL = process.env.GITHUB_RAW_GOLD_PRICES_URL;

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

    if (!payload.iss || !payload.dest) {
      throw new Error("Missing issuer/destination.");
    }

    const issuerHost = new URL(payload.iss).hostname;
    const destinationHost = new URL(payload.dest).hostname;

    if (issuerHost !== destinationHost) {
      throw new Error("Issuer and destination do not match.");
    }

    req.shopifyToken = payload;
    next();
  } catch (error) {
    console.error("Shopify ID token validation failed:", error.message);
    res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    return res.status(401).json({ error: "Invalid Shopify ID token." });
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/api/settings", validateShopifyIdToken, async (req, res) => {
  let rates = null;

  try {
    if (GITHUB_RAW_GOLD_PRICES_URL) {
      const response = await fetch(GITHUB_RAW_GOLD_PRICES_URL);
      if (response.ok) {
        rates = await response.json();
      }
    }
  } catch {
    rates = null;
  }

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

app.get("/health", validateShopifyIdToken, (req, res) => {
  res.json({
    status: "ok",
    shop: req.shopifyToken.dest,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jewelry Price Automation dashboard running on port ${PORT}`);
});
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const API_VERSION = "2026-07";
const METAFIELD_NAMESPACE = "custom";
const SILVER_PRICE_PER_GRAM = 300;
const MAKING_CHARGE_PERCENT = 0.12;
const PROFIT_MULTIPLIER = 1.9;
const USD_CONVERSION_RATE = 97;
const FINAL_ADJUSTMENT = 1.04;
const MAX_VARIANT_PRICE_CHANGE_PERCENT = 15;
const MAX_PRICE_USD = 1000000;

async function getAccessToken() {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`Shopify authentication failed: ${response.status}`);
  }

  return data.access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  return data.data;
}

function validateGoldPrices(prices) {
  for (const key of ["24K", "18K", "14K", "10K"]) {
    if (!Number.isFinite(prices[key]) || prices[key] <= 0) {
      throw new Error(`Invalid ${key} gold price.`);
    }
  }

  const tolerance = 0.01;
  if (Math.abs(prices["18K"] - (prices["24K"] * 18) / 24) > tolerance) {
    throw new Error("18K purity validation failed.");
  }
  if (Math.abs(prices["14K"] - (prices["24K"] * 14) / 24) > tolerance) {
    throw new Error("14K purity validation failed.");
  }
  if (Math.abs(prices["10K"] - (prices["24K"] * 10) / 24) > tolerance) {
    throw new Error("10K purity validation failed.");
  }
}

async function startBulkOperation(token) {
  const mutation = `
    mutation {
      bulkOperationRunQuery(
        query: """
        {
          productVariants {
            edges {
              node {
                id
                title
                price
                sku
                product { id title }
                metafields(namespace: "custom", first: 10) {
                  edges { node { namespace key value } }
                }
              }
            }
          }
        }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphQL(token, mutation);
  const result = data.bulkOperationRunQuery;

  if (result.userErrors?.length) {
    throw new Error(JSON.stringify(result.userErrors));
  }
  if (!result.bulkOperation?.id) {
    throw new Error("Shopify bulk operation did not start.");
  }

  return result.bulkOperation.id;
}

async function waitForBulkOperation(token) {
  const query = `
    query {
      currentBulkOperation(type: QUERY) {
        id
        type
        status
        errorCode
        url
      }
    }
  `;

  while (true) {
    const data = await shopifyGraphQL(token, query);
    const operation = data.currentBulkOperation;

    if (!operation) throw new Error("No Shopify bulk operation found.");

    if (operation.status === "COMPLETED") {
      if (!operation.url) throw new Error("Bulk operation has no result URL.");
      return operation.url;
    }

    if (operation.status === "FAILED" || operation.status === "CANCELED") {
      throw new Error(`Bulk operation ${operation.status}: ${operation.errorCode || "unknown"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function downloadVariants(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download bulk result: ${response.status}`);

  const text = await response.text();
  const variants = new Map();

  for (const line of text.trim().split("\n").filter(Boolean)) {
    const obj = JSON.parse(line);

    if (!obj.__parentId) {
      variants.set(obj.id, {
        id: obj.id,
        title: obj.title,
        price: obj.price,
        sku: obj.sku,
        product: obj.product,
        metafields: { nodes: [] },
      });
    } else {
      const variant = variants.get(obj.__parentId);
      if (variant) {
        variant.metafields.nodes.push({
          namespace: obj.namespace,
          key: obj.key,
          value: obj.value,
        });
      }
    }
  }

  return [...variants.values()];
}

function getMetafield(variant, key) {
  const field = variant.metafields.nodes.find(
    (item) =>
      item.namespace === METAFIELD_NAMESPACE &&
      item.key.toLowerCase() === key.toLowerCase()
  );
  return field?.value ?? null;
}

function numberFromMetafield(value, name) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${name} metafield is missing.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} metafield is invalid.`);
  }
  return number;
}

function detectMetal(value) {
  if (!value) return null;
  const metal = String(value).trim().toUpperCase();
  if (metal.includes("SILVER")) return "SILVER";
  if (/\b18K\b/.test(metal)) return "18K";
  if (/\b14K\b/.test(metal)) return "14K";
  if (/\b10K\b/.test(metal)) return "10K";
  return null;
}

function calculatePrice({ metal, goldPrices, goldWeight, diamondCost, otherCost }) {
  const metalRate = metal === "SILVER" ? SILVER_PRICE_PER_GRAM : goldPrices[metal];

  if (!Number.isFinite(metalRate) || metalRate <= 0) {
    throw new Error(`Invalid metal rate for ${metal}.`);
  }

  const metalCost = goldWeight * metalRate;
  const makingCost = metalCost * MAKING_CHARGE_PERCENT;
  const baseCost = metalCost + diamondCost + makingCost + otherCost;
  const sellingPriceINR = baseCost * PROFIT_MULTIPLIER;
  const sellingPriceUSD = (sellingPriceINR / USD_CONVERSION_RATE) * FINAL_ADJUSTMENT;

  if (!Number.isFinite(sellingPriceUSD) || sellingPriceUSD <= 0 || sellingPriceUSD > MAX_PRICE_USD) {
    throw new Error("Calculated price failed safety validation.");
  }

  return { metalRate, metalCost, makingCost, baseCost, sellingPriceINR, sellingPriceUSD };
}

function validatePriceChange(currentPrice, newPrice) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { safe: false, reason: "Current Shopify price is invalid." };
  }

  const changePercent = ((newPrice - currentPrice) / currentPrice) * 100;

  if (Math.abs(changePercent) > MAX_VARIANT_PRICE_CHANGE_PERCENT) {
    return {
      safe: false,
      reason: `Price change ${changePercent.toFixed(2)}% exceeds 15% safety limit.`,
    };
  }

  return { safe: true, changePercent };
}

/**
 * Core reusable function: given validated gold prices, authenticates,
 * pulls all variants, and returns a structured per-variant result list.
 * Never writes to Shopify.
 */
export async function analyzePrices(goldPrices) {
  validateGoldPrices(goldPrices);

  const token = await getAccessToken();
  const bulkId = await startBulkOperation(token);
  const resultUrl = await waitForBulkOperation(token);
  const variants = await downloadVariants(resultUrl);

  const results = [];

  for (const variant of variants) {
    const base = {
      product: variant.product?.title ?? "Unknown product",
      variant: variant.title,
      sku: variant.sku || "—",
      currentPrice: Number(variant.price),
    };

    try {
      const metal = detectMetal(getMetafield(variant, "metal"));
      if (!metal) throw new Error("Missing or unsupported metal.");

      const goldWeight = numberFromMetafield(getMetafield(variant, "gold_weight"), "Gold Weight");
      const diamondCost = numberFromMetafield(getMetafield(variant, "diamond_cost"), "Diamond Cost");
      const otherCost = numberFromMetafield(getMetafield(variant, "other_cost"), "Other Cost");

      const calc = calculatePrice({ metal, goldPrices, goldWeight, diamondCost, otherCost });
      const newPrice = Number(calc.sellingPriceUSD.toFixed(2));
      const safety = validatePriceChange(base.currentPrice, newPrice);

      if (!safety.safe) {
        results.push({ ...base, metal, status: "blocked", reason: safety.reason });
        continue;
      }

      results.push({
        ...base,
        metal,
        newPrice,
        changePercent: Number(safety.changePercent.toFixed(2)),
        status: "ready",
      });
    } catch (error) {
      results.push({ ...base, status: "skipped", reason: error.message });
    }
  }

  const summary = {
    total: results.length,
    ready: results.filter((r) => r.status === "ready").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    blocked: results.filter((r) => r.status === "blocked").length,
  };

  return { results, summary, bulkId };
}

/*
|--------------------------------------------------------------------------
| CLI ENTRY POINT (used by GitHub Actions workflow)
|--------------------------------------------------------------------------
*/

async function runCli() {
  console.log("======================================");
  console.log("JEWELRY PRICE AUTOMATION - DRY RUN");
  console.log("======================================");

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing Shopify environment variables.");
  }

  const file = await fs.readFile("gold-prices.json", "utf8");
  const goldPrices = JSON.parse(file);

  console.log("\nValidated metal rates:");
  console.log(goldPrices);

  console.log("\nStarting Shopify bulk read...");
  const { results, summary, bulkId } = await analyzePrices(goldPrices);
  console.log(`Bulk operation: ${bulkId}`);
  console.log(`Found ${results.length} variant(s).`);

  console.log("\n======================================");
  console.log("DRY RUN COMPLETE");
  console.log("======================================");
  console.log(`Total variants: ${summary.total}`);
  console.log(`Safe to update: ${summary.ready}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Blocked (unsafe change): ${summary.blocked}`);
  console.log("\nSHOPIFY PRICES WERE NOT CHANGED.");
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch((error) => {
    console.error("\n🚨 DRY RUN FAILED");
    console.error(error.message);
    process.exit(1);
  });
}

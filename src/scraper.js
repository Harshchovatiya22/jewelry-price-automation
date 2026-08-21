import { chromium } from "playwright";
import fs from "node:fs/promises";

const GOODRETURNS_URL =
  "https://www.goodreturns.in/gold-rates/surat.html";

const SHOPIFY_API_VERSION = "2026-07";

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN;

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET;

/*
|--------------------------------------------------------------------------
| PRICING SETTINGS
|--------------------------------------------------------------------------
*/

const PROFIT_MULTIPLIER = 1.9;
const USD_CONVERSION_RATE = 97;
const MAKING_CHARGE_PERCENT = 0.12;

const SILVER_PRICE_PER_GRAM = 300;

/*
|--------------------------------------------------------------------------
| SAFETY SETTINGS
|--------------------------------------------------------------------------
*/

const MIN_24K_PRICE = 5000;
const MAX_24K_PRICE = 50000;

const MAX_VARIANT_PRICE_CHANGE_PERCENT = 15;

const METAFIELD_NAMESPACE = "custom";

const METAFIELDS = {
  metal: "metal",
  goldWeight: "gold_weight",
  diamondCost: "diamond_cost",
  otherCost: "other_cost"
};

/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
*/

function validateEnvironment() {
  const missing = [];

  if (!SHOPIFY_STORE_DOMAIN)
    missing.push("SHOPIFY_STORE_DOMAIN");

  if (!SHOPIFY_CLIENT_ID)
    missing.push("SHOPIFY_CLIENT_ID");

  if (!SHOPIFY_CLIENT_SECRET)
    missing.push("SHOPIFY_CLIENT_SECRET");

  if (missing.length) {
    throw new Error(
      `Missing GitHub Secrets: ${missing.join(", ")}`
    );
  }
}

/*
|--------------------------------------------------------------------------
| GET 24K GOLD PRICE
|--------------------------------------------------------------------------
*/

async function get24KGoldPrice() {
  const browser = await chromium.launch({
    headless: true
  });

  try {
    const page = await browser.newPage();

    await page.goto(GOODRETURNS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const text = await page.locator("body").innerText();

    const match24K = text.match(/24K\s*Gold\s*\/\s*g[\s\S]{0,100}?₹\s*([\d,]+(?:\.\d+)?)/i);

    if (!match24K) {
      throw new Error(
        "24K gold price not found. ALL PRICE UPDATES BLOCKED."
      );
    }

    const price24K = Number(
      match24K[1].replace(/,/g, "")
    );

    if (!Number.isFinite(price24K)) {
      throw new Error(
        "Invalid 24K gold price. ALL PRICE UPDATES BLOCKED."
      );
    }

    if (
      price24K < MIN_24K_PRICE ||
      price24K > MAX_24K_PRICE
    ) {
      throw new Error(
        `24K price ₹${price24K} outside safety range. ALL PRICE UPDATES BLOCKED.`
      );
    }

    return price24K;
  } finally {
    await browser.close();
  }
}

/*
|--------------------------------------------------------------------------
| CALCULATE PURITY RATES
|--------------------------------------------------------------------------
*/

function calculatePurityRates(price24K) {
  return {
    "10K": price24K * 10 / 24,
    "14K": price24K * 14 / 24,
    "18K": price24K * 18 / 24,
    "24K": price24K,
    "SILVER": SILVER_PRICE_PER_GRAM
  };
}

/*
|--------------------------------------------------------------------------
| SHOPIFY AUTHENTICATION
|--------------------------------------------------------------------------
*/

async function getShopifyAccessToken() {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      "Shopify authentication failed. ALL PRICE UPDATES BLOCKED."
    );
  }

  return data.access_token;
}

/*
|--------------------------------------------------------------------------
| SHOPIFY GRAPHQL
|--------------------------------------------------------------------------
*/

async function shopifyGraphQL(
  accessToken,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify API HTTP error ${response.status}.`
    );
  }

  if (data.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data.data;
}

/*
|--------------------------------------------------------------------------
| GET PRODUCTS + VARIANT METAFIELDS
|--------------------------------------------------------------------------
*/

async function getProducts(accessToken) {
  const query = `
    query GetProducts {
      products(first: 250) {
        nodes {
          id
          title

          variants(first: 250) {
            nodes {
              id
              title
              price
              sku

              metafields(first: 50) {
  nodes {
    namespace
    key
    value
  }
}
            }
          }
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      accessToken,
      query
    );

  return data.products.nodes;
}

/*
|--------------------------------------------------------------------------
| METAFIELD HELPER
|--------------------------------------------------------------------------
*/

function getMetafield(
  metafields,
  key
) {
  const field = metafields.find(
    (item) =>
      item &&
      item.namespace === METAFIELD_NAMESPACE &&
      item.key === key
  );

  return field?.value ?? null;
}

/*
|--------------------------------------------------------------------------
| DETECT METAL
|--------------------------------------------------------------------------
*/

function detectMetal(metal) {
  if (!metal) return null;

  const normalized =
    String(metal)
      .trim()
      .toUpperCase();

  if (normalized.includes("SILVER"))
    return "SILVER";

  if (/\b18K\b/.test(normalized))
    return "18K";

  if (/\b14K\b/.test(normalized))
    return "14K";

  if (/\b10K\b/.test(normalized))
    return "10K";

  return null;
}

/*
|--------------------------------------------------------------------------
| NUMBER VALIDATION
|--------------------------------------------------------------------------
*/

function parsePositiveNumber(
  value,
  fieldName
) {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    throw new Error(
      `Invalid ${fieldName}: ${value}`
    );
  }

  return number;
}

/*
|--------------------------------------------------------------------------
| CALCULATE FINAL PRICE
|--------------------------------------------------------------------------
*/

function calculateSellingPrice({
  metal,
  goldWeight,
  diamondCost,
  otherCost,
  metalRates
}) {
  const metalRate =
    metalRates[metal];

  if (
    !Number.isFinite(metalRate) ||
    metalRate <= 0
  ) {
    throw new Error(
      `No valid metal rate available for ${metal}.`
    );
  }

  /*
   * Metal Cost
   *
   * Gold:
   * weight × calculated purity rate
   *
   * Silver:
   * weight × ₹300
   */

  const metalCost =
    goldWeight * metalRate;

  /*
   * Making Cost
   *
   * 12% of metal cost
   */

  const makingCost =
    metalCost * MAKING_CHARGE_PERCENT;

  /*
   * Base Cost
   */

  const baseCost =
    metalCost +
    diamondCost +
    makingCost +
    otherCost;

  /*
   * Selling Price INR
   */

  const sellingPriceINR =
    baseCost * PROFIT_MULTIPLIER;

  /*
   * Convert INR → USD
   */

  const sellingPriceUSD =
    sellingPriceINR /
    USD_CONVERSION_RATE;

  if (
    !Number.isFinite(sellingPriceUSD) ||
    sellingPriceUSD <= 0
  ) {
    throw new Error(
      "Calculated selling price is invalid."
    );
  }

  return {
    metalRate,
    metalCost,
    makingCost,
    baseCost,
    sellingPriceINR,
    sellingPriceUSD
  };
}

/*
|--------------------------------------------------------------------------
| PRICE CHANGE SAFETY
|--------------------------------------------------------------------------
*/

function validatePriceChange(
  currentPrice,
  newPrice
) {
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return {
      safe: false,
      reason:
        "Current Shopify price is invalid."
    };
  }

  if (
    !Number.isFinite(newPrice) ||
    newPrice <= 0
  ) {
    return {
      safe: false,
      reason:
        "Calculated price is invalid."
    };
  }

  const changePercent =
    ((newPrice - currentPrice) /
      currentPrice) *
    100;

  if (
    Math.abs(changePercent) >
    MAX_VARIANT_PRICE_CHANGE_PERCENT
  ) {
    return {
      safe: false,
      reason:
        `Price change ${changePercent.toFixed(2)}% ` +
        `exceeds ${MAX_VARIANT_PRICE_CHANGE_PERCENT}% safety limit.`
    };
  }

  return {
    safe: true,
    changePercent
  };
}

/*
|--------------------------------------------------------------------------
| UPDATE SHOPIFY VARIANTS
|--------------------------------------------------------------------------
*/

async function updateProductVariants(
  accessToken,
  productId,
  variants
) {
  const mutation = `
    mutation UpdateVariants(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
        allowPartialUpdates: false
      ) {
        product {
          id
        }

        productVariants {
          id
          price
        }

        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      accessToken,
      mutation,
      {
        productId,
        variants
      }
    );

  const result =
    data.productVariantsBulkUpdate;

  if (
    result.userErrors &&
    result.userErrors.length > 0
  ) {
    throw new Error(
      `Shopify price update rejected: ${JSON.stringify(
        result.userErrors
      )}`
    );
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  console.log(
    "=========================================="
  );

  console.log(
    "JEWELRY PRICE AUTOMATION"
  );

  console.log(
    "=========================================="
  );

  validateEnvironment();

  /*
   * FETCH 24K
   */

  console.log(
    "\n[1] Fetching 24K gold price..."
  );

  const price24K =
    await get24KGoldPrice();

  console.log(
    `24K = ₹${price24K.toFixed(2)}/gram`
  );

  /*
   * CALCULATE ALL METAL RATES
   */

  const metalRates =
    calculatePurityRates(
      price24K
    );

  await fs.writeFile(
  "gold-prices.json",
  JSON.stringify(metalRates, null, 2),
  "utf8"
);

console.log("Validated metal rates saved to gold-prices.json");

  console.log("\nMETAL RATES:");

  console.log(
    `18K = ₹${metalRates["18K"].toFixed(2)}/g`
  );

  console.log(
    `14K = ₹${metalRates["14K"].toFixed(2)}/g`
  );

  console.log(
    `10K = ₹${metalRates["10K"].toFixed(2)}/g`
  );

  console.log(
    `Silver = ₹${metalRates["SILVER"].toFixed(2)}/g`
  );

  /*
   * SHOPIFY AUTH
   */

  console.log(
    "\n[2] Authenticating Shopify..."
  );

  const accessToken =
    await getShopifyAccessToken();

  console.log(
    "Shopify authentication successful."
  );

  /*
   * READ PRODUCTS
   */

  console.log(
    "\n[3] Reading Shopify products..."
  );

  const products =
    await getProducts(
      accessToken
    );

  console.log(
    `Products found: ${products.length}`
  );

  /*
   * PREPARE ALL UPDATES
   */

  console.log(
    "\n[4] Calculating and validating prices..."
  );

  const updatesByProduct =
    new Map();

  let checked = 0;
  let skipped = 0;

  for (const product of products) {
    const productUpdates = [];

    for (const variant of product.variants.nodes) {
      checked++;

      const metalValue =
        getMetafield(
          variant.metafields,
          METAFIELDS.metal
        );

      const metal =
        detectMetal(metalValue);

      /*
       * Unsupported/missing metal
       */

      if (!metal) {
        console.log(
          `SKIP: ${product.title} / ${variant.title}`
        );

        console.log(
          `Metal: ${metalValue || "missing/unsupported"}`
        );

        skipped++;

        continue;
      }

      const goldWeight =
        parsePositiveNumber(
          getMetafield(
            variant.metafields,
            METAFIELDS.goldWeight
          ),
          "Gold Weight"
        );

      const diamondCost =
        parsePositiveNumber(
          getMetafield(
            variant.metafields,
            METAFIELDS.diamondCost
          ),
          "Diamond Cost"
        );

      const otherCost =
        parsePositiveNumber(
          getMetafield(
            variant.metafields,
            METAFIELDS.otherCost
          ),
          "Other Cost"
        );

      const calculated =
        calculateSellingPrice({
          metal,
          goldWeight,
          diamondCost,
          otherCost,
          metalRates
        });

      const newPrice =
        Number(
          calculated.sellingPriceUSD.toFixed(2)
        );

      const safety =
        validatePriceChange(
          Number(variant.price),
          newPrice
        );

      if (!safety.safe) {
        throw new Error(
          `PRICE UPDATE BLOCKED\n` +
          `${product.title} / ${variant.title}\n` +
          `${safety.reason}`
        );
      }

      console.log(
        `\nAPPROVED: ${product.title}`
      );

      console.log(
        `Variant: ${variant.title}`
      );

      console.log(
        `Metal: ${metal}`
      );

      console.log(
        `Metal Rate: ₹${calculated.metalRate.toFixed(2)}/g`
      );

      console.log(
        `Weight: ${goldWeight}g`
      );

      console.log(
        `Metal Cost: ₹${calculated.metalCost.toFixed(2)}`
      );

      console.log(
        `Making Cost: ₹${calculated.makingCost.toFixed(2)}`
      );

      console.log(
        `Diamond Cost: ₹${diamondCost.toFixed(2)}`
      );

      console.log(
        `Other Cost: ₹${otherCost.toFixed(2)}`
      );

      console.log(
        `Base Cost: ₹${calculated.baseCost.toFixed(2)}`
      );

      console.log(
        `Selling Price INR: ₹${calculated.sellingPriceINR.toFixed(2)}`
      );

      console.log(
        `Old Shopify Price: $${Number(variant.price).toFixed(2)}`
      );

      console.log(
        `New Shopify Price: $${newPrice.toFixed(2)}`
      );

      console.log(
        `Change: ${safety.changePercent.toFixed(2)}%`
      );

      productUpdates.push({
        id: variant.id,
        price: newPrice
      });
    }

    if (productUpdates.length > 0) {
      updatesByProduct.set(
        product.id,
        productUpdates
      );
    }
  }

  /*
   * FINAL SAFETY CHECK
   */

  console.log(
    "\n[5] FINAL SAFETY CHECK..."
  );

  console.log(
    `Variants checked: ${checked}`
  );

  console.log(
    `Variants skipped: ${skipped}`
  );

  console.log(
    `Products prepared: ${updatesByProduct.size}`
  );

  /*
   * UPDATE SHOPIFY
   */

  console.log(
    "\n[6] Updating Shopify prices..."
  );

  let updated = 0;

  for (const [
    productId,
    variants
  ] of updatesByProduct) {
    await updateProductVariants(
      accessToken,
      productId,
      variants
    );

    updated += variants.length;

    console.log(
      `Updated ${variants.length} variants.`
    );
  }

  /*
   * COMPLETE
   */

  console.log(
    "\n=========================================="
  );

  console.log(
    "PRICE AUTOMATION COMPLETED"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `24K Gold: ₹${price24K.toFixed(2)}/g`
  );

  console.log(
    `Silver: ₹${SILVER_PRICE_PER_GRAM.toFixed(2)}/g`
  );

  console.log(
    `Variants updated: ${updated}`
  );

  console.log(
    `Variants skipped: ${skipped}`
  );

  console.log(
    "=========================================="
  );
}

main().catch((error) => {
  console.error(
    "\n=========================================="
  );

  console.error(
    "🚨 PRICE AUTOMATION STOPPED"
  );

  console.error(
    "=========================================="
  );

  console.error(error.message);

  console.error(
    "\nNO FURTHER PRICE UPDATES WERE ATTEMPTED."
  );

  process.exit(1);
});

import { chromium } from "playwright";

const GOODRETURNS_URL =
  "https://www.goodreturns.in/gold-rates/surat.html";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

/*
|--------------------------------------------------------------------------
| SAFETY LIMITS
|--------------------------------------------------------------------------
| These are deliberately conservative.
| We will NOT allow automation to proceed if the source data looks wrong.
*/

const MAX_GOLD_RATE_CHANGE_PERCENT = 10;

// Never allow calculated jewelry prices to move more than this
// during one automation run.
const MAX_VARIANT_PRICE_CHANGE_PERCENT = 15;

// Absolute sanity boundaries for 24K gold per gram.
const MIN_24K_PRICE = 5000;
const MAX_24K_PRICE = 50000;

function assertEnvironment() {
  const missing = [];

  if (!SHOPIFY_STORE_DOMAIN) {
    missing.push("SHOPIFY_STORE_DOMAIN");
  }

  if (!SHOPIFY_CLIENT_ID) {
    missing.push("SHOPIFY_CLIENT_ID");
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    missing.push("SHOPIFY_CLIENT_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

/*
|--------------------------------------------------------------------------
| GET 24K GOLD PRICE
|--------------------------------------------------------------------------
*/

async function getGoldPrice() {
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

    const match24K = text.match(
      /24\s*Carat[\s\S]{0,500}?₹?\s*([\d,]+(?:\.\d+)?)/i
    );

    if (!match24K) {
      throw new Error(
        "24K gold price not found. PRICE UPDATE BLOCKED."
      );
    }

    const price24K = Number(
      match24K[1].replace(/,/g, "")
    );

    if (!Number.isFinite(price24K)) {
      throw new Error(
        `Invalid 24K gold price: ${price24K}. PRICE UPDATE BLOCKED.`
      );
    }

    if (price24K < MIN_24K_PRICE || price24K > MAX_24K_PRICE) {
      throw new Error(
        `24K gold price ${price24K} is outside the allowed range ` +
        `(${MIN_24K_PRICE}-${MAX_24K_PRICE}). PRICE UPDATE BLOCKED.`
      );
    }

    return price24K;
  } finally {
    await browser.close();
  }
}

/*
|--------------------------------------------------------------------------
| CALCULATE GOLD PURITY PRICES
|--------------------------------------------------------------------------
*/

function calculateGoldPrices(price24K) {
  const prices = {
    "24K": price24K,
    "18K": price24K * 18 / 24,
    "14K": price24K * 14 / 24,
    "10K": price24K * 10 / 24
  };

  for (const [karat, price] of Object.entries(prices)) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `Invalid calculated ${karat} price. PRICE UPDATE BLOCKED.`
      );
    }
  }

  return prices;
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
        "Content-Type": "application/x-www-form-urlencoded"
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
      `Shopify authentication failed. PRICE UPDATE BLOCKED.`
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
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`,
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
      `Shopify API request failed. PRICE UPDATE BLOCKED.`
    );
  }

  if (data.errors) {
    throw new Error(
      `Shopify GraphQL error. PRICE UPDATE BLOCKED.`
    );
  }

  return data.data;
}

/*
|--------------------------------------------------------------------------
| READ SHOPIFY PRODUCTS
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
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    accessToken,
    query
  );

  return data.products.nodes;
}

/*
|--------------------------------------------------------------------------
| PRICE CHANGE SAFETY CHECK
|--------------------------------------------------------------------------
*/

function validatePriceChange(oldPrice, newPrice) {
  const oldValue = Number(oldPrice);
  const newValue = Number(newPrice);

  if (
    !Number.isFinite(oldValue) ||
    !Number.isFinite(newValue) ||
    oldValue <= 0 ||
    newValue <= 0
  ) {
    return {
      safe: false,
      reason: "Invalid old/new price"
    };
  }

  const changePercent =
    ((newValue - oldValue) / oldValue) * 100;

  if (
    Math.abs(changePercent) >
    MAX_VARIANT_PRICE_CHANGE_PERCENT
  ) {
    return {
      safe: false,
      reason:
        `Price change of ${changePercent.toFixed(2)}% ` +
        `exceeds safety limit of ${MAX_VARIANT_PRICE_CHANGE_PERCENT}%`
    };
  }

  return {
    safe: true,
    changePercent
  };
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  console.log("======================================");
  console.log("JEWELRY PRICE AUTOMATION");
  console.log("SAFE DRY-RUN MODE");
  console.log("======================================");

  assertEnvironment();

  /*
   * STEP 1
   */

  console.log("\n[1/5] Getting 24K gold price...");

  const price24K = await getGoldPrice();

  console.log(`24K GOLD: ₹${price24K.toFixed(2)}/gram`);

  /*
   * STEP 2
   */

  console.log("\n[2/5] Calculating purity prices...");

  const goldPrices =
    calculateGoldPrices(price24K);

  console.log(
    `18K: ₹${goldPrices["18K"].toFixed(2)}`
  );

  console.log(
    `14K: ₹${goldPrices["14K"].toFixed(2)}`
  );

  console.log(
    `10K: ₹${goldPrices["10K"].toFixed(2)}`
  );

  /*
   * STEP 3
   */

  console.log("\n[3/5] Authenticating with Shopify...");

  const accessToken =
    await getShopifyAccessToken();

  console.log("Shopify authentication successful.");

  /*
   * STEP 4
   */

  console.log("\n[4/5] Reading Shopify products...");

  const products =
    await getProducts(accessToken);

  console.log(
    `Products found: ${products.length}`
  );

  /*
   * STEP 5
   */

  console.log("\n[5/5] Running safety validation...");

  let variantCount = 0;
  let blockedCount = 0;

  for (const product of products) {
    for (const variant of product.variants.nodes) {
      variantCount++;

      const currentPrice =
        Number(variant.price);

      /*
       * IMPORTANT:
       *
       * We are NOT changing the Shopify price yet.
       *
       * The actual jewelry pricing formula will be
       * added after we confirm exactly how your
       * product variants represent gold weight,
       * diamond cost, making charges, etc.
       */

      if (
        !Number.isFinite(currentPrice) ||
        currentPrice <= 0
      ) {
        console.log(
          `BLOCKED: ${product.title} / ${variant.title}`
        );

        console.log(
          "Reason: Invalid Shopify price."
        );

        blockedCount++;
      }
    }
  }

  /*
   * FINAL SAFETY RESULT
   */

  console.log("\n======================================");
  console.log("SAFETY CHECK RESULT");
  console.log("======================================");

  console.log(
    `Variants checked: ${variantCount}`
  );

  console.log(
    `Variants blocked: ${blockedCount}`
  );

  console.log(
    `24K gold price: ₹${price24K.toFixed(2)}`
  );

  console.log(
    `Maximum allowed gold-rate movement: ${MAX_GOLD_RATE_CHANGE_PERCENT}%`
  );

  console.log(
    `Maximum allowed variant movement: ${MAX_VARIANT_PRICE_CHANGE_PERCENT}%`
  );

  console.log("\n⚠️ DRY-RUN ONLY");
  console.log("⚠️ NO SHOPIFY PRICES WERE CHANGED.");
  console.log("======================================");
}

main().catch((error) => {
  console.error("\n======================================");
  console.error("AUTOMATION STOPPED");
  console.error("======================================");
  console.error(error.message);
  console.error("\nNO SHOPIFY PRICES WERE CHANGED.");

  process.exit(1);
});

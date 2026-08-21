import { chromium } from "playwright";

const GOODRETURNS_URL =
  "https://www.goodreturns.in/gold-rates/surat.html";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (
  !SHOPIFY_STORE_DOMAIN ||
  !SHOPIFY_CLIENT_ID ||
  !SHOPIFY_CLIENT_SECRET
) {
  throw new Error(
    "Missing Shopify environment variables: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET"
  );
}

/* -------------------------------------------------------
   1. GET 24K GOLD PRICE
------------------------------------------------------- */

async function getGoldPrices() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(GOODRETURNS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const text = await page.locator("body").innerText();

    const match24K = text.match(
      /24\s*Carat[\s\S]{0,500}?₹?\s*([\d,]+(?:\.\d+)?)/i
    );

    if (!match24K) {
      throw new Error("24K gold price not found");
    }

    const price24K = Number(
      match24K[1].replace(/,/g, "")
    );

    if (!Number.isFinite(price24K) || price24K <= 0) {
      throw new Error(`Invalid 24K gold price: ${price24K}`);
    }

    const prices = {
      "24K": price24K,
      "18K": price24K * 18 / 24,
      "14K": price24K * 14 / 24,
      "10K": price24K * 10 / 24
    };

    return prices;
  } finally {
    await browser.close();
  }
}

/* -------------------------------------------------------
   2. GET SHOPIFY ACCESS TOKEN
------------------------------------------------------- */

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
      `Shopify authentication failed: ${JSON.stringify(data)}`
    );
  }

  return data.access_token;
}

/* -------------------------------------------------------
   3. SHOPIFY GRAPHQL REQUEST
------------------------------------------------------- */

async function shopifyGraphQL(accessToken, query, variables = {}) {
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
      `Shopify API request failed: ${JSON.stringify(data)}`
    );
  }

  if (data.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data.data;
}

/* -------------------------------------------------------
   4. READ PRODUCTS + VARIANTS
------------------------------------------------------- */

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

  const data = await shopifyGraphQL(accessToken, query);

  return data.products.nodes;
}

/* -------------------------------------------------------
   5. MAIN
------------------------------------------------------- */

async function main() {
  console.log("======================================");
  console.log("JEWELRY PRICE AUTOMATION");
  console.log("======================================");

  console.log("\nGetting 24K gold price...");

  const prices = await getGoldPrices();

  console.log("\nGOLD PRICES PER GRAM:");
  console.log(prices);

  console.log("\nAuthenticating with Shopify...");

  const accessToken = await getShopifyAccessToken();

  console.log("Shopify authentication successful.");

  console.log("\nReading Shopify products...");

  const products = await getProducts(accessToken);

  console.log(`Shopify products found: ${products.length}`);

  for (const product of products) {
    console.log(`\nPRODUCT: ${product.title}`);

    for (const variant of product.variants.nodes) {
      console.log(
        `  ${variant.title} | Current price: ${variant.price} | SKU: ${
          variant.sku || "N/A"
        }`
      );
    }
  }

  console.log("\n======================================");
  console.log("SAFE TEST COMPLETED");
  console.log("NO SHOPIFY PRICES WERE CHANGED");
  console.log("======================================");
}

main().catch((error) => {
  console.error("\nAUTOMATION FAILED:");
  console.error(error.message);
  process.exit(1);
});

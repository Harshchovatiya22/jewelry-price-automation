import fs from "node:fs/promises";

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN;

const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET;

const API_VERSION = "2026-07";

const METAFIELD_NAMESPACE = "custom";

const SILVER_PRICE_PER_GRAM = 300;

const PROFIT_MULTIPLIER = 1.9;

const USD_CONVERSION_RATE = 97;

const MAKING_CHARGE_PERCENT = 0.12;

/*
|--------------------------------------------------------------------------
| SAFETY
|--------------------------------------------------------------------------
*/

const MAX_VARIANT_PRICE_CHANGE_PERCENT = 15;

const MAX_PRICE_USD = 1000000;

/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
*/

if (
  !SHOPIFY_STORE_DOMAIN ||
  !SHOPIFY_CLIENT_ID ||
  !SHOPIFY_CLIENT_SECRET
) {
  throw new Error(
    "Missing Shopify environment variables."
  );
}

/*
|--------------------------------------------------------------------------
| SHOPIFY AUTHENTICATION
|--------------------------------------------------------------------------
*/

async function getAccessToken() {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Shopify authentication failed: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(
      "Shopify access token was not returned."
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
  token,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
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
      `Shopify API HTTP error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  if (data.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data.data;
}

/*
|--------------------------------------------------------------------------
| START BULK OPERATION
|--------------------------------------------------------------------------
*/

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

                product {
                  id
                  title
                }

                metafields(namespace: "custom", first: 10) {
                  edges {
                    node {
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
        """
      ) {
        bulkOperation {
          id
          status
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      token,
      mutation
    );

  const result =
    data.bulkOperationRunQuery;

  if (
    result.userErrors &&
    result.userErrors.length > 0
  ) {
    throw new Error(
      `Bulk operation failed to start: ${JSON.stringify(
        result.userErrors
      )}`
    );
  }

  if (!result.bulkOperation?.id) {
    throw new Error(
      "Shopify did not return a bulk operation ID."
    );
  }

  return result.bulkOperation.id;
}

/*
|--------------------------------------------------------------------------
| WAIT FOR BULK OPERATION
|--------------------------------------------------------------------------
*/

async function waitForBulkOperation(token) {
  const query = `
    query {
      currentBulkOperation {
        id
        status
        errorCode
        url
      }
    }
  `;

  while (true) {
    const data =
      await shopifyGraphQL(
        token,
        query
      );

    const operation =
      data.currentBulkOperation;

    if (!operation) {
      throw new Error(
        "No Shopify bulk operation found."
      );
    }

    console.log(
      `Bulk status: ${operation.status}`
    );

    if (
      operation.status === "COMPLETED"
    ) {
      if (!operation.url) {
        throw new Error(
          "Bulk operation completed but no result URL was returned."
        );
      }

      return operation.url;
    }

    if (
      operation.status === "FAILED" ||
      operation.status === "CANCELED"
    ) {
      throw new Error(
        `Bulk operation ${operation.status}: ${
          operation.errorCode || "unknown error"
        }`
      );
    }

    await new Promise(
      (resolve) => setTimeout(resolve, 3000)
    );
  }
}

/*
|--------------------------------------------------------------------------
| DOWNLOAD + PARSE BULK RESULT
|--------------------------------------------------------------------------
*/

async function downloadAndParseVariants(url) {
  if (!url) {
    return [];
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download Shopify bulk result: ${response.status}`
    );
  }

  const text =
    await response.text();

  const lines =
    text
      .trim()
      .split("\n")
      .filter(Boolean);

  const variantsById =
    new Map();

  for (const line of lines) {
    let obj;

    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(
        "Shopify bulk result contained invalid JSON."
      );
    }

    /*
     * Variant object
     */
    if (!obj.__parentId) {
      variantsById.set(
        obj.id,
        {
          id: obj.id,
          title: obj.title,
          price: obj.price,
          sku: obj.sku,

          product:
            obj.product || {
              id: null,
              title: "Unknown Product"
            },

          metafields: {
            nodes: []
          }
        }
      );

      continue;
    }

    /*
     * Metafield object
     */
    if (
      variantsById.has(
        obj.__parentId
      )
    ) {
      variantsById
        .get(obj.__parentId)
        .metafields.nodes.push({
          namespace:
            obj.namespace ||
            METAFIELD_NAMESPACE,

          key: obj.key,

          value: obj.value
        });
    }
  }

  return Array.from(
    variantsById.values()
  );
}

/*
|--------------------------------------------------------------------------
| READ GOLD PRICES
|--------------------------------------------------------------------------
*/

async function getGoldPrices() {
  let file;

  try {
    file =
      await fs.readFile(
        "gold-prices.json",
        "utf8"
      );
  } catch {
    throw new Error(
      "gold-prices.json was not created by the scraper."
    );
  }

  let prices;

  try {
    prices =
      JSON.parse(file);
  } catch {
    throw new Error(
      "gold-prices.json contains invalid JSON."
    );
  }

  validateGoldPrices(
    prices
  );

  return prices;
}

/*
|--------------------------------------------------------------------------
| VALIDATE GOLD PRICES
|--------------------------------------------------------------------------
*/

function validateGoldPrices(prices) {
  const required =
    [
      "24K",
      "18K",
      "14K",
      "10K"
    ];

  for (const key of required) {
    if (
      typeof prices[key] !== "number" ||
      !Number.isFinite(prices[key]) ||
      prices[key] <= 0
    ) {
      throw new Error(
        `Invalid ${key} gold price.`
      );
    }
  }

  const expected18 =
    prices["24K"] * 18 / 24;

  const expected14 =
    prices["24K"] * 14 / 24;

  const expected10 =
    prices["24K"] * 10 / 24;

  const tolerance =
    0.01;

  if (
    Math.abs(
      prices["18K"] - expected18
    ) > tolerance
  ) {
    throw new Error(
      "18K price failed purity validation."
    );
  }

  if (
    Math.abs(
      prices["14K"] - expected14
    ) > tolerance
  ) {
    throw new Error(
      "14K price failed purity validation."
    );
  }

  if (
    Math.abs(
      prices["10K"] - expected10
    ) > tolerance
  ) {
    throw new Error(
      "10K price failed purity validation."
    );
  }
}

/*
|--------------------------------------------------------------------------
| METAFIELD HELPER
|--------------------------------------------------------------------------
*/

function getMetafield(
  variant,
  key
) {
  const metafield =
    variant.metafields.nodes.find(
      (item) =>
        item.namespace ===
          METAFIELD_NAMESPACE &&
        item.key.toLowerCase() ===
          key.toLowerCase()
    );

  return (
    metafield?.value ?? null
  );
}

/*
|--------------------------------------------------------------------------
| NUMBER VALIDATION
|--------------------------------------------------------------------------
*/

function numberFromMetafield(
  value,
  name
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    throw new Error(
      `${name} metafield is missing.`
    );
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    throw new Error(
      `${name} metafield contains an invalid number: ${value}`
    );
  }

  return number;
}

/*
|--------------------------------------------------------------------------
| DETECT METAL
|--------------------------------------------------------------------------
*/

function detectMetal(metal) {
  if (!metal) {
    return null;
  }

  const normalized =
    String(metal)
      .trim()
      .toUpperCase();

  if (
    normalized.includes("SILVER")
  ) {
    return "SILVER";
  }

  if (
    /\b18K\b/.test(normalized)
  ) {
    return "18K";
  }

  if (
    /\b14K\b/.test(normalized)
  ) {
    return "14K";
  }

  if (
    /\b10K\b/.test(normalized)
  ) {
    return "10K";
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| CALCULATE FINAL PRICE
|--------------------------------------------------------------------------
*/

function calculatePrice({
  metal,
  goldPrices,
  goldWeight,
  diamondCost,
  otherCost
}) {
  let metalRate;

  if (metal === "SILVER") {
    metalRate =
      SILVER_PRICE_PER_GRAM;
  } else {
    metalRate =
      goldPrices[metal];
  }

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
   */

  const metalCost =
    goldWeight *
    metalRate;

  /*
   * Making Cost = 12% of Metal Cost
   */

  const makingCost =
    metalCost *
    MAKING_CHARGE_PERCENT;

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
    baseCost *
    PROFIT_MULTIPLIER;

  /*
   * Selling Price USD
   */

  const sellingPriceUSD =
    sellingPriceINR /
    USD_CONVERSION_RATE;

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
| CALCULATED PRICE SAFETY
|--------------------------------------------------------------------------
*/

function validateCalculatedPrice(
  result
) {
  if (
    !Number.isFinite(
      result.sellingPriceINR
    ) ||
    !Number.isFinite(
      result.sellingPriceUSD
    ) ||
    result.sellingPriceINR <= 0 ||
    result.sellingPriceUSD <= 0
  ) {
    throw new Error(
      "Calculated price failed safety validation."
    );
  }

  if (
    result.sellingPriceUSD >
    MAX_PRICE_USD
  ) {
    throw new Error(
      "Calculated price exceeds emergency safety limit."
    );
  }
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
    throw new Error(
      "Current Shopify price is invalid."
    );
  }

  if (
    !Number.isFinite(newPrice) ||
    newPrice <= 0
  ) {
    throw new Error(
      "Calculated Shopify price is invalid."
    );
  }

  const changePercent =
    (
      (newPrice - currentPrice) /
      currentPrice
    ) * 100;

  if (
    Math.abs(changePercent) >
    MAX_VARIANT_PRICE_CHANGE_PERCENT
  ) {
    throw new Error(
      `Price change ${changePercent.toFixed(2)}% exceeds ${MAX_VARIANT_PRICE_CHANGE_PERCENT}% safety limit.`
    );
  }

  return changePercent;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  console.log(
    "======================================"
  );

  console.log(
    "JEWELRY PRICE AUTOMATION - DRY RUN"
  );

  console.log(
    "======================================"
  );

  /*
  |--------------------------------------------------------------------------
  | AUTHENTICATE
  |--------------------------------------------------------------------------
  */

  console.log(
    "\n[1] Authenticating Shopify..."
  );

  const token =
    await getAccessToken();

  console.log(
    "Shopify authentication successful."
  );

  /*
  |--------------------------------------------------------------------------
  | GOLD PRICES
  |--------------------------------------------------------------------------
  */

  console.log(
    "\n[2] Reading validated gold prices..."
  );

  const goldPrices =
    await getGoldPrices();

  console.log(
    `24K = ₹${goldPrices["24K"]}/g`
  );

  console.log(
    `18K = ₹${goldPrices["18K"]}/g`
  );

  console.log(
    `14K = ₹${goldPrices["14K"]}/g`
  );

  console.log(
    `10K = ₹${goldPrices["10K"]}/g`
  );

  console.log(
    `Silver = ₹${SILVER_PRICE_PER_GRAM}/g`
  );

  /*
  |--------------------------------------------------------------------------
  | BULK READ
  |--------------------------------------------------------------------------
  */

  console.log(
    "\n[3] Starting Shopify bulk read..."
  );

  const bulkOperationId =
    await startBulkOperation(
      token
    );

  console.log(
    `Bulk operation started: ${bulkOperationId}`
  );

  const resultUrl =
    await waitForBulkOperation(
      token
    );

  console.log(
    "Bulk operation completed."
  );

  console.log(
    "\nDownloading Shopify catalog..."
  );

  const variants =
    await downloadAndParseVariants(
      resultUrl
    );

  console.log(
    `Found ${variants.length} variant(s).`
  );

  /*
  |--------------------------------------------------------------------------
  | PROCESS
  |--------------------------------------------------------------------------
  */

  let processed = 0;

  let skipped = 0;

  for (
    const variant of variants
  ) {
    try {
      const metalValue =
        getMetafield(
          variant,
          "metal"
        );

      const metal =
        detectMetal(
          metalValue
        );

      if (!metal) {
        throw new Error(
          `Unsupported or missing metal: ${
            metalValue || "missing"
          }`
        );
      }

      const goldWeight =
        numberFromMetafield(
          getMetafield(
            variant,
            "gold_weight"
          ),
          "Gold Weight"
        );

      const diamondCost =
        numberFromMetafield(
          getMetafield(
            variant,
            "diamond_cost"
          ),
          "Diamond Cost"
        );

      const otherCost =
        numberFromMetafield(
          getMetafield(
            variant,
            "other_cost"
          ),
          "Other Cost"
        );

      const result =
        calculatePrice({
          metal,
          goldPrices,
          goldWeight,
          diamondCost,
          otherCost
        });

      validateCalculatedPrice(
        result
      );

      const proposedPrice =
        Number(
          result.sellingPriceUSD.toFixed(2)
        );

      const currentPrice =
        Number(
          variant.price
        );

      const changePercent =
        validatePriceChange(
          currentPrice,
          proposedPrice
        );

      console.log(
        "\n--------------------------------------"
      );

      console.log(
        `Product: ${variant.product?.title || "Unknown"}`
      );

      console.log(
        `Variant: ${variant.title}`
      );

      console.log(
        `SKU: ${variant.sku || "N/A"}`
      );

      console.log(
        `Metal: ${metal}`
      );

      console.log(
        `Gold Weight: ${goldWeight} g`
      );

      console.log(
        `Diamond Cost: ₹${diamondCost}`
      );

      console.log(
        `Other Cost: ₹${otherCost}`
      );

      console.log(
        `Metal Rate: ₹${result.metalRate.toFixed(2)}/g`
      );

      console.log(
        `Metal Cost: ₹${result.metalCost.toFixed(2)}`
      );

      console.log(
        `Making Cost (12%): ₹${result.makingCost.toFixed(2)}`
      );

      console.log(
        `Base Cost: ₹${result.baseCost.toFixed(2)}`
      );

      console.log(
        `PROPOSED INR PRICE: ₹${result.sellingPriceINR.toFixed(2)}`
      );

      console.log(
        `CURRENT SHOPIFY PRICE: $${currentPrice.toFixed(2)}`
      );

      console.log(
        `PROPOSED USD PRICE: $${proposedPrice.toFixed(2)}`
      );

      console.log(
        `PRICE CHANGE: ${changePercent.toFixed(2)}%`
      );

      console.log(
        "ACTION: DRY RUN — NO UPDATE"
      );

      processed++;

    } catch (error) {
      skipped++;

      console.log(
        "\n--------------------------------------"
      );

      console.log(
        `SKIPPED: ${variant.product?.title || "Unknown"}`
      );

      console.log(
        `Variant: ${variant.title}`
      );

      console.log(
        `Reason: ${error.message}`
      );

      console.log(
        "ACTION: NO UPDATE"
      );
    }
  }

  /*
  |--------------------------------------------------------------------------
  | FINAL RESULT
  |--------------------------------------------------------------------------
  */

  console.log(
    "\n======================================"
  );

  console.log(
    "DRY RUN COMPLETE"
  );

  console.log(
    "======================================"
  );

  console.log(
    `Processed: ${processed}`
  );

  console.log(
    `Skipped: ${skipped}`
  );

  console.log(
    "\nSHOPIFY PRICES WERE NOT CHANGED."
  );
}

await main();

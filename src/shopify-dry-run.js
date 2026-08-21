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

const MAKING_CHARGE_PERCENT = 0.12;

const PROFIT_MULTIPLIER = 1.9;

const USD_CONVERSION_RATE = 97;

const FINAL_ADJUSTMENT = 1.04;

const MAX_VARIANT_PRICE_CHANGE_PERCENT = 15;

const MAX_PRICE_USD = 1000000;

if (
  !SHOPIFY_STORE_DOMAIN ||
  !SHOPIFY_CLIENT_ID ||
  !SHOPIFY_CLIENT_SECRET
) {
  throw new Error(
    "Missing Shopify environment variables."
  );
}

async function getAccessToken() {
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

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    throw new Error(
      `Shopify authentication failed: ${response.status}`
    );
  }

  return data.access_token;
}

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

  const data =
    await response.json();

  if (
    !response.ok ||
    data.errors?.length
  ) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(
        data.errors || data
      )}`
    );
  }

  return data.data;
}

async function getGoldPrices() {
  const file =
    await fs.readFile(
      "gold-prices.json",
      "utf8"
    );

  const prices =
    JSON.parse(file);

  for (
    const key of [
      "24K",
      "18K",
      "14K",
      "10K"
    ]
  ) {
    if (
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

  if (
    Math.abs(
      prices["18K"] - expected18
    ) > 0.01
  ) {
    throw new Error(
      "18K purity validation failed."
    );
  }

  if (
    Math.abs(
      prices["14K"] - expected14
    ) > 0.01
  ) {
    throw new Error(
      "14K purity validation failed."
    );
  }

  if (
    Math.abs(
      prices["10K"] - expected10
    ) > 0.01
  ) {
    throw new Error(
      "10K purity validation failed."
    );
  }

  return prices;
}

/*
|--------------------------------------------------------------------------
| SHOPIFY BULK READ
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

                metafields(
                  namespace: "custom"
                  first: 10
                ) {
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
    result.userErrors?.length
  ) {
    throw new Error(
      JSON.stringify(
        result.userErrors
      )
    );
  }

  if (
    !result.bulkOperation?.id
  ) {
    throw new Error(
      "Shopify bulk operation did not start."
    );
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
      operation.status ===
      "COMPLETED"
    ) {
      if (!operation.url) {
        throw new Error(
          "Bulk operation has no result URL."
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
          operation.errorCode || "unknown"
        }`
      );
    }

    await new Promise(
      resolve =>
        setTimeout(resolve, 3000)
    );
  }
}

async function downloadVariants(url) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download bulk result: ${response.status}`
    );
  }

  const text =
    await response.text();

  const variants =
    new Map();

  for (
    const line of text
      .trim()
      .split("\n")
      .filter(Boolean)
  ) {
    const obj =
      JSON.parse(line);

    if (!obj.__parentId) {
      variants.set(
        obj.id,
        {
          id: obj.id,
          title: obj.title,
          price: obj.price,
          sku: obj.sku,

          product:
            obj.product,

          metafields: {
            nodes: []
          }
        }
      );
    } else {
      const variant =
        variants.get(
          obj.__parentId
        );

      if (variant) {
        variant.metafields.nodes.push(
          {
            namespace:
              obj.namespace,
            key: obj.key,
            value: obj.value
          }
        );
      }
    }
  }

  return [
    ...variants.values()
  ];
}

/*
|--------------------------------------------------------------------------
| METAFIELDS
|--------------------------------------------------------------------------
*/

function getMetafield(
  variant,
  key
) {
  const field =
    variant.metafields.nodes.find(
      item =>
        item.namespace ===
          METAFIELD_NAMESPACE &&
        item.key.toLowerCase() ===
          key.toLowerCase()
    );

  return field?.value ?? null;
}

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
      `${name} metafield is invalid.`
    );
  }

  return number;
}

function detectMetal(value) {
  if (!value) {
    return null;
  }

  const metal =
    String(value)
      .trim()
      .toUpperCase();

  if (
    metal.includes("SILVER")
  ) {
    return "SILVER";
  }

  if (
    /\b18K\b/.test(metal)
  ) {
    return "18K";
  }

  if (
    /\b14K\b/.test(metal)
  ) {
    return "14K";
  }

  if (
    /\b10K\b/.test(metal)
  ) {
    return "10K";
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| PRICE FORMULA
|--------------------------------------------------------------------------
*/

function calculatePrice({
  metal,
  goldPrices,
  goldWeight,
  diamondCost,
  otherCost
}) {
  const metalRate =
    metal === "SILVER"
      ? SILVER_PRICE_PER_GRAM
      : goldPrices[metal];

  if (
    !Number.isFinite(metalRate) ||
    metalRate <= 0
  ) {
    throw new Error(
      `Invalid metal rate for ${metal}.`
    );
  }

  const metalCost =
    goldWeight * metalRate;

  const makingCost =
    metalCost *
    MAKING_CHARGE_PERCENT;

  const baseCost =
    metalCost +
    diamondCost +
    makingCost +
    otherCost;

  const sellingPriceINR =
    baseCost *
    PROFIT_MULTIPLIER;

  const sellingPriceUSD =
    (
      sellingPriceINR /
      USD_CONVERSION_RATE
    ) *
    FINAL_ADJUSTMENT;

  if (
    !Number.isFinite(
      sellingPriceUSD
    ) ||
    sellingPriceUSD <= 0 ||
    sellingPriceUSD >
      MAX_PRICE_USD
  ) {
    throw new Error(
      "Calculated price failed safety validation."
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
    !Number.isFinite(
      currentPrice
    ) ||
    currentPrice <= 0
  ) {
    return {
      safe: false,
      reason:
        "Current Shopify price is invalid."
    };
  }

  const changePercent =
    (
      (newPrice -
        currentPrice) /
      currentPrice
    ) * 100;

  if (
    Math.abs(changePercent) >
    MAX_VARIANT_PRICE_CHANGE_PERCENT
  ) {
    return {
      safe: false,
      reason:
        `Price change ${changePercent.toFixed(2)}% exceeds 15% safety limit.`
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
  console.log(
    "======================================"
  );

  console.log(
    "JEWELRY PRICE AUTOMATION - DRY RUN"
  );

  console.log(
    "======================================"
  );

  const token =
    await getAccessToken();

  console.log(
    "Shopify authentication successful."
  );

  const goldPrices =
    await getGoldPrices();

  console.log(
    "\nValidated metal rates:"
  );

  console.log(goldPrices);

  console.log(
    "\nStarting Shopify bulk read..."
  );

  const bulkId =
    await startBulkOperation(
      token
    );

  console.log(
    `Bulk operation started: ${bulkId}`
  );

  const resultUrl =
    await waitForBulkOperation(
      token
    );

  const variants =
    await downloadVariants(
      resultUrl
    );

  console.log(
    `Found ${variants.length} variant(s).`
  );

  let processed = 0;
  let skipped = 0;

  const reasons = {};

  for (
    const variant of variants
  ) {
    try {
      const metal =
        detectMetal(
          getMetafield(
            variant,
            "metal"
          )
        );

      if (!metal) {
        throw new Error(
          "Missing or unsupported metal."
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

      const newPrice =
        Number(
          result.sellingPriceUSD
            .toFixed(2)
        );

      const safety =
        validatePriceChange(
          Number(variant.price),
          newPrice
        );

      if (!safety.safe) {
        throw new Error(
          safety.reason
        );
      }

      processed++;

      /*
       * Do NOT print 40,000 successful
       * variants to GitHub logs.
       */

    } catch (error) {
      skipped++;

      const reason =
        error.message;

      reasons[reason] =
        (reasons[reason] || 0) + 1;
    }
  }

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
    `Total variants: ${variants.length}`
  );

  console.log(
    `Safe to update: ${processed}`
  );

  console.log(
    `Blocked/skipped: ${skipped}`
  );

  console.log(
    "\nSkip reasons:"
  );

  console.log(reasons);

  console.log(
    "\nSHOPIFY PRICES WERE NOT CHANGED."
  );
}

await main();
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const API_VERSION = "2026-07";
const TOKEN_CACHE_MS = 30 * 60 * 1000;

let cachedToken = null;
let cachedTokenAt = 0;

function assertEnv() {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars.");
  }
}

export async function getAccessToken() {
  assertEnv();

  const now = Date.now();
  if (cachedToken && now - cachedTokenAt < TOKEN_CACHE_MS) {
    return cachedToken;
  }

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

  cachedToken = data.access_token;
  cachedTokenAt = now;
  return cachedToken;
}

export async function shopifyGraphQL(token, query, variables = {}) {
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
    throw new Error(`Bulk operation failed: ${JSON.stringify(result.userErrors)}`);
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
      if (!operation.url) throw new Error("Bulk operation returned no result URL.");
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

export async function fetchAllVariants(token) {
  const bulkId = await startBulkOperation(token);
  const resultUrl = await waitForBulkOperation(token);
  const variants = await downloadVariants(resultUrl);
  return { variants, bulkId };
}

export async function updateVariantPrice(token, productId, variantId, price) {
  const mutation = `
    mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
        product { id }
        productVariants { id price }
        userErrors { field message code }
      }
    }
  `;

  const data = await shopifyGraphQL(token, mutation, {
    productId,
    variants: [{ id: variantId, price: price.toFixed(2) }],
  });

  const result = data.productVariantsBulkUpdate;

  if (result.userErrors?.length) {
    throw new Error(`Shopify rejected update: ${JSON.stringify(result.userErrors)}`);
  }
  if (!result.productVariants?.length) {
    throw new Error("Shopify did not confirm the price update.");
  }

  const updatedVariant = result.productVariants[0];
  if (updatedVariant.id !== variantId || Number(updatedVariant.price) !== Number(price.toFixed(2))) {
    throw new Error(`Shopify price verification failed for variant ${variantId}.`);
  }

  return updatedVariant;
}
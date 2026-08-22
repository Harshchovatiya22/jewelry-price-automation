const VALID_METALS = ["24K", "18K", "14K", "10K", "SILVER"];
const MAKING_CHARGE_TYPES = ["flat_per_gram", "percent_of_metal"];
const MAX_PRICE_USD = 1000000;
const PURITY_TOLERANCE = 0.01;

export function validateGoldRates(rates) {
  const required = ["price_24k", "price_18k", "price_14k", "price_10k"];
  for (const key of required) {
    const value = Number(rates[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid gold rate: ${key}.`);
    }
  }

  const price24k = Number(rates.price_24k);
  const checks = [
    ["price_18k", (price24k * 18) / 24],
    ["price_14k", (price24k * 14) / 24],
    ["price_10k", (price24k * 10) / 24],
  ];

  for (const [key, expected] of checks) {
    if (Math.abs(Number(rates[key]) - expected) > PURITY_TOLERANCE) {
      throw new Error(`Purity validation failed for ${key}.`);
    }
  }
}

export function detectMetal(value) {
  if (!value) return null;
  const metal = String(value).trim().toUpperCase();
  if (metal.includes("SILVER")) return "SILVER";
  if (/\b18K\b/.test(metal)) return "18K";
  if (/\b14K\b/.test(metal)) return "14K";
  if (/\b10K\b/.test(metal)) return "10K";
  return null;
}

export function getMetafield(variant, key) {
  const field = variant.metafields?.nodes?.find(
    (item) => item.namespace === "custom" && item.key.toLowerCase() === key.toLowerCase()
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

function metalRateFromGoldRates(metal, goldRates, silverPricePerGram) {
  if (metal === "SILVER") return Number(silverPricePerGram);
  const map = {
    "24K": Number(goldRates.price_24k),
    "18K": Number(goldRates.price_18k),
    "14K": Number(goldRates.price_14k),
    "10K": Number(goldRates.price_10k),
  };
  return map[metal];
}

function calculateMakingCost(goldWeight, metalCost, settings) {
  const type = settings.making_charge_type;
  const value = Number(settings.making_charge_value);

  if (!MAKING_CHARGE_TYPES.includes(type)) {
    throw new Error(`Invalid making_charge_type: ${type}.`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid making_charge_value.");
  }

  if (type === "percent_of_metal") {
    return metalCost * (value / 100);
  }
  return goldWeight * value;
}

export function calculatePriceForVariant({ metal, goldWeight, diamondCost, otherCost, goldRates, settings }) {
  if (!VALID_METALS.includes(metal)) {
    throw new Error(`Unsupported metal: ${metal}.`);
  }

  const metalRate = metalRateFromGoldRates(metal, goldRates, settings.silver_price_per_gram);
  if (!Number.isFinite(metalRate) || metalRate <= 0) {
    throw new Error(`Invalid metal rate for ${metal}.`);
  }

  const metalCost = goldWeight * metalRate;
  const makingCost = calculateMakingCost(goldWeight, metalCost, settings);
  const baseCost = metalCost + diamondCost + makingCost + otherCost;

  const profitMultiplier = Number(settings.profit_multiplier);
  const usdRate = Number(settings.usd_conversion_rate);
  const finalAdjustmentPercent = Number(settings.final_adjustment_percent);

  if (!Number.isFinite(profitMultiplier) || profitMultiplier <= 0) throw new Error("Invalid profit_multiplier.");
  if (!Number.isFinite(usdRate) || usdRate <= 0) throw new Error("Invalid usd_conversion_rate.");
  if (!Number.isFinite(finalAdjustmentPercent)) throw new Error("Invalid final_adjustment_percent.");

  const sellingPriceINR = baseCost * profitMultiplier;
  const sellingPriceUSD = (sellingPriceINR / usdRate) * (1 + finalAdjustmentPercent / 100);

  if (!Number.isFinite(sellingPriceUSD) || sellingPriceUSD <= 0 || sellingPriceUSD > MAX_PRICE_USD) {
    throw new Error("Calculated price failed safety validation.");
  }

  return {
    metalRate,
    metalCost,
    makingCost,
    baseCost,
    sellingPriceINR,
    sellingPriceUSD: Number(sellingPriceUSD.toFixed(2)),
  };
}

export function checkPriceChangeSafety(currentPrice, newPrice, maxChangePercent) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { safe: false, reason: "Current Shopify price is invalid." };
  }
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return { safe: false, reason: "Calculated price is invalid." };
  }

  const changePercent = ((newPrice - currentPrice) / currentPrice) * 100;

  if (changePercent > 0) {
    return { safe: true, changePercent };
  }

  const limit = Number(maxChangePercent);
  if (changePercent < -limit) {
    return {
      safe: false,
      reason: `Price decrease ${changePercent.toFixed(2)}% exceeds maximum allowed decrease of ${limit}%.`,
    };
  }

  return { safe: true, changePercent };
}

/**
 * Given one raw Shopify variant (with metafields), current gold rates, and
 * current settings, decides the outcome for that variant. Never talks to
 * Shopify directly — pure calculation, fully driven by settings from the DB.
 */
export function evaluateVariant(variant, goldRates, settings) {
  const base = {
    productId: variant.product?.id ?? null,
    variantId: variant.id,
    productTitle: variant.product?.title ?? "Unknown product",
    variantTitle: variant.title,
    sku: variant.sku || "—",
    oldPrice: Number(variant.price),
  };

  try {
    const metal = detectMetal(getMetafield(variant, "metal"));
    if (!metal) throw new Error("Missing or unsupported metal.");

    const goldWeight = numberFromMetafield(getMetafield(variant, "gold_weight"), "Gold Weight");
    const diamondCost = numberFromMetafield(getMetafield(variant, "diamond_cost"), "Diamond Cost");
    const otherCost = numberFromMetafield(getMetafield(variant, "other_cost"), "Other Cost");

    const calc = calculatePriceForVariant({ metal, goldWeight, diamondCost, otherCost, goldRates, settings });
    const safety = checkPriceChangeSafety(base.oldPrice, calc.sellingPriceUSD, settings.max_price_change_percent);

    if (!safety.safe) {
      return { ...base, metal, status: "blocked", reason: safety.reason };
    }

    return {
      ...base,
      metal,
      newPrice: calc.sellingPriceUSD,
      changePercent: Number(safety.changePercent.toFixed(2)),
      status: "ready",
    };
  } catch (error) {
    return { ...base, status: "skipped", reason: error.message };
  }
}
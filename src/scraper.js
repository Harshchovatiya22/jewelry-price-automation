import { chromium } from "playwright";
import fs from "node:fs/promises";

const GOODRETURNS_URL = "https://www.goodreturns.in/gold-rates/surat.html";
const SILVER_PRICE_PER_GRAM = 300;
const MIN_24K_PRICE = 5000;
const MAX_24K_PRICE = 50000;

async function get24KGoldPrice() {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(GOODRETURNS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    const text = await page.locator("body").innerText();

    const match24K =
      text.match(/₹\s*([\d,]+(?:\.\d+)?)\s*per gram for 24 karat gold/i) ||
      text.match(/24K\s*Gold\s*\/\s*g[\s\S]{0,100}?₹\s*([\d,]+(?:\.\d+)?)/i);

    if (!match24K) {
      throw new Error("24K gold price not found. ALL PRICE UPDATES BLOCKED.");
    }

    const price24K = Number(match24K[1].replace(/,/g, ""));

    if (!Number.isFinite(price24K)) {
      throw new Error("Invalid 24K gold price. ALL PRICE UPDATES BLOCKED.");
    }

    if (price24K < MIN_24K_PRICE || price24K > MAX_24K_PRICE) {
      throw new Error(`24K price ₹${price24K} outside safety range. ALL PRICE UPDATES BLOCKED.`);
    }

    return price24K;
  } finally {
    await browser.close();
  }
}

function calculatePurityRates(price24K) {
  return {
    "24K": price24K,
    "18K": price24K * 18 / 24,
    "14K": price24K * 14 / 24,
    "10K": price24K * 10 / 24,
    "SILVER": SILVER_PRICE_PER_GRAM,
  };
}

async function main() {
  console.log("==========================================");
  console.log("JEWELRY PRICE AUTOMATION");
  console.log("==========================================");

  console.log("\n[1] Fetching 24K gold price...");
  const price24K = await get24KGoldPrice();
  console.log(`24K = ₹${price24K.toFixed(2)}/gram`);

  const metalRates = calculatePurityRates(price24K);
  metalRates.updatedAt = new Date().toISOString();

  await fs.writeFile("gold-prices.json", JSON.stringify(metalRates, null, 2), "utf8");
  console.log("Validated metal rates saved to gold-prices.json");

  console.log("\nMETAL RATES:");
  console.log(`24K = ₹${metalRates["24K"].toFixed(2)}/g`);
  console.log(`18K = ₹${metalRates["18K"].toFixed(2)}/g`);
  console.log(`14K = ₹${metalRates["14K"].toFixed(2)}/g`);
  console.log(`10K = ₹${metalRates["10K"].toFixed(2)}/g`);
  console.log(`Silver = ₹${metalRates["SILVER"].toFixed(2)}/g`);

  console.log("\nSCRAPER COMPLETE — NO SHOPIFY UPDATE ATTEMPTED.");
}

main().catch((error) => {
  console.error("\n==========================================");
  console.error("🚨 PRICE AUTOMATION STOPPED");
  console.error("==========================================");
  console.error(error.message);
  console.error("\nNO SHOPIFY PRICE UPDATES WERE ATTEMPTED.");
  process.exit(1);
});
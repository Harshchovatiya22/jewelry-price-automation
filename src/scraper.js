import { chromium } from "playwright";

const MIN_24K_PRICE = 5000;
const MAX_24K_PRICE = 50000;

export async function fetchGoldRate(sourceUrl) {
  if (!sourceUrl) {
    throw new Error("No gold source URL configured.");
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const text = await page.locator("body").innerText();

    const match24K =
      text.match(/₹\s*([\d,]+(?:\.\d+)?)\s*per gram for 24 karat gold/i) ||
      text.match(/24K\s*Gold\s*\/\s*g[\s\S]{0,100}?₹\s*([\d,]+(?:\.\d+)?)/i);

    if (!match24K) {
      throw new Error("24K gold price not found on the source page.");
    }

    const price24k = Number(match24K[1].replace(/,/g, ""));

    if (!Number.isFinite(price24k)) {
      throw new Error("Invalid 24K gold price extracted.");
    }

    if (price24k < MIN_24K_PRICE || price24k > MAX_24K_PRICE) {
      throw new Error(`24K price ₹${price24k} is outside the safety range (₹${MIN_24K_PRICE}–₹${MAX_24K_PRICE}).`);
    }

    return {
      price24k,
      price18k: Number(((price24k * 18) / 24).toFixed(2)),
      price14k: Number(((price24k * 14) / 24).toFixed(2)),
      price10k: Number(((price24k * 10) / 24).toFixed(2)),
      source: sourceUrl,
    };
  } finally {
    await browser.close();
  }
}
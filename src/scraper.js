import { chromium } from "playwright";

const URL = "https://www.goodreturns.in/gold-rates/surat.html";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(URL, {
  waitUntil: "domcontentloaded",
  timeout: 30000
});

const text = await page.locator("body").innerText();

const match24K = text.match(/24K\s*Gold\s*\/g[\s\S]{0,100}?₹\s*([\d,]+)/i);

if (!match24K) {
  throw new Error("24K gold price not found");
}

const price24K = Number(match24K[1].replace(/,/g, ""));

const prices = {
  "24K": price24K,
  "18K": price24K * 18 / 24,
  "14K": price24K * 14 / 24,
  "10K": price24K * 10 / 24
};

console.log("GOLD PRICES PER GRAM:");
console.log(prices);

await browser.close();

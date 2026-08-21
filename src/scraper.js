import { chromium } from "playwright";

const URL = "https://www.goodreturns.in/gold-rates/surat.html";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

console.log("Page loaded:", await page.title());

await browser.close();

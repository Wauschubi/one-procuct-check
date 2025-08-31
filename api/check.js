import * as cheerio from "cheerio";
import { fetch } from "undici";

// ✏️ Deine Digitec-Produkt-URL
const PRODUCT_URL = "https://www.digitec.ch/de/s1/product/gigabyte-geforce-rtx-5090-gaming-oc-32-gb-grafikkarte-53969798";

const norm = s => s?.replace(/\s+/g, " ").trim() || "";

function extractNextData($) {
  const raw = $('script#__NEXT_DATA__').first().contents().text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function inferFromNextData(data) {
  const out = { availability: null, stock: null, name: null, price: null };
  const s = JSON.stringify(data);

  const priceNum = s.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/i);
  const priceStr = s.match(/"price"\s*:\s*"([^"]+)"/i);
  out.price = priceStr?.[1] ?? priceNum?.[1] ?? null;

  const nameStr = s.match(/"name"\s*:\s*"([^"]{3,200})"/i);
  if (nameStr) out.name = nameStr[1];

  const inStockBool = /"inStock"\s*:\s*true/i.test(s) || /"available"\s*:\s*true/i.test(s);
  const stockNum = s.match(/"stock"\s*:\s*(\d+)/i);
  const availStr = s.match(/"availability"\s*:\s*"([^"]+)"/i);

  if (stockNum) out.stock = parseInt(stockNum[1], 10);
  if (inStockBool || /instock/i.test(availStr?.[1] || "")) out.availability = "in_stock";
  else if (/outofstock|out_of_stock/i.test(availStr?.[1] || "")) out.availability = "out_of_stock";

  const stockText = s.match(/(\d+)\s*St\u00fcck an Lager|(\d+)\s*Stück an Lager/i);
  if (!out.stock && stockText) {
    out.stock = parseInt(stockText[1] || stockText[2], 10);
    out.availability = out.stock > 0 ? "in_stock" : "out_of_stock";
  }
  return out;
}
function parseFromLdJson($) {
  const blocks = $('script[type="application/ld+json"]');
  let name = null, price = null, availability = null;
  blocks.each((_, el) => {
    try {
      const txt = $(el).contents().text();
      if (!txt?.trim()) return;
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (!name && typeof obj.name === "string") name = obj.name;
        const offers = obj.offers || obj.aggregateOffer || obj.aggregateOffers;
        const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const o of list) {
          if (!price && (o.price || o.lowPrice)) price = String(o.price ?? o.lowPrice);
          if (!availability && o.availability) {
            const a = String(o.availability).toLowerCase();
            availability = a.includes("instock") ? "in_stock" : a.includes("outofstock") ? "out_of_stock" : null;
          }
        }
      }
    } catch {}
  });
  return { name, price, availability };
}
function parseDigitecAvailability($) {
  const body = norm($("body").text());
  const out = { availability: null, stock: null };

  const mStock = body.match(/(\d+)\s*St(ü|u)ck an Lager/i);
  if (mStock) {
    out.stock = parseInt(mStock[1], 10);
    out.availability = out.stock > 0 ? "in_stock" : "out_of_stock";
  }
  if (!out.availability && $('[aria-label="verfügbar"]').length > 0) out.availability = "in_stock";
  return out;
}
function getProductName($) {
  const og = $('meta[property="og:title"]').attr('content');
  if (og?.trim()) return og.trim();
  const title = $('title').text();
  if (title?.trim()) return title.replace(/\s*\|\s*digitec.*$/i, '').trim();
  const h1 = $('h1').first().text();
  if (h1?.trim()) return h1.trim();
  return null;
}

// ----------------- API -----------------
export default async function handler(req, res) {
  try {
    const r = await fetch(PRODUCT_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (one-product-check)",
        "Accept-Language": "de-CH,de;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const html = await r.text();
    const $ = cheerio.load(html);

    // Debug-Flags
    const hasOgTitle = !!$('meta[property="og:title"]').attr('content');
    const hasTitle   = !!$('title').text().trim();
    const hasH1      = !!$('h1').first().text().trim();

    // 0) Startwerte
    let finalName = getProductName($);
    let finalPrice = null;
    let finalAvailability = null;
    let finalStock = null;

    // 1) Next.js-Daten
    const nextData = extractNextData($);
    if (nextData) {
      const fromNext = inferFromNextData(nextData);
      finalName = finalName ?? fromNext.name;
      finalPrice = finalPrice ?? fromNext.price;
      finalAvailability = finalAvailability ?? fromNext.availability;
      finalStock = finalStock ?? fromNext.stock;
    }

    // 2) JSON-LD / Meta
    const fromLd = parseFromLdJson($);
    finalName = finalName ?? fromLd.name;
    finalPrice = finalPrice ?? fromLd.price;
    finalAvailability = finalAvailability ?? fromLd.availability;

    // 3) Digitec-Text
    if (!finalAvailability || finalAvailability === "unknown") {
      const dig = parseDigitecAvailability($);
      finalAvailability = finalAvailability ?? dig.availability ?? "unknown";
      finalStock = finalStock ?? dig.stock ?? null;
    }

    // 4) Fallback grob
    if (!finalAvailability) {
      const t = norm($("body").text()).toLowerCase();
      if (/(nicht an lager|derzeit nicht verfügbar|ausverkauft|out of stock)/.test(t)) finalAvailability = "out_of_stock";
      if (/(an lager|sofort lieferbar|lieferung morgen|in stock|ab lager)/.test(t)) finalAvailability = "in_stock";
    }

    res.status(200).json({
      ok: true,
      name: finalName || null,
      price: finalPrice || null,
      availability: finalAvailability || "unknown",
      stock: finalStock ?? null,
      debug: { hasOgTitle, hasTitle, hasH1 },
      checked_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

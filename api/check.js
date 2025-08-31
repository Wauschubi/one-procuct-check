import * as cheerio from "cheerio";
import { fetch } from "undici";

// ✏️ Deine Digitec-Produkt-URL:
const PRODUCT_URL = "https://www.digitec.ch/de/s1/product/gigabyte-geforce-rtx-5090-gaming-oc-32-gb-grafikkarte-53969798";

// ----------------- Helfer -----------------
const norm = s => s?.replace(/\s+/g, " ").trim() || "";

function extractNextData($) {
  const raw = $('script#__NEXT_DATA__').first().contents().text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function inferFromNextData(data) {
  // Generischer Heuristik-Parser: durchsucht die JSON-Struktur nach inStock/availability/stock/price
  const out = { availability: null, stock: null, name: null, price: null };

  // 1) Name/Preis (häufig)
  const s = JSON.stringify(data);
  // Preis als Zahl oder String
  const priceNum = s.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/i);
  const priceStr = s.match(/"price"\s*:\s*"([^"]+)"/i);
  out.price = priceStr?.[1] ?? priceNum?.[1] ?? null;

  const nameStr = s.match(/"name"\s*:\s*"([^"]{3,200})"/i);
  if (nameStr) out.name = nameStr[1];

  // 2) Availability / Stock
  // booleans/strings wie "inStock":true, "availability":"InStock", "stock":5
  const inStockBool = /"inStock"\s*:\s*true/i.test(s) || /"available"\s*:\s*true/i.test(s);
  const stockNum = s.match(/"stock"\s*:\s*(\d+)/i);
  const availStr = s.match(/"availability"\s*:\s*"([^"]+)"/i);

  if (stockNum) out.stock = parseInt(stockNum[1], 10);
  if (inStockBool || /instock/i.test(availStr?.[1] || "")) out.availability = "in_stock";
  else if (/outofstock|out_of_stock/i.test(availStr?.[1] || "")) out.availability = "out_of_stock";

  // 3) Falls im JSON Texte wie "Stück an Lager" stehen
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
  const out = { availability: null, stock: null, shipping: null, pickup: [] };

  const mStock = body.match(/(\d+)\s*St(ü|u)ck an Lager/i);
  if (mStock) {
    out.stock = parseInt(mStock[1], 10);
    out.availability = out.stock > 0 ? "in_stock" : "out_of_stock";
  }

  const mShip = body.match(/\b(Heute|Morgen|Übermorgen|In \d+ Tagen)\b mit (Blitzlieferung|Standardversand)/i);
  if (mShip) out.shipping = `${mShip[1]} mit ${mShip[2]}`;

  const pickupRegex = /([A-Za-zÄÖÜäöüß .\-]+):\s*(Heute|Morgen|Übermorgen)\s*abholbereit/gi;
  let p;
  while ((p = pickupRegex.exec(body)) !== null) {
    out.pickup.push(`${p[1].trim()} (${p[2]})`);
  }
  if (!out.availability && out.pickup.length > 0) out.availability = "in_stock";

  const ariaAvail = $('[aria-label="verfügbar"]').length > 0;
  if (!out.availability && ariaAvail) out.availability = "in_stock";

  return out;
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

    // 1) Next.js __NEXT_DATA__ (falls vorhanden)
    let { availability, stock, name, price } = (extractNextData($) ? inferFromNextData(extractNextData($)) : {});

    // 2) JSON-LD / Meta
    if (!name || !price || !availability) {
      const meta = parseFromLdJson($);
      name = name ?? meta.name;
      price = price ?? meta.price;
      availability = availability ?? meta.availability;
    }

    // 3) Digitec-spezifische Textsignale
    if (!availability || availability === "unknown") {
      const dig = parseDigitecAvailability($);
      availability = availability ?? dig.availability ?? "unknown";
      stock = stock ?? dig.stock ?? null;
    }

    // 4) Fallback grob
    if (!availability) {
      const t = norm($("body").text()).toLowerCase();
      if (/(nicht an lager|derzeit nicht verfügbar|ausverkauft|out of stock)/.test(t)) availability = "out_of_stock";
      if (/(an lager|sofort lieferbar|lieferung morgen|in stock|ab lager)/.test(t)) availability = "in_stock";
    }

    res.status(200).json({
      ok: true,
      name: name || null,
      price: price || null,
      availability: availability || "unknown",
      stock: stock ?? null,
      checked_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

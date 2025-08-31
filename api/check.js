import * as cheerio from "cheerio";
import { fetch } from "undici";

// ✏️ Deine Digitec-Produkt-URL
const PRODUCT_URL = "https://www.digitec.ch/de/s1/product/gigabyte-geforce-rtx-5090-gaming-oc-32-gb-grafikkarte-53969798";

// ————— Helpers —————
const norm = s => s?.replace(/\s+/g, " ").trim() || "";

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

// 🔎 Spezifisch für Digitec: „Stück an Lager“, „Morgen abholbereit“, „Blitzlieferung/Standardversand“
function parseDigitecAvailability($) {
  const body = norm($("body").text());
  const out = { availability: null, stock: null, shipping: null, pickup: [] };

  // „5 Stück an Lager“
  const mStock = body.match(/(\d+)\s*Stück an Lager/i);
  if (mStock) {
    out.stock = parseInt(mStock[1], 10);
    out.availability = out.stock > 0 ? "in_stock" : "out_of_stock";
  }

  // Versandzeilen
  // z.B. "Morgen mit Blitzlieferung" | "Übermorgen mit Standardversand"
  const mShip = body.match(/\b(Heute|Morgen|Übermorgen|In \d+ Tagen)\b mit (Blitzlieferung|Standardversand)/i);
  if (mShip) out.shipping = `${mShip[1]} mit ${mShip[2]}`;

  // Abholen „Stadt: Morgen abholbereit“
  const pickupRegex = /([A-Za-zÄÖÜäöüß .\-]+):\s*(Heute|Morgen|Übermorgen)\s*abholbereit/gi;
  let p;
  while ((p = pickupRegex.exec(body)) !== null) {
    out.pickup.push(`${p[1].trim()} (${p[2]})`);
  }
  if (!out.availability && out.pickup.length > 0) out.availability = "in_stock";

  // grünes Icon mit aria-label="verfügbar"
  const ariaAvailable = $('[aria-label="verfügbar"]').length > 0;
  if (!out.availability && ariaAvailable) out.availability = "in_stock";

  return out;
}

function parseFromMeta($) {
  const name = $('meta[property="og:title"]').attr("content") || norm($("h1").first().text()) || null;
  const price = $('meta[itemprop="price"]').attr("content")
             || $('meta[property="product:price:amount"]').attr("content")
             || null;
  let availability = $('link[itemprop="availability"]').attr("href") || null;
  if (availability) {
    const a = availability.toLowerCase();
    availability = a.includes("instock") ? "in_stock" : a.includes("outofstock") ? "out_of_stock" : null;
  }
  return { name, price, availability };
}

// ————— API —————
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

    // 1) Basisdaten
    let { name, price, availability } = parseFromLdJson($);
    if (!name || !price || !availability) {
      const m = parseFromMeta($);
      name = name ?? m.name;
      price = price ?? m.price;
      availability = availability ?? m.availability;
    }

    // 2) Digitec-spezifische Box
    const dig = parseDigitecAvailability($);
    if (!availability && dig.availability) availability = dig.availability;

    // 3) Fallback grobe Textsuche
    if (!availability) {
      const t = norm($("body").text()).toLowerCase();
      if (/(nicht an lager|derzeit nicht verfügbar|ausverkauft|out of stock)/.test(t)) availability = "out_of_stock";
      if (/(an lager|sofort lieferbar|lieferung morgen|in stock|ab lager)/.test(t)) availability = availability || "in_stock";
    }

    res.status(200).json({
      ok: true,
      name: name || null,
      price: price || null,
      availability: availability || "unknown",
      stock: dig.stock ?? null,
      shipping: dig.shipping ?? null,
      pickup_locations: dig.pickup,
      checked_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

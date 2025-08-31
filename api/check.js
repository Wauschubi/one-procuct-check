import * as cheerio from "cheerio";
import { fetch } from "undici";

// ✏️ Deine Digitec-Produkt-URL:
const PRODUCT_URL = "https://www.digitec.ch/de/s1/product/gigabyte-geforce-rtx-5090-gaming-oc-32-gb-grafikkarte-53969798";

// --- Parser-Helfer ---
function parseFromLdJson($) {
  const blocks = $('script[type="application/ld+json"]');
  let name = null, price = null, availability = null;

  blocks.each((_, el) => {
    try {
      const txt = $(el).contents().text();
      if (!txt) return;
      const json = JSON.parse(txt);

      const arr = Array.isArray(json) ? json : [json];
      for (const obj of arr) {
        // Produktname
        if (!name && typeof obj.name === "string") name = obj.name;

        // Offer(s)
        const offers = obj.offers || obj.aggregateOffer || obj.aggregateOffers;
        const offerArr = Array.isArray(offers) ? offers : (offers ? [offers] : []);
        for (const offer of offerArr) {
          if (!availability && offer.availability) availability = String(offer.availability);
          if (!price && (offer.price || offer.lowPrice)) price = String(offer.price ?? offer.lowPrice);
        }
      }
    } catch { /* JSON-Block ignorieren */ }
  });

  // Normalisieren
  if (availability) {
    const L = availability.toLowerCase();
    if (L.includes("instock")) availability = "in_stock";
    else if (L.includes("outofstock")) availability = "out_of_stock";
    else availability = "unknown";
  }
  return { name, price, availability };
}

function parseFromMeta($) {
  const name = $('meta[property="og:title"]').attr("content") || $("h1").first().text().trim() || null;
  const price =
    $('meta[itemprop="price"]').attr("content") ||
    $('meta[property="product:price:amount"]').attr("content") ||
    null;
  // Microdata availability
  let availability = $('link[itemprop="availability"]').attr("href") || null;
  if (availability) {
    const L = availability.toLowerCase();
    if (L.includes("instock")) availability = "in_stock";
    else if (L.includes("outofstock")) availability = "out_of_stock";
    else availability = "unknown";
  }
  return { name, price, availability };
}

function parseFromText($) {
  const t = $("body").text().toLowerCase().replace(/\s+/g, " ");
  if (t.includes("nicht an lager") || t.includes("derzeit nicht verfügbar") || t.includes("out of stock"))
    return "out_of_stock";
  if (t.includes("an lager") || t.includes("sofort lieferbar") || t.includes("in stock"))
    return "in_stock";
  return "unknown";
}

// --- API Handler ---
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

    // 1) LD-JSON
    let { name, price, availability } = parseFromLdJson($);

    // 2) Meta/Microdata, wenn noch fehlt
    if (!name || !price || !availability) {
      const m = parseFromMeta($);
      name = name ?? m.name;
      price = price ?? m.price;
      availability = availability ?? m.availability;
    }

    // 3) Fallback: Textsuche
    if (!availability) availability = parseFromText($);

    res.status(200).json({
      ok: true,
      name: name || null,
      price: price || null,
      availability,
      checked_at: new Date().toISOString(),
      source: availability ? "ok" : "fallback"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

import * as cheerio from "cheerio";
import { fetch } from "undici";


// ✏️ Deine Digitec-Produkt-URL:
const PRODUCT_URL = "https://www.digitec.ch/de/s1/product/gigabyte-geforce-rtx-5090-gaming-oc-32-gb-grafikkarte-53969798";


function parseAvailability($){
    const t = $('body').text().toLowerCase();
    if (t.includes('an lager') || t.includes('sofort lieferbar') || t.includes('in stock')) return 'in_stock';
    if (t.includes('nicht an lager') || t.includes('derzeit nicht verfügbar') || t.includes('out of stock')) return 'out_of_stock';
    return 'unknown';
}


export default async function handler(req, res){
    try {
        const r = await fetch(PRODUCT_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (one-product-check)',
                'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8'
            }
        });
        const html = await r.text();
        const $ = cheerio.load(html);
        const availability = parseAvailability($);
        res.status(200).json({ availability, checked_at: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: 'Abruf fehlgeschlagen', detail: e.message });
    }
}
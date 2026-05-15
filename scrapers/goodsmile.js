const axios = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Extract preorder deadline from text like:
 *   "Preorder Period: 2026/05/14〜2026/06/24 (JST)"
 *   "予約期間：2026/05/14〜2026/06/24"
 * Returns the END date (deadline) in YYYY-MM-DD format.
 */
function parseDeadline(text) {
  if (!text) return null;
  // Match the end date after 〜 or ~
  const m = text.match(/[〜~]\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // Fallback: any date
  const d = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (d) return `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
  return null;
}

/**
 * Detect category from product name
 */
function detectCategory(name) {
  const n = name.toLowerCase();
  if (n.startsWith('nendoroid')) return 'Nendoroid';
  if (n.startsWith('figma ')) return 'figma';
  if (n.includes('pop up parade')) return 'POP UP PARADE';
  if (n.includes('scale figure') || /1\/[4-8]\s/.test(name)) return 'Scale Figure';
  if (n.includes('moderoid')) return 'MODEROID';
  if (n.includes('plamax') || n.includes('plamatea')) return 'Plastic Model';
  if (n.includes('plush') || n.includes('plushy')) return 'Plush';
  return 'Figure';
}

/**
 * Scrape GoodSmile products from the NEW site (goodsmile.com).
 *
 * Strategy:
 *  1. Fetch homepage → parse "Preorders Open Now" product links
 *  2. Fetch each product detail page → get deadline, price, images
 */
async function scrapeGoodSmile() {
  const products = [];
  const productIds = new Set();

  // ── Step 1: Get product links from homepage ────────────────────────────
  console.log('[gsc] Fetching homepage...');
  let $ = null;
  try {
    const res = await axios.get('https://www.goodsmile.com/en', {
      timeout: 25000,
      headers: HEADERS,
    });
    $ = cheerio.load(res.data);
  } catch (err) {
    console.error('[gsc] Homepage fetch error:', err.message);
    return products;
  }

  // Find all product links (format: /en/product/{id}/...)
  const links = [];
  $('a[href*="/en/product/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/en\/product\/(\d+)/);
    if (m && !productIds.has(m[1])) {
      productIds.add(m[1]);
      links.push({
        id: m[1],
        url: href.startsWith('http') ? href : `https://www.goodsmile.com${href}`,
      });
    }
  });

  console.log(`[gsc] Found ${links.length} unique product links`);

  // Extract basic info directly from homepage
  $('a[href*="/en/product/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const m = href.match(/\/en\/product\/(\d+)/);
    if (!m) return;

    const text = $el.text().trim();
    const imgEl = $el.find('img').first();
    const imageUrl = imgEl.attr('src') || '';
    const altText = imgEl.attr('alt') || '';

    // Extract name — either from alt text or from link text
    let name = altText || '';
    if (!name) {
      const nameMatch = text.match(/^(.+?)(?:\s*￥|$)/);
      name = nameMatch ? nameMatch[1].trim() : text.split('\n')[0].trim();
    }

    // Extract price from text
    const priceMatch = text.match(/￥[\d,]+/);
    const price = priceMatch ? priceMatch[0] : '';

    if (!name || name.length < 3) return;

    const id = m[1];
    if (!products.find(p => p.key === `gsc-${id}`)) {
      products.push({
        key: `gsc-${id}`,
        name,
        series: '',
        category: detectCategory(name),
        price,
        deadline: null,
        source: 'GoodSmile',
        imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.com${imageUrl}` : '',
        productUrl: `https://www.goodsmile.com/en/product/${id}`,
      });
    }
  });

  console.log(`[gsc] Parsed ${products.length} products from homepage`);

  // ── Step 2: Fetch detail pages for deadlines (batch of up to 15) ──────
  const toFetch = products.filter(p => !p.deadline).slice(0, 15);
  console.log(`[gsc] Fetching ${toFetch.length} detail pages for deadlines...`);

  for (const product of toFetch) {
    try {
      const res = await axios.get(product.productUrl, {
        timeout: 15000,
        headers: HEADERS,
      });
      const $d = cheerio.load(res.data);
      const bodyText = $d('body').text();

      // Find preorder deadline: "Preorder Period: 2026/05/14〜2026/06/24 (JST)"
      const periodMatch = bodyText.match(/Preorder\s*Period[:\s]*(\d{4}\/\d{1,2}\/\d{1,2})\s*[〜~]\s*(\d{4}\/\d{1,2}\/\d{1,2})/i)
        || bodyText.match(/予約期間[：:\s]*(\d{4}\/\d{1,2}\/\d{1,2})\s*[〜~]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);

      if (periodMatch) {
        product.deadline = parseDeadline(`〜${periodMatch[2]}`);
      }

      // Extract series if available
      const seriesEl = $d('a[href*="search_title"]').first();
      if (seriesEl.length) {
        product.series = seriesEl.text().trim();
      }

      // Better image from og:image meta tag
      const ogImage = $d('meta[property="og:image"]').attr('content');
      if (ogImage && ogImage.startsWith('http')) {
        product.imageUrl = ogImage;
      }

      // Better price from detail page
      if (!product.price) {
        const priceMatch = bodyText.match(/￥[\d,]+/);
        if (priceMatch) product.price = priceMatch[0];
      }

      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`[gsc] Detail page error for ${product.key}:`, err.message);
    }
  }

  const withDeadlines = products.filter(p => p.deadline).length;
  console.log(`[gsc] Done — ${products.length} products (${withDeadlines} with deadlines)`);

  return products;
}

module.exports = { scrapeGoodSmile };
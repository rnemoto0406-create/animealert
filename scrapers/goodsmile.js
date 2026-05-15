const axios = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
};

const JP_EN = {
  'フィギュア': 'Figure', 'プラモデル': 'Plastic Model', 'ぬいぐるみ': 'Plush',
  'アクセサリー': 'Accessories', 'キーホルダー': 'Keychain', 'タオル': 'Towel',
  'Tシャツ': 'T-Shirt', 'ポスター': 'Poster', 'バッグ': 'Bag',
  'スケール': 'Scale', 'ねんどろいど': 'Nendoroid', 'figma': 'figma',
  '予約受付中': 'Pre-order', '再販': 'Re-release',
};

function translateJP(text) {
  if (!text) return '';
  for (const [jp, en] of Object.entries(JP_EN)) {
    text = text.replaceAll(jp, en);
  }
  return text;
}

function parseDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const iso = str.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const jp = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`;
  const jpMonth = str.match(/(\d{4})年(\d{1,2})月/);
  if (jpMonth) return `${jpMonth[1]}-${jpMonth[2].padStart(2, '0')}-28`;
  return null;
}

/**
 * Scrape GoodSmile products using multiple strategies.
 * Strategy 1: English product pages (category listings)
 * Strategy 2: Japanese search page
 * Strategy 3: Preorder schedule page
 */
async function scrapeGoodSmile() {
  let products = [];

  // ── Strategy 1: English category listing pages ─────────────────────────
  // These pages list products by announcement year and may be server-rendered
  const categories = ['scale', 'nendoroid_series', 'figma'];
  const currentYear = new Date().getFullYear();

  for (const cat of categories) {
    if (products.length > 50) break; // enough products
    try {
      const url = `https://www.goodsmile.info/en/products/category/${cat}/announced/${currentYear}`;
      const res = await axios.get(url, { timeout: 20000, headers: HEADERS });
      const $ = cheerio.load(res.data);

      // Try multiple selector patterns for product items
      const selectors = [
        '.hitItem', '.hitArticle', '.productItem', '.product',
        'li.item', '[class*="hitItem"]', '[class*="product"]',
        'a[href*="/en/product/"]',
      ];

      for (const sel of selectors) {
        const items = $(sel);
        if (items.length === 0) continue;

        items.each((_, el) => {
          const $el = $(el);

          // Extract product link and ID
          const link = $el.is('a') ? $el.attr('href') : ($el.find('a[href*="/product/"]').first().attr('href') || '');
          const idMatch = link.match(/\/product\/(\d+)/);
          if (!idMatch) return;

          const key = `gsc-${idMatch[1]}`;
          if (products.find(p => p.key === key)) return;

          // Extract name
          const name = $el.find('.hitTtl a, .hitTtl, .product-name, .name, h3, h2').first().text().trim()
            || $el.find('a').first().text().trim()
            || $el.find('img').first().attr('alt')
            || '';
          if (!name || name.length < 3) return;

          // Extract date
          const dateRaw = $el.find('.hitDate, .releaseDate, [class*="Date"], time, .date').first().text().trim();
          const deadline = parseDate(dateRaw);

          // Extract price
          const price = $el.find('.hitPrice, .price, [class*="Price"]').first().text().trim();

          // Extract image
          const imgEl = $el.find('img[data-src], img[src]').first();
          const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';

          // Extract category
          const category = $el.find('.hitCat, .category, [class*="Cat"]').first().text().trim();

          const productUrl = link.startsWith('http') ? link : `https://www.goodsmile.info${link}`;

          products.push({
            key,
            name: translateJP(name),
            series: '',
            category: translateJP(category) || cat.replace(/_/g, ' '),
            price,
            deadline,
            source: 'GoodSmile',
            imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.info${imageUrl}` : '',
            productUrl,
          });
        });

        if (products.length > 0) break;
      }

      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`[gsc] Category ${cat} error:`, err.message);
    }
  }

  if (products.length > 0) {
    console.log(`[gsc] Category scrape: ${products.length} products`);
    return products;
  }

  // ── Strategy 2: Japanese search page ───────────────────────────────────
  try {
    const res = await axios.get('https://www.goodsmile.info/ja/products/search', {
      params: { preorder: '1' },
      timeout: 20000,
      headers: { ...HEADERS, 'Accept-Language': 'ja' },
    });

    const $ = cheerio.load(res.data);

    // Look for JSON data embedded in <script> tags
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const text = $(script).html() || '';

      // Try to find product data in various JS variable formats
      const patterns = [
        /products\s*[:=]\s*(\[[\s\S]*?\]);/,
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
        /data\s*[:=]\s*(\{[\s\S]*?"products"[\s\S]*?\});/,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        try {
          const data = JSON.parse(match[1]);
          const items = Array.isArray(data) ? data : (data.products || []);
          for (const item of items) {
            const id = item.id || item.product_id;
            if (!id) continue;
            products.push({
              key: `gsc-${id}`,
              name: translateJP(item.name || item.title || ''),
              category: translateJP(item.category || ''),
              price: item.price || '',
              deadline: parseDate(item.deadline || item.release_date || item.order_close_date),
              source: 'GoodSmile',
              imageUrl: item.image || item.thumb || '',
              productUrl: `https://www.goodsmile.info/en/product/${id}`,
            });
          }
        } catch { /* not valid JSON */ }
      }
    }

    // Also try standard HTML selectors
    if (products.length === 0) {
      const selectors = ['.hitItem', '.hitArticle', 'li.item', '.product', '[class*="hitItem"]'];
      for (const sel of selectors) {
        const items = $(sel);
        if (items.length === 0) continue;

        items.each((_, el) => {
          const $el = $(el);
          const name = $el.find('.hitTtl a, .hitTtl, .name, h3').first().text().trim();
          if (!name) return;

          const link = $el.find('a[href*="/product/"], a[href*="/p/"]').first().attr('href') || '';
          const idMatch = link.match(/\/(?:product|p)\/(\d+)/);
          const key = idMatch
            ? `gsc-${idMatch[1]}`
            : `gsc-${Buffer.from(name.slice(0, 30)).toString('base64url').slice(0, 16)}`;

          if (products.find(p => p.key === key)) return;

          const dateRaw = $el.find('.hitDate, .releaseDate, [class*="Date"], time').first().text().trim();
          const imgEl = $el.find('img[data-src], img').first();
          const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';

          products.push({
            key,
            name: translateJP(name),
            category: translateJP($el.find('.hitCat, .category').first().text().trim()),
            price: $el.find('.hitPrice, .price').first().text().trim(),
            deadline: parseDate(dateRaw),
            source: 'GoodSmile',
            imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.info${imageUrl}` : '',
            productUrl: link.startsWith('http') ? link : link ? `https://www.goodsmile.info${link}` : '',
          });
        });

        if (products.length > 0) break;
      }
    }

    if (products.length > 0) {
      console.log(`[gsc] Search scrape: ${products.length} products`);
      return products;
    }
  } catch (err) {
    console.error('[gsc] Search scrape error:', err.message);
  }

  // ── Strategy 3: Preorder schedule page ──────────────────────────────────
  try {
    const res = await axios.get('https://www.goodsmile.info/ja/preorder/schedule', {
      timeout: 20000,
      headers: { ...HEADERS, 'Accept-Language': 'ja' },
    });

    const $ = cheerio.load(res.data);

    let currentDeadline = null;
    $('body').find('*').each((_, el) => {
      const $el = $(el);
      const tag = el.tagName?.toLowerCase();

      if (['h2', 'h3', 'h4', 'dt', 'th'].includes(tag)) {
        const txt = $el.text();
        const m = txt.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (m) currentDeadline = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      }

      if (tag === 'a' && $el.attr('href')?.includes('/p/')) {
        const name = $el.text().trim() || $el.find('img').attr('alt') || '';
        if (!name || name.length < 3) return;
        const href = $el.attr('href');
        const idMatch = href.match(/\/p\/(\d+)/);
        if (!idMatch) return;
        const key = `gsc-${idMatch[1]}`;
        if (products.find(p => p.key === key)) return;

        const imgSrc = $el.find('img').attr('data-src') || $el.find('img').attr('src') || '';
        products.push({
          key,
          name: translateJP(name),
          category: '',
          price: '',
          deadline: currentDeadline,
          source: 'GoodSmile',
          imageUrl: imgSrc.startsWith('http') ? imgSrc : imgSrc ? `https://www.goodsmile.info${imgSrc}` : '',
          productUrl: href.startsWith('http') ? href : `https://www.goodsmile.info${href}`,
        });
      }
    });

    console.log(`[gsc] Schedule scrape: ${products.length} products`);
  } catch (err) {
    console.error('[gsc] Schedule scrape error:', err.message);
  }

  // ── Strategy 4: English product listing by recent IDs ──────────────────
  // If all else fails, try fetching a few recent product detail pages
  if (products.length === 0) {
    console.log('[gsc] All scrapers failed. Trying individual product pages...');
    // Try recent product ID range (GoodSmile IDs are sequential)
    // This is a fallback - we try a small range of recent IDs
    const startId = 16000; // approximate recent range
    const endId = startId + 20;

    for (let id = endId; id >= startId; id--) {
      try {
        const url = `https://www.goodsmile.info/en/product/${id}`;
        const res = await axios.get(url, {
          timeout: 15000,
          headers: HEADERS,
          maxRedirects: 3,
          validateStatus: s => s < 400,
        });

        const $ = cheerio.load(res.data);
        const name = $('h1, .product-name, .title').first().text().trim();
        if (!name || name.length < 3) continue;

        const imgEl = $('img.product-img, .product-image img, [class*="product"] img').first();
        const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';

        // Look for preorder/release info
        const bodyText = $('body').text();
        const dateMatch = bodyText.match(/(?:Pre-order|Preorder|予約|受注).{0,50}?(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/i);
        const deadline = dateMatch
          ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
          : null;

        const price = $('[class*="price"], .price').first().text().trim();
        const category = $('[class*="category"], .category').first().text().trim();

        products.push({
          key: `gsc-${id}`,
          name: translateJP(name),
          category: translateJP(category),
          price,
          deadline,
          source: 'GoodSmile',
          imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.info${imageUrl}` : '',
          productUrl: url,
        });

        await sleep(DELAY_MS);
      } catch {
        // Product ID doesn't exist or page error — skip
      }
    }
    console.log(`[gsc] Individual pages: ${products.length} products`);
  }

  return products;
}

module.exports = { scrapeGoodSmile };
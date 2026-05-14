const axios = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'AnimeAlert/1.0 (+https://animealert.vercel.app)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Try AmiAmi's internal API first, then HTML fallback */
async function scrapeAmiAmi(pages = 3) {
  const products = [];

  // ── Attempt 1: AmiAmi internal JSON API ────────────────────────────────
  try {
    for (let page = 1; page <= pages; page++) {
      const res = await axios.get('https://api.amiami.com/api/v1.0/items', {
        params: {
          pagemax: 40,
          page,
          s_sortkey: 'preorderclose',
          s_st_list_preorder_available: 1,
          lang: 'eng',
        },
        timeout: 20000,
        headers: { ...HEADERS, 'X-User-Key': 'amiami_dev' },
      });

      const items = res.data?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const code = item.gcode || item.scode || item.product_code || String(item.id || '');
        const deadline = item.order_closed_dt
          ? item.order_closed_dt.slice(0, 10)
          : null;

        products.push({
          key: `ami-${code}`,
          name: item.gname || item.title || '',
          category: item.c_title_1 || item.genre || '',
          price: item.price ? `¥${Number(item.price).toLocaleString()}` : '',
          deadline,
          source: 'AmiAmi',
          imageUrl: item.image ? `https://img.amiami.com${item.image}` : '',
          productUrl: code ? `https://www.amiami.com/eng/detail/?gcode=${code}` : '',
        });
      }

      if (page < pages) await sleep(DELAY_MS);
    }

    if (products.length > 0) {
      console.log(`[ami] API: ${products.length} products`);
      return products;
    }
  } catch (err) {
    console.error('[ami] API error:', err.message);
  }

  // ── Attempt 2: HTML scraping ────────────────────────────────────────────
  const ITEM_SELECTORS = [
    '.product-item-inner', '.product-item', 'li.item', '[class*="product-item"]',
  ];
  const NAME_SELECTORS  = ['.product-name-id a', '.product-name', '.name', 'h3', 'h2'];
  const DATE_SELECTORS  = ['.preorderclose em', '.preorderclose', '[class*="preorder"]', '[class*="deadline"]'];
  const PRICE_SELECTORS = ['.product-price', '.price'];

  for (let page = 1; page <= pages; page++) {
    try {
      const res = await axios.get('https://www.amiami.com/eng/search/list/', {
        params: { s_sortkey: 'preorderclose', pagecnt: page, pagemax: 40, s_st_list_preorder_available: 1 },
        timeout: 20000,
        headers: HEADERS,
      });

      const $ = cheerio.load(res.data);

      for (const itemSel of ITEM_SELECTORS) {
        const items = $(itemSel);
        if (items.length === 0) continue;

        items.each((_, el) => {
          const $el = $(el);

          let name = '';
          for (const s of NAME_SELECTORS) {
            name = $el.find(s).first().text().trim();
            if (name) break;
          }
          if (!name) return;

          let deadlineRaw = '';
          for (const s of DATE_SELECTORS) {
            deadlineRaw = $el.find(s).first().text().trim();
            if (deadlineRaw) break;
          }
          const dateMatch = deadlineRaw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
          const deadline = dateMatch
            ? `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`
            : null;

          let price = '';
          for (const s of PRICE_SELECTORS) { price = $el.find(s).first().text().trim(); if (price) break; }

          const imgEl = $el.find('img[data-src], img').first();
          const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
          const linkEl = $el.find('a').first();
          const productPath = linkEl.attr('href') || '';
          const codeMatch = productPath.match(/gcode=([^&]+)/i);
          const code = codeMatch ? codeMatch[1] : name.slice(0, 20).replace(/\W+/g, '-');

          products.push({
            key: `ami-${code}`,
            name,
            category: $el.find('[class*="genre"], [class*="category"]').first().text().trim(),
            price,
            deadline,
            source: 'AmiAmi',
            imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.amiami.com${imageUrl}` : '',
            productUrl: productPath.startsWith('http') ? productPath : `https://www.amiami.com${productPath}`,
          });
        });

        if (products.length > 0) break;
      }

      if (page < pages) await sleep(DELAY_MS);
    } catch (err) {
      console.error(`[ami] HTML page ${page} error:`, err.message);
    }
  }

  console.log(`[ami] HTML scrape: ${products.length} products`);
  return products;
}

module.exports = { scrapeAmiAmi };

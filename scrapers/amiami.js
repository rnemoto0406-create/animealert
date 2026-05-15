const axios = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
};

/**
 * Extract a YYYY-MM-DD date from various AmiAmi date formats.
 * Tries: ISO string, "YYYY/MM/DD", "Month YYYY", "YYYY年MM月" etc.
 */
function parseDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();

  // ISO or standard date: 2025-06-30, 2025/06/30
  const iso = str.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  // Japanese: 2025年6月
  const jp = str.match(/(\d{4})年(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}-28`;

  // English: "Jun 2025", "June 2025"
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                   jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const en = str.match(/([A-Za-z]+)\s+(\d{4})/);
  if (en) {
    const m = months[en[1].slice(0, 3).toLowerCase()];
    if (m) return `${en[2]}-${m}-28`;
  }

  return null;
}

/** Try AmiAmi's internal API, then HTML fallback */
async function scrapeAmiAmi(pages = 3) {
  const products = [];

  // ── Attempt 1: AmiAmi internal JSON API ────────────────────────────────
  try {
    for (let page = 1; page <= pages; page++) {
      const res = await axios.get('https://api.amiami.com/api/v1.0/items', {
        params: {
          pagemax: 30,
          page,
          s_sortkey: 'preorderclose',
          s_st_list_preorder_available: 1,
          lang: 'eng',
        },
        timeout: 20000,
        headers: { ...HEADERS, 'X-User-Key': 'amiami_dev' },
      });

      const items = res.data?.items || res.data?.RSuccess?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const code = item.gcode || item.scode || item.product_code || String(item.id || '');
        if (!code) continue;

        // Try multiple date fields — order_closed_dt, releasedate, release_date, jancd
        const deadline = parseDate(item.order_closed_dt)
          || parseDate(item.order_close_date)
          || parseDate(item.preorderclose)
          || parseDate(item.releasedate)
          || parseDate(item.release_date)
          || parseDate(item.release_dt)
          || null;

        const name = item.gname || item.sname || item.title || '';
        if (!name) continue;

        // Image URL construction
        let imageUrl = '';
        if (item.thumb_url) {
          imageUrl = item.thumb_url.startsWith('http') ? item.thumb_url : `https://img.amiami.com${item.thumb_url}`;
        } else if (item.image) {
          imageUrl = item.image.startsWith('http') ? item.image : `https://img.amiami.com${item.image}`;
        }

        products.push({
          key: `ami-${code}`,
          name,
          series: item.maker_name || item.seriestitle || '',
          category: item.c_title_1 || item.genre || item.c_title_2 || '',
          price: item.price ? `¥${Number(item.price).toLocaleString()}` : (item.c_price_taxed || ''),
          deadline,
          source: 'AmiAmi',
          imageUrl,
          productUrl: `https://www.amiami.com/eng/detail/?gcode=${code}`,
        });
      }

      if (page < pages) await sleep(DELAY_MS);
    }

    if (products.length > 0) {
      console.log(`[ami] API: ${products.length} products (${products.filter(p => p.deadline).length} with dates)`);
      return products;
    }
  } catch (err) {
    console.error('[ami] API error:', err.message);
  }

  // ── Attempt 2: HTML scraping ────────────────────────────────────────────
  for (let page = 1; page <= pages; page++) {
    try {
      const res = await axios.get('https://www.amiami.com/eng/search/list/', {
        params: { s_sortkey: 'preorderclose', pagecnt: page, pagemax: 30, s_st_list_preorder_available: 1 },
        timeout: 20000,
        headers: HEADERS,
      });

      const $ = cheerio.load(res.data);

      // AmiAmi embeds product data in a <script> tag as JSON
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const text = $(script).html() || '';
        // Look for JSON data embedded in the page
        const jsonMatch = text.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*(?:<\/script>|$)/s)
          || text.match(/items["']?\s*:\s*(\[.*?\])/s);
        if (jsonMatch) {
          try {
            const data = JSON.parse(jsonMatch[1]);
            const items = data.items || data;
            if (Array.isArray(items)) {
              for (const item of items) {
                const code = item.gcode || '';
                if (!code) continue;
                products.push({
                  key: `ami-${code}`,
                  name: item.gname || item.title || '',
                  category: item.c_title_1 || '',
                  price: item.price ? `¥${Number(item.price).toLocaleString()}` : '',
                  deadline: parseDate(item.order_closed_dt) || parseDate(item.releasedate) || null,
                  source: 'AmiAmi',
                  imageUrl: item.thumb_url || item.image || '',
                  productUrl: `https://www.amiami.com/eng/detail/?gcode=${code}`,
                });
              }
            }
          } catch { /* not valid JSON, skip */ }
        }
      }

      // Traditional HTML selectors as last resort
      if (products.length === 0) {
        const ITEM_SELECTORS = [
          '.product-item-inner', '.product-item', 'li.item', '[class*="product-item"]',
        ];

        for (const itemSel of ITEM_SELECTORS) {
          const items = $(itemSel);
          if (items.length === 0) continue;

          items.each((_, el) => {
            const $el = $(el);
            const name = $el.find('.product-name-id a, .product-name, .name, h3').first().text().trim();
            if (!name) return;

            const linkEl = $el.find('a').first();
            const productPath = linkEl.attr('href') || '';
            const codeMatch = productPath.match(/gcode=([^&]+)/i);
            const code = codeMatch ? codeMatch[1] : name.slice(0, 20).replace(/\W+/g, '-');

            const dateText = $el.find('[class*="preorder"], [class*="deadline"], [class*="release"]').first().text().trim();
            const imgEl = $el.find('img[data-src], img').first();
            const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';

            products.push({
              key: `ami-${code}`,
              name,
              category: $el.find('[class*="genre"], [class*="category"]').first().text().trim(),
              price: $el.find('.product-price, .price').first().text().trim(),
              deadline: parseDate(dateText),
              source: 'AmiAmi',
              imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.amiami.com${imageUrl}` : '',
              productUrl: productPath.startsWith('http') ? productPath : `https://www.amiami.com${productPath}`,
            });
          });

          if (products.length > 0) break;
        }
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
const axios = require('axios');
const cheerio = require('cheerio');

const JP_EN = {
  'フィギュア': 'Figure', 'プラモデル': 'Plastic Model', 'ぬいぐるみ': 'Plush',
  'アクセサリー': 'Accessories', 'キーホルダー': 'Keychain', 'タオル': 'Towel',
  'Tシャツ': 'T-Shirt', 'ポスター': 'Poster', 'バッグ': 'Bag',
  'スケール': 'Scale', 'ねんどろいど': 'Nendoroid', 'figma': 'figma',
};

function translateJP(text) {
  if (!text) return '';
  for (const [jp, en] of Object.entries(JP_EN)) {
    text = text.replaceAll(jp, en);
  }
  return text;
}

/** Try GoodSmile's JSON API first, fall back to HTML scraping */
async function scrapeGoodSmile() {
  const products = [];

  // ── Attempt 1: JSON search API ─────────────────────────────────────────
  try {
    const res = await axios.get('https://www.goodsmile.info/ja/products/search', {
      params: { utf8: '✓', genre_id: '', scale: '', series: '', maker: '', sex: '',
                sales_area: '', preorder: '1', on_sale: '', keyword: '' },
      timeout: 20000,
      headers: {
        'User-Agent': 'AnimeAlert/1.0 (+https://animealert.vercel.app)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja',
      },
    });

    const $ = cheerio.load(res.data);

    // Selector variants across GSC page versions
    const ITEM_SELECTORS = [
      '.hitItem', '.hitArticle', 'li.item', '.product', '[class*="hitItem"]',
    ];
    const NAME_SELECTORS  = ['.hitTtl a', '.hitTtl', '.name', 'h3', '[class*="Ttl"]'];
    const DATE_SELECTORS  = ['.hitDate', '.releaseDate', '[class*="Date"]', 'time'];
    const PRICE_SELECTORS = ['.hitPrice', '.price', '[class*="Price"]'];
    const IMG_SELECTORS   = ['img[data-src]', 'img[src]'];

    function first($el, selectors) {
      for (const s of selectors) {
        const t = $el.find(s).first().text().trim();
        if (t) return t;
      }
      return '';
    }

    for (const itemSel of ITEM_SELECTORS) {
      const items = $(itemSel);
      if (items.length === 0) continue;

      items.each((_, el) => {
        const $el = $(el);
        const name = first($el, NAME_SELECTORS);
        if (!name) return;

        const dateRaw = first($el, DATE_SELECTORS);
        const dateMatch = dateRaw.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
        const deadline = dateMatch
          ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
          : null;

        const imgEl = $el.find('img[data-src], img').first();
        const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
        const linkEl = $el.find('a').first();
        const productPath = linkEl.attr('href') || '';
        const idMatch = productPath.match(/\/p\/(\d+)/);
        const key = idMatch
          ? `gsc-${idMatch[1]}`
          : `gsc-${Buffer.from(name.slice(0, 30)).toString('base64url').slice(0, 16)}`;

        products.push({
          key,
          name: translateJP(name),
          category: translateJP(first($el, ['.hitCat', '.category', '[class*="Cat"]'])),
          price: first($el, PRICE_SELECTORS),
          deadline,
          source: 'GoodSmile',
          imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.info${imageUrl}` : '',
          productUrl: productPath.startsWith('http') ? productPath : `https://www.goodsmile.info${productPath}`,
        });
      });

      if (products.length > 0) break; // found with this selector
    }

    if (products.length > 0) {
      console.log(`[gsc] scraped ${products.length} products`);
      return products;
    }
  } catch (err) {
    console.error('[gsc] HTML scrape error:', err.message);
  }

  // ── Attempt 2: preorder schedule page ──────────────────────────────────
  try {
    const res = await axios.get('https://www.goodsmile.info/ja/preorder/schedule', {
      timeout: 20000,
      headers: {
        'User-Agent': 'AnimeAlert/1.0 (+https://animealert.vercel.app)',
        'Accept-Language': 'ja',
      },
    });

    const $ = cheerio.load(res.data);

    // Walk every <a> that looks like a product link under a date heading
    let currentDeadline = null;
    $('body').find('*').each((_, el) => {
      const $el = $(el);
      const tag = el.tagName?.toLowerCase();

      // Detect date headings
      if (['h2', 'h3', 'h4', 'dt', 'th'].includes(tag)) {
        const txt = $el.text();
        const m = txt.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (m) currentDeadline = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
      }

      // Detect product links
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

    console.log(`[gsc] schedule scrape: ${products.length} products`);
  } catch (err) {
    console.error('[gsc] schedule scrape error:', err.message);
  }

  return products;
}

module.exports = { scrapeGoodSmile };

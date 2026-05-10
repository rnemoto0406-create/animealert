const axios = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = 800;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeAmiAmi(pages = 3) {
  const products = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const res = await axios.get('https://www.amiami.com/eng/search/list/', {
        params: {
          s_sortkey: 'preorderclose',
          pagecnt: page,
          pagemax: 40,
          s_st_list_preorder_available: 1,
        },
        timeout: 20000,
        headers: {
          'User-Agent': 'AnimeAlert/1.0 (preorder tracker; contact: rnemoto0406@gmail.com)',
          Accept: 'text/html',
        },
      });

      const $ = cheerio.load(res.data);

      $('li.product-item, .product-item-inner, [class*="product-item"]').each((_, el) => {
        const name = $(el).find('.product-name, .name, h3').first().text().trim();
        if (!name) return;

        const deadlineRaw = $(el).find('[class*="preorder"], [class*="deadline"], .preorderclose').text().trim();
        const dateMatch = deadlineRaw.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
        const deadline = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

        const price = $(el).find('.product-price, .price').first().text().trim();
        const imgEl = $(el).find('img').first();
        const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
        const linkEl = $(el).find('a').first();
        const productPath = linkEl.attr('href') || '';

        const codeMatch = productPath.match(/[?&]scode=([^&]+)/i) || productPath.match(/\/([A-Z0-9-]+)\/?$/);
        const code = codeMatch ? codeMatch[1] : name.slice(0, 20).replace(/\s+/g, '-');
        const key = `ami-${code}`;

        products.push({
          key,
          name,
          category: '',
          price,
          deadline,
          source: 'AmiAmi',
          imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.amiami.com${imageUrl}` : '',
          productUrl: productPath.startsWith('http') ? productPath : `https://www.amiami.com${productPath}`,
        });
      });

      if (page < pages) await sleep(DELAY_MS);
    } catch (err) {
      console.error(`AmiAmi scrape error (page ${page}):`, err.message);
    }
  }

  return products;
}

module.exports = { scrapeAmiAmi };

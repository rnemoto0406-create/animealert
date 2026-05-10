const axios = require('axios');
const cheerio = require('cheerio');

const JP_EN = {
  'フィギュア': 'Figure', 'プラモデル': 'Plastic Model', 'ぬいぐるみ': 'Plush',
  'アクセサリー': 'Accessories', 'キーホルダー': 'Keychain', 'タオル': 'Towel',
  'Tシャツ': 'T-Shirt', 'ポスター': 'Poster', 'バッグ': 'Bag',
};

function translateJP(text) {
  if (!text) return text;
  for (const [jp, en] of Object.entries(JP_EN)) {
    text = text.replaceAll(jp, en);
  }
  return text;
}

async function scrapeGoodSmile() {
  const products = [];
  try {
    const res = await axios.get('https://www.goodsmile.info/ja/preorder/schedule', {
      timeout: 20000,
      headers: {
        'User-Agent': 'AnimeAlert/1.0 (preorder tracker; contact: rnemoto0406@gmail.com)',
        'Accept-Language': 'ja,en;q=0.9',
      },
    });
    const $ = cheerio.load(res.data);

    // GoodSmile groups products by deadline date
    $('.hitGroup, .deadlineGroup, [class*="hitGroup"]').each((_, group) => {
      const headingText = $(group).find('.hitGroupTitle, .groupTitle, h2, h3').first().text().trim();
      const dateMatch = headingText.match(/(\d{4})年(\d{2})月(\d{2})日/);
      const deadline = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

      $(group).find('.hitItem, .productItem, [class*="hitItem"]').each((_, item) => {
        const name = $(item).find('.hitTtl, .productTitle, [class*="Ttl"]').first().text().trim();
        if (!name) return;

        const category = $(item).find('.hitCat, .category, [class*="Cat"]').first().text().trim();
        const price = $(item).find('.hitPrice, .price, [class*="Price"]').first().text().trim();
        const imgEl = $(item).find('img').first();
        const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
        const linkEl = $(item).find('a').first();
        const productPath = linkEl.attr('href') || '';

        const idMatch = productPath.match(/\/p\/(\d+)/);
        const key = idMatch ? `gsc-${idMatch[1]}` : `gsc-${Buffer.from(name).toString('base64').slice(0, 16)}`;

        products.push({
          key,
          name: translateJP(name),
          category: translateJP(category),
          price,
          deadline,
          source: 'GoodSmile',
          imageUrl: imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https://www.goodsmile.info${imageUrl}` : '',
          productUrl: productPath.startsWith('http') ? productPath : `https://www.goodsmile.info${productPath}`,
        });
      });
    });

    // Fallback: flat list if no groups found
    if (products.length === 0) {
      $('.hitItem, .product-item').each((_, item) => {
        const name = $(item).find('.hitTtl, .name').first().text().trim();
        if (!name) return;
        const key = `gsc-${Buffer.from(name).toString('base64').slice(0, 16)}`;
        products.push({
          key,
          name: translateJP(name),
          category: '',
          price: '',
          deadline: null,
          source: 'GoodSmile',
          imageUrl: '',
          productUrl: '',
        });
      });
    }
  } catch (err) {
    console.error('GoodSmile scrape error:', err.message);
  }
  return products;
}

module.exports = { scrapeGoodSmile };

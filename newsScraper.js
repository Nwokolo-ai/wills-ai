const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const rss = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
});

const OUT = path.join(__dirname, 'data', 'investing_news.json');

const FEEDS = {
  forex: 'https://www.investing.com/rss/news_1.rss',
  forex_news: 'https://www.investing.com/rss/news_14.rss',
  crypto: 'https://www.investing.com/rss/news_301.rss',
  commodities: 'https://www.investing.com/rss/news_11.rss',
  economy: 'https://www.investing.com/rss/news_95.rss',
  stocks: 'https://www.investing.com/rss/news_25.rss',
  markets: 'https://www.investing.com/rss/news_285.rss',
};

async function fetchAll() {
  const t0 = Date.now();
  const all = [];
  const seen = new Set();

  for (const [category, url] of Object.entries(FEEDS)) {
    try {
      const feed = await rss.parseURL(url);
      let added = 0;
      for (const item of feed.items || []) {
        const key = (item.link || item.title || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push({
          category, title: item.title || '', link: item.link || '',
          snippet: (item.contentSnippet || item.content || '').slice(0, 400),
          pubDate: item.pubDate || item.isoDate || null,
          source: 'investing.com',
        });
        added++;
      }
      console.log(`[news:${category}] ${added}`);
    } catch (err) {
      console.error(`[news:${category}] error: ${err.message}`);
    }
  }

  all.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
      scraped_at: new Date().toISOString(),
      count: all.length,
      items: all,
    }, null, 2));
  } catch (e) { console.error('[news] write failed:', e.message); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[news] TOTAL ${all.length} in ${elapsed}s`);
}

module.exports = { fetchAll };

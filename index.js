// index.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));


const PORT = process.env.PORT || 3000;

// In-memory cache of the index so we don't hammer APIs
let cachedIndex = null;
let cachedAt = null;
let previousEbayAvg = null;

// --- eBay AUTH ----------------------------------------------------

async function getEbayAccessToken() {
  const clientId = process.env.EBAY_APP_ID;
  const clientSecret = process.env.EBAY_CERT_ID;

  if (!clientId || !clientSecret) {
    throw new Error('EBAY_APP_ID or EBAY_CERT_ID missing in .env');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      }
    }
  );

  return resp.data.access_token;
}

// --- DATA FETCHERS ------------------------------------------------

// eBay: pull a slice of Pokémon card listings
async function fetchEbayPokemonData(accessToken) {
  const resp = await axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        q: 'pokemon card',
        category_ids: '183454',   // Trading Card Games
        filter: 'price:[5..1000]', // ignore penny junk and insane outliers
        limit: 50
      }
    }
  );

  return resp.data;
}

// OPTIONAL: PokePrice – placeholder URL for now.
// If it fails, we just fall back to eBay-only data.
async function fetchPokePriceMarket() {
  const key = process.env.POKEPRICE_API_KEY;
  if (!key) return null;

  try {
    const resp = await axios.get(
      'https://api.pokeprice.io/placeholder/market-index', // TODO: real endpoint later
      {
        headers: { Authorization: `Bearer ${key}` }
      }
    );
    return resp.data;
  } catch (err) {
    console.warn('PokePrice call failed (using eBay-only index):', err.message);
    return null;
  }
}

// --- INDEX CALCULATION --------------------------------------------

function computeMarketIndex({ ebay, poke }) {
  const items = ebay?.itemSummaries || [];
  const ebayAvg =
    items.length > 0
      ? items.reduce((sum, item) => {
          const price = parseFloat(item?.price?.value || '0');
          return sum + (isNaN(price) ? 0 : price);
        }, 0) / items.length
      : 0;

  let ebayChange = 0;
  if (previousEbayAvg && previousEbayAvg > 0) {
    ebayChange = (ebayAvg - previousEbayAvg) / previousEbayAvg;
  }
  previousEbayAvg = ebayAvg;

  // PokePrice contribution, if present
  let pokeTrend = 0;
  let pokeAvg = null;
  if (poke) {
    if (typeof poke.trend === 'number') pokeTrend = poke.trend;
    if (typeof poke.avgPrice === 'number') pokeAvg = poke.avgPrice;
  }

  // Clamp ebayChange so crazy spikes don't explode the index
  const clampedChange = Math.max(-0.5, Math.min(0.5, ebayChange));

  // Composite score: mostly eBay, a bit of PokePrice
  const composite = (clampedChange * 0.7) + (pokeTrend * 0.3);

  // Map composite to 0–100 index, centered at 50
  let indexValue = Math.round(50 + composite * 100);
  indexValue = Math.max(0, Math.min(100, indexValue));

  let sentiment = 'neutral';
  if (composite > 0.05) sentiment = 'bullish';
  if (composite < -0.05) sentiment = 'bearish';

  return {
    index: indexValue,
    sentiment,
    composite: Number(composite.toFixed(4)),
    ebayAvg: Number(ebayAvg.toFixed(2)),
    ebayChangePercent: Number((ebayChange * 100).toFixed(2)),
    pokeTrend: Number(pokeTrend.toFixed(4)),
    pokeAvg
  };
}

// --- REBUILD JOB --------------------------------------------------

async function rebuildIndex() {
  try {
    const token = await getEbayAccessToken();
    const [ebayData, pokeData] = await Promise.all([
      fetchEbayPokemonData(token),
      fetchPokePriceMarket()
    ]);

    const index = computeMarketIndex({ ebay: ebayData, poke: pokeData });

    cachedIndex = index;
    cachedAt = new Date().toISOString();

    console.log('Index updated at', cachedAt, index);
  } catch (err) {
    console.error('Error rebuilding index:', err.response?.data || err.message);
  }
}

// Run once on startup
rebuildIndex();

// Then every 30 minutes
cron.schedule('*/30 * * * *', rebuildIndex);

// --- API ENDPOINTS -----------------------------------------------

// Main index endpoint – used by your widget
app.get('/api/index', (req, res) => {
  if (!cachedIndex) {
    return res.status(503).json({ error: 'Index not ready yet. Try again in a bit.' });
  }

  res.json({
    updatedAt: cachedAt,
    ...cachedIndex
  });
});

// Batch price checker: POST { "cards": ["name1", "name2"] }
app.post('/api/check-prices', async (req, res) => {
  const { cards } = req.body;
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Provide "cards" as a non-empty array of names.' });
  }

  try {
    const token = await getEbayAccessToken();
    const results = [];

    for (const rawName of cards) {
      const name = String(rawName);

      const resp = await axios.get(
        'https://api.ebay.com/buy/browse/v1/item_summary/search',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          params: {
            q: name,
            category_ids: '183454',
            filter: 'price:[5..1000]',
            limit: 20
          }
        }
      );

      const items = resp.data.itemSummaries || [];
      const avg =
        items.length > 0
          ? items.reduce((sum, item) => {
              const price = parseFloat(item?.price?.value || '0');
              return sum + (isNaN(price) ? 0 : price);
            }, 0) / items.length
          : 0;

      results.push({
        card: name,
        ebayAverage: Number(avg.toFixed(2)),
        listingsCount: items.length
      });
    }

    res.json({ results });
  } catch (err) {
    console.error('check-prices error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch prices from eBay.' });
  }
});

app.listen(PORT, () => {
  console.log(`Pokemon Market Index server running on http://localhost:${PORT}`);
});

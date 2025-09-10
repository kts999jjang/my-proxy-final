const { Redis } = require('@upstash/redis');

module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (request.method === 'OPTIONS') { return response.status(200).end(); }

  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const cachedData = await redis.get('latest_recommendations');

    if (!cachedData) {
      return response.status(404).json({ error: 'Analyzed data not found. Please run the analysis script.' });
    }

    response.setHeader('Content-Type', 'application/json');
    return response.status(200).send(cachedData);

  } catch (error) {
    console.error('Themes API Error:', error);
    return response.status(500).json({ error: 'Failed to fetch recommendations from cache.' });
  }
};
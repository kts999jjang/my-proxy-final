// my-proxy-final/api/get-trending-themes.js

import fetch from 'node-fetch';

const kInvestmentThemes = {
  '인공지능(AI)': {
    query: '"artificial intelligence" OR "AI" OR "machine learning" OR nvidia OR openai',
  },
  '메타버스 & VR': {
    query: 'metaverse OR "virtual reality" OR "augmented reality" OR meta OR appl',
  },
  '전기차 & 자율주행': {
    query: '"electric vehicle" OR "self-driving" OR tesla OR rivian OR lucid',
  },
  '클라우드 컴퓨팅': {
    query: '"cloud computing" OR aws OR "amazon web services" OR "google cloud" OR azure',
  }
};

async function fetchNewsCountForTheme(themeQuery) {
  try {
    // GNews는 totalArticles 값을 더 관대하게 제공하므로 테마 스코어링에 사용합니다.
    const apiKey = process.env.GNEWS_API_KEY;
    if (!apiKey) throw new Error('GNEWS_API_KEY is not set.');

    const url = `https://gnews.io/api/v4/search?q=(${themeQuery})&lang=en&max=100&apikey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return 0;
    const data = await response.json();
    return data.totalArticles || 0;
  } catch (error) {
    console.error(`Error fetching news count for query "${themeQuery}":`, error);
    return 0;
  }
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const themePromises = Object.entries(kInvestmentThemes).map(async ([themeName, themeData]) => {
      const count = await fetchNewsCountForTheme(themeData.query);
      return { themeName, score: count };
    });

    const themeScores = await Promise.all(themePromises);
    const trendingThemes = themeScores
        .filter(theme => theme.score > 0) // 점수가 0 이상인 테마만 필터링
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);

    response.status(200).json({ trendingThemes });

  } catch (error) {
    console.error('Server Error in get-trending-themes:', error);
    response.status(500).json({ error: 'Failed to fetch trending themes' });
  }
}
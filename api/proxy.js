// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');
const nlp = require('compromise'); // NLP 라이브러리 import

// --- 상수 정의 ---

const kInvestmentThemes = { /* 이전과 동일 */ };

// ✨ 1. TickerInfo를 '회사명 -> 티커' 맵핑용으로 확장. 다양한 이름 포함
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'] },
  'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'] },
  'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'] },
  'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'] },
  'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'] },
  'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'] },
  'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'] },
  'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'] },
  'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'] },
  'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'] },
  'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'] },
  'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian'] },
  'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid'] },
  'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'] },
  'F': { name: 'Ford Motor Company', keywords: ['ford'] },
  'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'] },
  'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'] },
  'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake'] },
  'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike'] }
};

// --- API 호출 함수 (이전과 동일) ---

async function fetchNewsForTheme(themeName, themeQuery, analysisDays) { /* 이전과 동일 */ }
async function fetchStockDataFromYahoo(tickers) { /* 이전과GLISH */ }


// --- 메인 핸들러 ---
module.exports = async (request, response) => {
  // ... (CORS 헤더 설정 등 이전과 동일) ...

  try {
    const { analysisDays = '14' } = request.query;

    const themePromises = Object.entries(kInvestmentThemes).map(([themeName, themeData]) =>
      fetchNewsForTheme(themeName, themeData.query, parseInt(analysisDays))
    );
    const themeResults = await Promise.all(themePromises);
    const topTheme = themeResults.sort((a, b) => b.totalResults - a.totalResults)[0];
    
    if (!topTheme || topTheme.totalResults < 5) { /* 이전과 동일 */ }

    const trendingThemeName = topTheme.themeName;
    const allArticles = topTheme.articles;

    // ✨ 2. NLP를 이용해 뉴스 기사에서 회사 이름(조직) 추출
    const organizationCounts = {};
    allArticles.forEach(article => {
      const doc = nlp(article.title);
      const organizations = doc.organizations().out('array');
      organizations.forEach(org => {
        const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
      });
    });

    // ✨ 3. 추출된 회사 이름을 티커로 변환하고 점수 합산
    const tickerScores = {};
    for (const orgName in organizationCounts) {
      for (const ticker in kTickerInfo) {
        if (kTickerInfo[ticker].keywords.includes(orgName)) {
          tickerScores[ticker] = (tickerScores[ticker] || 0) + organizationCounts[orgName];
          break;
        }
      }
    }
    
    // ✨ 4. 가장 많이 언급된 상위 3개 종목 티커 선정
    const topTickers = Object.entries(tickerScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0]);

    if (topTickers.length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: 'Could not discover any stocks from news articles.'
        });
    }

    const stockDataResults = await fetchStockDataFromYahoo(topTickers);
    
    // ... (이하 추천 데이터 구성 및 응답 전송 로직은 이전과 동일) ...
    
  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};
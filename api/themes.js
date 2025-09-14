// my-proxy-final/api/themes.js

const { Redis } = require('@upstash/redis');

module.exports = async (request, response) => {
  // CORS 헤더 설정 (모든 도메인에서의 요청 허용)
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight 요청(OPTIONS)에 대한 처리
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    // Redis 클라이언트 초기화
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // 'latest_recommendations' 키로 저장된 데이터 조회
    const cachedData = await redis.get('latest_recommendations');

    // 데이터가 없는 경우 404 에러 반환
    if (!cachedData) {
      return response.status(404).json({ error: 'Analyzed data not found. Please run the analysis script.' });
    }

    // 조회된 데이터를 JSON 형식으로 앱에 반환
    response.setHeader('Content-Type', 'application/json');
    // Redis에서 가져온 데이터가 문자열이므로, 객체로 다시 파싱해서 보내줍니다.
    return response.status(200).json(JSON.parse(cachedData));

  } catch (error) {
    console.error('Themes API Error:', error);
    return response.status(500).json({ error: 'Failed to fetch recommendations from cache.' });
  }
};
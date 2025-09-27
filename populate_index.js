require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Redis } = require('@upstash/redis');

// --- 설정 ---
const INDEX_NAME = 'gcp-starter-gemini';
const BATCH_SIZE = 100;
const DAYS_TO_FETCH = 1; // 매일 실행되므로, 최근 하루치 데이터만 수집하여 누적합니다.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 메인 실행 함수 ---
async function main() {
  console.log(`데이터 준비 스크립트를 시작합니다... (지난 ${DAYS_TO_FETCH}일)`);

  const pinecone = new Pinecone();
  const index = pinecone.index(INDEX_NAME);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // ✨ FIX: 스크립트 시작 시 Pinecone 인덱스의 현재 벡터 수를 확인
  // ✨ FIX: describeIndexStats()의 응답 구조가 변경될 수 있으므로, 더 안전하게 값을 확인합니다.
  const stats = await index.describeIndexStats() || {};
  const totalVectors = stats.totalVectorCount ?? 0;
  const dateRange = await redis.get('news_date_range');
  const { oldest, newest } = dateRange || { oldest: 'N/A', newest: 'N/A' };

  console.log(`
    --- 데이터 현황 ---
    - Pinecone 벡터 수: ${totalVectors}개
    - 뉴스 데이터 기간: ${oldest} ~ ${newest}
  `);
  console.log("1. GNews에서 뉴스 기사를 수집합니다...");
  let allArticles = [];
  
  // ✨ CHANGED: 지정된 기간만큼 하루씩 반복하며 데이터 수집
  for (let i = 0; i < DAYS_TO_FETCH; i++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    
    const from = new Date(targetDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(targetDate);
    to.setHours(23, 59, 59, 999);

    console.log(`\n[${i + 1}/${DAYS_TO_FETCH}] ${targetDate.toISOString().split('T')[0]} 날짜의 데이터를 수집합니다...`);

    try {
        // ✨ FIX: 특정 키워드 대신, 광범위한 주제의 뉴스를 수집하여 데이터 편향을 최소화합니다.
        const gnewsUrl = `https://gnews.io/api/v4/search?q="market OR stock"&topic=business,technology&lang=en&max=100&from=${from.toISOString()}&to=${to.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        
        // ✨ FIX: GNews API 호출 시 타임아웃 및 재시도 로직을 추가하여 안정성을 높입니다.
        let response;
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                response = await fetch(gnewsUrl, { timeout: 30000 }); // 30초 타임아웃
                if (response.ok) break;
            } catch (e) {
                console.warn(`  - GNews API 호출 실패 (시도 ${attempts + 1}/${maxAttempts})...`);
            }
            attempts++;
            await sleep(2000); // 2초 후 재시도
        }

        const data = await response.json();
        if (data.articles) {
            allArticles.push(...data.articles);
            console.log(`  - 비즈니스/기술 기사 ${data.articles.length}개 수집 완료.`);
        }
    } catch (e) {
        console.error(`뉴스 기사 수집 중 오류 발생:`, e);
    }
  }
  
  const uniqueArticles = Array.from(new Map(allArticles.map(article => [article.url, article])).values());
  console.log(`\n총 ${uniqueArticles.length}개의 고유한 기사가 수집되었습니다.`);

  console.log("\n2. 기사 제목을 Gemini 임베딩으로 변환합니다...");
  let vectors = [];
  for (const article of uniqueArticles) {
    try {
      // ✨ FIX: run_analysis.js와 동일한 임베딩 모델 및 taskType을 사용하여 차원 불일치 문제를 해결합니다.
      const embeddingResult = await embeddingModel.embedContent({ content: { parts: [{ text: article.title }] }, taskType: "RETRIEVAL_DOCUMENT" });
      const vector = embeddingResult.embedding.values;
      
      const publishedAtTimestamp = Math.floor(new Date(article.publishedAt).getTime() / 1000);

      vectors.push({
        id: article.url,
        values: vector,
        metadata: {
          title: article.title,
          source: article.source.name,
          url: article.url,
          publishedAt: publishedAtTimestamp,
        },
      });
      
      await sleep(1100); // 분당 요청 제한을 피하기 위한 지연

    } catch (e) {
      console.error(`'${article.title}' 임베딩 변환 중 오류:`, e.message);
      await sleep(5000);
    }
    if (vectors.length % 10 === 0) {
        console.log(`  - ${vectors.length} / ${uniqueArticles.length}개 변환 완료...`);
    }
  }
  console.log(`${vectors.length}개의 벡터 생성이 완료되었습니다.`);

  console.log("\n3. Pinecone 인덱스에 데이터를 저장(upsert)합니다...");
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    try {
      await index.upsert(batch);
      console.log(`  - ${i + batch.length} / ${vectors.length}개 데이터 저장 완료.`);
    } catch (e) {
      console.error("Pinecone 저장 중 오류 발생:", e);
    }
  }
  
  console.log("\n✨ 데이터 준비가 완료되었습니다!");
  // ✨ FIX: 데이터 기간을 Redis에 저장
  if (uniqueArticles.length > 0) {
    const timestamps = uniqueArticles.map(a => new Date(a.publishedAt).getTime());
    const oldestDate = new Date(Math.min(...timestamps)).toISOString().split('T')[0];
    const newestDate = new Date(Math.max(...timestamps)).toISOString().split('T')[0];
    await redis.set('news_date_range', { oldest: oldestDate, newest: newestDate });
    console.log(`\n데이터 기간을 Redis에 저장했습니다: ${oldestDate} ~ ${newestDate}`);
  }
}

main().catch(console.error);
require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 설정 ---
const INDEX_NAME = 'gcp-starter-gemini';
const BATCH_SIZE = 100;
const DAYS_TO_FETCH = 7; // ✨ 데이터를 수집할 기간 (일)

const kInvestmentThemes = {
  '인공지능(AI)': { query: '"artificial intelligence" OR "semiconductor" OR "machine learning" OR "NVIDIA"', },
  '메타버스 & VR': { query: '"metaverse" OR "virtual reality" OR "augmented reality" OR "Roblox" OR "Unity"', },
  '전기차 & 자율주행': { query: '"electric vehicle" OR "self-driving" OR "autonomous car" OR "Tesla" OR "Rivian"', },
  '클라우드 컴퓨팅': { query: '"cloud computing" OR "data center" OR "SaaS" OR "Amazon AWS" OR "Microsoft Azure"', }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 메인 실행 함수 ---
async function main() {
  console.log(`데이터 준비 스크립트를 시작합니다... (지난 ${DAYS_TO_FETCH}일)`);

  const pinecone = new Pinecone();
  const index = pinecone.index(INDEX_NAME);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

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

    for (const [themeName, themeData] of Object.entries(kInvestmentThemes)) {
      try {
        const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&topic=business,technology&lang=en&max=100&from=${from.toISOString()}&to=${to.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        const response = await fetch(gnewsUrl);
        const data = await response.json();
        if (data.articles) {
          allArticles.push(...data.articles);
          console.log(`  - '${themeName}' 테마 기사 ${data.articles.length}개 수집 완료.`);
        }
      } catch (e) {
        console.error(`'${themeName}' 테마 기사 수집 중 오류 발생:`, e);
      }
    }
  }
  
  const uniqueArticles = Array.from(new Map(allArticles.map(article => [article.url, article])).values());
  console.log(`\n총 ${uniqueArticles.length}개의 고유한 기사가 수집되었습니다.`);

  console.log("\n2. 기사 제목을 Gemini 임베딩으로 변환합니다...");
  let vectors = [];
  for (const article of uniqueArticles) {
    try {
      const embeddingResult = await embeddingModel.embedContent(article.title);
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
}

main().catch(console.error);
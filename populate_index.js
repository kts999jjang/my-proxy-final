require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleGenerativeAI, Groq } = require('@google/generative-ai'); // Groq might not be needed here, but good for consistency

// --- 설정 ---
const INDEX_NAME = 'gcp-starter-gemini';
const BATCH_SIZE = 100;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 메인 실행 함수 ---

// This is a simplified version of the AIService from run_analysis.js
// In a larger project, this would be a shared module.
class EmbeddingService {
    constructor() {
        this.providers = [];
        if (process.env.GEMINI_API_KEY) {
            const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.providers.push({
                name: 'Gemini',
                embed: (content) => this.embedWithGemini(geminiClient, content),
            });
        }
    }

    async embedWithGemini(client, content) {
        const model = client.getGenerativeModel({ model: "text-embedding-004" }, { apiVersion: 'v1' });
        const result = await model.embedContent(content);
        return result.embedding.values;
    }

    async embedContent(content) {
        if (this.providers.length === 0) {
            throw new Error("사용 가능한 임베딩 서비스가 없습니다.");
        }

        for (const provider of this.providers) {
            try {
                // A simple retry loop for robustness
                for (let i = 0; i < 3; i++) {
                    try {
                        return await provider.embed(content);
                    } catch (e) {
                        if (i === 2) throw e; // Rethrow on last attempt
                        console.warn(`  - ${provider.name} 임베딩 재시도 (${i + 1}/3)...`);
                        await sleep(1000 * (i + 1));
                    }
                }
            } catch (e) { continue; } // Move to next provider
        }
        throw new Error("모든 임베딩 서비스 호출에 실패했습니다.");
    }
}
async function main() {
  // ✨ FIX: 커맨드 라인 인자에서 수집할 기간을 파싱합니다.
  const args = process.argv.slice(2);
  const daysArg = args.find(arg => arg.startsWith('--days='));
  // 인자가 없으면 기본값 3일, 있으면 해당 값으로 설정 (최대 90일 제한)
  const DAYS_TO_FETCH = daysArg ? Math.min(parseInt(daysArg.split('=')[1], 10), 90) : 3;

  console.log(`데이터 준비 스크립트를 시작합니다... (지난 ${DAYS_TO_FETCH}일)`);

  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });
  const index = pinecone.index(INDEX_NAME);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // ✨ FIX: 라이브러리 명세에 따라 getGenerativeModel의 두 번째 인자로 apiVersion을 전달합니다.
  const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" }, { apiVersion: 'v1' });
  const redis = new (require('@upstash/redis').Redis)({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

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
        const gnewsUrl = `https://gnews.io/api/v4/search?q=("stock market" OR "wall street" OR "nasdaq" OR "nyse")&topic=business,technology&lang=en&max=25&from=${from.toISOString()}&to=${to.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        
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

        // ✨ FIX: 모든 재시도가 실패하여 response가 undefined일 경우를 처리합니다.
        if (!response || !response.ok) {
            console.error(`  - ${targetDate.toISOString().split('T')[0]} 날짜의 GNews 데이터 수집에 최종적으로 실패했습니다.`);
            continue; // 다음 날짜로 넘어감
        }

        const data = await response.json(); // 이제 response는 항상 유효한 객체입니다.
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
      let embeddingResult;
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        try {
          embeddingResult = await embeddingModel.embedContent(
            { content: { parts: [{ text: article.title }] }, taskType: "RETRIEVAL_DOCUMENT" }
          );
          break; // 성공 시 루프 탈출
        } catch (e) {
          attempts++;
          if (attempts >= maxAttempts) throw e; // 최대 시도 횟수 초과 시 오류 발생
          console.warn(`'${article.title}' 임베딩 재시도 (${attempts}/${maxAttempts})...`);
          await sleep(2000 * attempts); // 재시도 간격 증가
        }
      }

      const vector = embeddingResult.embedding.values;
      vectors.push({
        id: article.url,
        values: vector,
        metadata: {
          title: article.title,
          source: article.source.name,
          url: article.url,
          publishedAt: Math.floor(new Date(article.publishedAt).getTime() / 1000),
        },
      });
      
    } catch (e) {
      console.error(`'${article.title}' 임베딩 변환 중 오류:`, e.message);
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

  // ✨ FIX: 작업 완료 후 최종 통계를 다시 조회하여 로그에 남깁니다.
  console.log("\n4. 최종 데이터 현황을 확인합니다...");
  // 통계가 반영될 시간을 벌기 위해 잠시 대기합니다.
  await sleep(5000); 
  const finalStats = await index.describeIndexStats() || {};
  const finalTotalVectors = finalStats.totalVectorCount ?? 0;
  console.log(`  - 현재 Pinecone 벡터 수: ${finalTotalVectors}개`);
}

main().catch(console.error);
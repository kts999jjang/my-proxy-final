require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getTickerForCompanyName(companyName, redis) {
    const cleanedName = companyName.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
    const cachedData = await redis.get(cleanedName);
    if (cachedData) {
        try {
            // ✨ FIX: 캐시된 데이터가 JSON 형식인지 확인하고 파싱
            return JSON.parse(cachedData);
        } catch (e) {
            // JSON 파싱에 실패하면 과거 데이터(단순 문자열)로 간주하고, 해당 캐시를 삭제하여 다음 실행 시 갱신되도록 함
            await redis.del(cleanedName);
        }
    }

    // ✨ FIX: Alpha Vantage 대신 Finnhub API로 변경
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) throw new Error('FINNHUB_API_KEY is not set.');

    const url = `https://finnhub.io/api/v1/search?q=${cleanedName}&token=${apiKey}`;
    
    try {
        await sleep(1100); // Finnhub API 호출 제한 준수 (분당 60회)
        const response = await fetch(url);
        // ✨ FIX: Finnhub API가 HTML 오류 페이지를 반환하는 경우를 처리합니다.
        if (!response.headers.get('content-type')?.includes('application/json')) {
            const text = await response.text();
            throw new Error(`Finnhub API returned non-JSON response: ${text.substring(0, 100)}`);
        }
        const data = await response.json();

        // Finnhub는 가장 관련성 높은 결과를 첫 번째로 반환합니다.
        const bestMatch = data?.result?.[0];
        if (bestMatch && !bestMatch.symbol.includes('.')) { // .이 포함된 티커(예: BRK.B)는 제외하여 단순화
            const ticker = bestMatch.symbol;
            const companyName = bestMatch.description || ticker;
            // ✨ FIX: 티커와 회사명을 함께 객체로 캐싱
            const result = { ticker, companyName };
            await redis.set(cleanedName, JSON.stringify(result), { ex: 60 * 60 * 24 * 7 });
            return result;
        }
        return null;
    } catch (e) {
        console.error(`Error fetching ticker for "${cleanedName}". Reason: ${e.message}`);
        return null;
    }
}

/**
 * Finnhub API를 사용해 회사의 프로필(산업 분류)을 조회하는 함수
 * @param {string} ticker
 * @returns {Promise<string|null>} 회사의 산업 분류 또는 null
 */
async function getCompanyProfile(ticker) {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.finnhubIndustry || null; // 산업 분류 반환
    } catch (e) {
        console.warn(`  - ${ticker}의 회사 프로필 조회 중 오류: ${e.message}`);
        return null;
    }
}

/**
 * Alpha Vantage API를 사용해 시가총액을 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number|null>} 시가총액 또는 null
 */
async function getMarketCap(ticker) {
    try {
        const marketCap = await getFinancialsMetric(ticker, 'marketCapitalization');
        return marketCap;
    } catch (e) {
        console.warn(`  - ${ticker}의 시가총액 조회 중 오류: ${e.message}`);
        return null;
    }
}
/**
 * Finnhub API를 사용해 내부자 거래 동향을 조회하는 함수
 * @param {string} ticker
 * @returns {Promise<number|null>}
 */
async function getCurrentPriceFromYahoo(ticker) {
    if (!ticker) return null;
    try {
        // 1일치 데이터만 요청하여 가장 최신 가격을 가져옵니다.
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
        if (quotes && quotes.length > 0) {
            return quotes[quotes.length - 1]; // 가장 마지막 가격을 현재가로 사용
        }
        return null;
    } catch (e) {
        console.warn(`  - ${ticker}의 Yahoo Finance 현재가 조회 중 오류: ${e.message}`);
        return null;
    }
}

/**
 * Finnhub API를 사용해 애널리스트 추천 동향을 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 애널리스트 추천 점수
 */
async function getAnalystRatingScore(ticker) {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  - ${ticker}의 애널리스트 평가 조회 실패: Status ${response.status}`);
            return 0;
        }
        const data = (await response.json())?.[0];
        // 'strongBuy'와 'buy'의 합을 점수로 활용
        return (data?.strongBuy || 0) * 2 + (data?.buy || 0);
    } catch (e) {
        console.warn(`  - ${ticker}의 애널리스트 평가 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * Finnhub API를 사용해 모든 필요한 재무 지표를 한 번에 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<object|null>} 재무 지표 객체
 */
async function getFinancialMetrics(ticker) {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  - ${ticker}의 재무 지표 조회 실패: Status ${response.status}`);
            return null;
        }
        const data = await response.json();
        return data?.metric || null;
    } catch (e) {
        return null;
    }
}

/**
 * Finnhub API를 사용해 어닝 서프라이즈 정보를 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 어닝 서프라이즈 점수
 */
async function getEarningsSurpriseScore(ticker) {
    const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  - ${ticker}의 어닝 서프라이즈 조회 실패: Status ${response.status}`);
            return 0;
        }
        const data = await response.json();
        // 최근 4분기 동안 예상치를 상회한(positive surprise) 횟수를 점수로 활용
        const positiveSurprises = data?.filter(d => d.surprise > 0).length || 0;
        return positiveSurprises * 2.5; // 분기당 2.5점 부여
    } catch (e) {
        console.warn(`  - ${ticker}의 어닝 서프라이즈 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * GNews 기사를 기반으로 로컬에서 뉴스 감성 점수를 계산하는 함수
 * @param {string} ticker - 주식 티커
 * @param {Array} allArticles - GNews에서 수집된 모든 기사 배열
 * @param {Object} kTickerInfo - 티커 정보 객체
 * @returns {number} 뉴스 감성 점수
 */
function analyzeLocalNewsSentiment(ticker, allArticles, kTickerInfo) {
    const infoString = kTickerInfo[ticker];
    if (!infoString) return 5; // 정보가 없으면 중립 점수

    try {
        const info = JSON.parse(infoString);
        const keywords = info.keywords || [ticker.toLowerCase()];
        const relevantArticles = allArticles.filter(article => 
            keywords.some(kw => article.title.toLowerCase().includes(kw))
        );

        if (relevantArticles.length === 0) return 5; // 관련 기사가 없으면 중립 점수

        const totalSentiment = relevantArticles.reduce((sum, article) => sum + (nlp(article.title).sentiment().score || 0), 0);
        return 5 + (totalSentiment / relevantArticles.length) * 5; // 0-10점 척도로 변환 (기본 5점)
    } catch (e) {
        return 5; // 파싱 실패 시 중립 점수
    }
}

/**
 * Slack으로 알림 메시지를 전송하는 함수
 * @param {string} message - 보낼 메시지
 * @param {'good' | 'danger' | 'warning'} color - 메시지 색상 (good: 초록, danger: 빨강, warning: 노랑)
 */
async function sendSlackNotification(message, color = 'good') {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
        console.log("Slack Webhook URL이 설정되지 않아 알림을 보내지 않습니다.");
        return;
    }

    const payload = {
        attachments: [{
            color: color,
            text: message,
            ts: Math.floor(Date.now() / 1000)
        }]
    };

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error("Slack 알림 전송 중 오류 발생:", error);
    }
}

class AIService {
    constructor() {
        this.providers = [];
        if (process.env.GEMINI_API_KEY) {
            this.providers.push({
                name: 'Gemini',
                client: new GoogleGenerativeAI(process.env.GEMINI_API_KEY, { apiVersion: 'v1' }),
                generate: this.generateWithGemini,
            });
        }
        if (process.env.GROQ_API_KEY) {
            this.providers.push({
                name: 'Groq',
                client: new Groq({ apiKey: process.env.GROQ_API_KEY }),
                generate: this.generateWithGroq,
            });
        }
    }

    async generateWithGemini(client, prompt) {
        // ✨ FIX: 라이브러리 명세에 따라 getGenerativeModel의 두 번째 인자로 apiVersion을 전달합니다.
        const model = client.getGenerativeModel({ model: "gemini-1.5-pro-latest" }, { apiVersion: 'v1' });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    async generateWithGroq(client, prompt) {
        const chatCompletion = await client.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama3-8b-8192',
            temperature: 0.3,
            response_format: { type: "json_object" },
        });
        return chatCompletion.choices[0]?.message?.content || "";
    }

    async generateContent(prompt) {
        if (this.providers.length === 0) {
            throw new Error("사용 가능한 AI 서비스가 없습니다. API 키를 확인하세요.");
        }

        for (const provider of this.providers) {
            try {
                console.log(`  - ${provider.name} API를 사용하여 콘텐츠 생성을 시도합니다...`);
                const result = await provider.generate(provider.client, prompt);
                console.log(`  - ${provider.name} API 호출 성공!`);
                return result;
            } catch (error) {
                // 429 (Too Many Requests) 또는 5xx (Server Error)일 경우 다음 프로바이더로 넘어감
                if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
                    console.warn(`  - ${provider.name} API 오류 발생 (Status: ${error.status}). 다음 API로 넘어갑니다...`);
                    continue;
                }
                // 그 외의 오류는 즉시 throw
                throw error;
            }
        }

        // 모든 프로바이더가 실패했을 경우
        throw new Error("모든 AI 서비스 호출에 실패했습니다. API 할당량 및 상태를 확인하세요.");
    }
}

/**
 * AI 서비스를 사용하여 최신 뉴스 기반으로 동적 투자 테마와 쿼리를 생성합니다.
 * @returns {Promise<Object>} 동적으로 생성된 투자 테마 객체
 */
async function generateDynamicThemes(aiService, pinecone, daysToAnalyze) {
    // ✨ DEBUG: 함수 시작 로그 추가
    console.log("🤖 AI를 사용하여 최신 투자 테마를 동적으로 생성합니다...");
    try {
        // ✨ FIX: Pinecone에서 최신 뉴스 제목을 가져와 트렌드 분석에 사용합니다.
        const index = pinecone.index('gcp-starter-gemini');
        // ✨ FIX: 원본 Date 객체가 변경되지 않도록 날짜 계산 방식을 수정합니다.
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysToAnalyze);
        const startTimestamp = Math.floor(startDate.getTime() / 1000);

        // ✨ DEBUG: Pinecone 쿼리 시작 로그 추가
        // 임의의 벡터로 쿼리하여 최신 기사를 가져옵니다. (필터링이 핵심)
        const queryResult = await index.query({
            topK: 200, // 트렌드 분석을 위해 200개 기사 샘플링
            vector: Array(768).fill(0), // Pinecone 인덱스 차원(768)과 일치시킵니다.
            includeMetadata: true,
            filter: { "publishedAt": { "$gte": startTimestamp } },
        });

        // ✨ DEBUG: Pinecone 쿼리 결과 확인
        console.log(`  - Pinecone에서 ${queryResult.matches.length}개의 뉴스 제목을 가져왔습니다.`);
        const articleTitles = queryResult.matches.map(match => match.metadata.title).join('\n');
        if (!articleTitles) throw new Error("Pinecone에서 분석할 최신 뉴스를 찾지 못했습니다.");

        // 2. Gemini에 테마 및 쿼리 생성 요청
        const prompt = `Based on the following recent news headlines, provide two things in a single JSON object:
1. A "summary" of the overall market trends from these headlines, written in Korean, within 2-3 sentences.
2. A "themes" object containing the top 5 most promising investment themes. For each theme, provide a concise theme name in Korean and a GNews search query in English, structured like '("core technology" OR "synonym") AND (CompanyName OR "Another Company")'.

News Headlines:
${articleTitles}

Provide the output ONLY in JSON format like this example:
{
  "summary": "최근 시장은 AI 기술의 발전과 금리 변동에 대한 우려가 공존하는 모습을 보이고 있습니다. 특히 반도체 분야의 경쟁이 심화되고 있습니다.",
  "themes": {
    "테마 이름 1": { "query": "GNews query for theme 1" },
    "테마 이름 2": { "query": "GNews query for theme 2" }
  }
}`;


        // ✨ DEBUG: Gemini에게 보낼 프롬프트 확인
        console.log("  - Gemini에게 보낼 프롬프트의 일부:\n", prompt.substring(0, 500) + "...");
        // ✨ FIX: 추상화된 AI 서비스를 통해 콘텐츠 생성
        const responseText = await aiService.generateContent(prompt);
        
        // ✨ FIX: AI 응답 파싱 안정성 강화를 위한 디버깅 및 예외 처리 추가
        console.log("  - AI로부터 받은 원본 응답:\n", responseText);
        
        // 응답에서 JSON 부분만 추출 (마크다운 코드 블록 제거)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("AI 응답에서 유효한 JSON 객체를 찾을 수 없습니다.");
        }
        const jsonString = jsonMatch[0];
        const generatedData = JSON.parse(jsonString); // 여기서 오류 발생 시 catch 블록으로 이동
        const dynamicThemes = generatedData.themes;
        const marketSummary = generatedData.summary;

        console.log("✅ 동적 테마 및 요약 생성 완료:", Object.keys(dynamicThemes || {}).join(', '));
        return { themes: dynamicThemes, summary: marketSummary };

    } catch (error) {
        // ✨ DEBUG: 오류 발생 시 더 상세한 정보 로깅
        console.error("동적 테마 생성 중 치명적인 오류 발생. 기본 테마를 사용합니다. 오류 상세:", error);
        // ✨ FIX: GNews API 실패 시에도 유의미한 분석이 가능하도록 기본 테마를 더 정교하게 구성합니다.
        // ✨ FIX: 오류 발생 시에도 정상 실행과 동일한 데이터 구조({ themes, summary })를 반환하여 타입 오류를 방지합니다.
        return {
            summary: "최신 시장 동향을 가져오는 데 실패하여, 주요 기본 테마를 기반으로 분석을 진행합니다.",
            themes: {
                '인공지능 & 반도체': { query: '("artificial intelligence" OR "semiconductor") AND (NVIDIA OR AMD OR Intel)' },
                '클라우드 & 데이터센터': { query: '("cloud computing" OR "data center") AND ("Amazon AWS" OR "Microsoft Azure")' },
                '전기차 & 자율주행': { query: '("electric vehicle" OR "self-driving") AND (Tesla OR Rivian)' },
                '바이오 & 헬스케어': { query: '("biotechnology" OR "pharmaceutical") AND (Moderna OR Pfizer)' },
            },
        };
    }
}

// --- 메인 실행 함수 ---
async function main() {
    // ✨ FIX: 커맨드 라인 인자에서 분석 기간을 파싱합니다.
    const args = process.argv.slice(2);
    const periodArg = args.find(arg => arg.startsWith('--period='));
    const periodString = periodArg ? periodArg.split('=')[1] : '14d'; // 기본값 14일
    
    const periodMap = { '7d': 7, '14d': 14, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
    const daysToAnalyze = periodMap[periodString] || 14;
    const redisKey = `recommendations_${periodString}`; // 기간별 Redis 키 생성
    console.log(`분석 기간: ${daysToAnalyze}일, Redis 저장 키: ${redisKey}`);

    const pinecone = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY,
    });
    const aiService = new AIService(); // ✨ FIX: AI 서비스 클래스 인스턴스화
    // ✨ FIX: 라이브러리 명세에 따라 getGenerativeModel의 두 번째 인자로 apiVersion을 전달합니다.
    const embeddingModel = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: "text-embedding-004" }, { apiVersion: 'v1' });
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    await sendSlackNotification("📈 주식 분석 스크립트를 시작합니다...", '#439FE0');

    // ✨ FIX: 추상화된 AI 서비스를 사용하여 동적으로 투자 테마 생성
    const { themes: kInvestmentThemes, summary: marketSummary } = await generateDynamicThemes(aiService, pinecone, daysToAnalyze);

    // ✨ FIX: Redis에서 모든 주식 정보를 가져와 메모리에 로드
    const kTickerInfo = await redis.hgetall('stock-info') || {};
    console.log(`${Object.keys(kTickerInfo).length}개의 주식 정보를 Redis에서 로드했습니다.`);

    const finalResults = {};

    // ✨ FIX 3: 시가총액 중복 조회를 방지하기 위한 캐시
    const marketCapCache = new Map();

    try {
        for (const themeName of Object.keys(kInvestmentThemes)) {
            console.log(`\n'${themeName}' 테마 분석 중...`);
            const themeData = kInvestmentThemes[themeName];
            if (!themeData) continue;

            // 1. 테마 쿼리 자체를 직접 임베딩하여 관련 기사 검색 (요약 단계 삭제)
            console.log(`  - '${themeName}' 테마 쿼리를 임베딩하여 관련 기사를 검색합니다.`);
            const index = pinecone.index('gcp-starter-gemini');
            
            // ✨ FIX: 임베딩 API 호출 시 재시도 로직을 추가하여 안정성을 대폭 강화합니다.
            let queryVector;
            try {
                let attempts = 0;
                while (attempts < 3) {
                    try {
                        const embeddingResult = await embeddingModel.embedContent({ content: { parts: [{ text: themeData.query }] }, taskType: "RETRIEVAL_QUERY" });
                        queryVector = embeddingResult.embedding.values;
                        break; // 성공 시 루프 탈출
                    } catch (e) {
                        attempts++;
                        if (attempts >= 3) throw e;
                        console.warn(`  - 임베딩 API 호출 재시도 (${attempts}/3)...`);
                        await sleep(2000 * attempts);
                    }
                }
            } catch (e) {
                console.error(`  - '${themeName}' 테마의 임베딩 변환에 최종적으로 실패했습니다. 이 테마를 건너뜁니다.`, e.message);
                continue; // 다음 테마로 넘어감
            }

            // 분석할 기사 수를 500개로 늘림
            const queryResult = await index.query({ 
                topK: 500, 
                vector: queryVector, 
                includeMetadata: true, // ✨ FIX: 필터 제거. Pinecone에는 이미 필요한 데이터만 있음.
            });

            const allFoundArticles = queryResult.matches.map(match => match.metadata);
            if (allFoundArticles.length === 0) {
                console.log(`  - 관련 기사를 찾을 수 없습니다.`);
                continue;
            }
            console.log(`  - Pinecone에서 ${allFoundArticles.length}개의 관련 기사를 분석합니다.`);

            // STEP 1: API 호출 없이 뉴스에서 기관명과 언급 빈도수만 추출
            const organizationCounts = {};
            const BANNED_ORG_NAMES = new Set(['ai', 'inc', 'corp', 'llc', 'ltd', 'group', 'co', 'tech', 'solutions']);

            allFoundArticles.forEach(article => {
                const doc = nlp(article.title);
                doc.organizations().out('array').forEach(org => {
                    const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
                    if (orgName.length > 2 && !BANNED_ORG_NAMES.has(orgName)) {
                        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1; // 기본 언급 횟수
                    }
                });
            });

            const themeTickerScores = {};
            const unknownOrgs = [];

            // ✨ FIX: 모든 기관명에 대해 티커를 조회하고 점수를 집계
            for (const [orgName, count] of Object.entries(organizationCounts)) {
                try {
                    const companyInfo = await getTickerForCompanyName(orgName, redis);
                    if (companyInfo && companyInfo.ticker) {
                        // ✨ FIX: 산업 분류를 확인하여 테마와의 관련성을 검증합니다.
                        // ✨ FIX: 한/영 산업 분류 매핑 테이블을 개선하여 정확도를 높입니다.
                        const industryMap = {
                            'semiconductors': ['반도체'],
                            'software': ['소프트웨어', 'ai', '인공지능', '클라우드'],
                            'technology': ['기술', 'ai', '인공지능', '클라우드'],
                            'health care': ['바이오', '헬스케어', '제약'],
                            'pharmaceuticals': ['바이오', '헬스케어', '제약'],
                            'automobiles': ['전기차', '자율주행', '자동차'],
                            'energy': ['에너지', '친환경'],
                            'media': ['미디어', '엔터테인먼트'],
                            'real estate': ['부동산'],
                            'financial services': ['금융'],
                            'insurance': ['보험'],
                        };

                        const industry = await getCompanyProfile(companyInfo.ticker);
                        // ✨ FIX: 정규식에 유니코드 플래그(u)와 속성(\p{L})을 추가하여 한글 키워드를 올바르게 파싱합니다.
                        const themeKeywords = themeName.toLowerCase().match(/[\p{L}&]+/gu) || [];
                        const industryEn = industry ? industry.toLowerCase() : '';

                        // 테마 키워드가 (1) 영어 산업명 자체와 일치하거나, (2) 매핑 테이블의 한글 번역과 일치하는지 확인
                        // ✨ FIX: 더 정확한 매치를 위해, 영어 산업명을 먼저 한글 키워드로 변환 후 비교합니다.
                        // ✨ FIX: industryEn을 소문자로 변환하여 industryMap의 키와 정확히 일치시키도록 수정합니다.
                        const mappedIndustryKeywords = industryMap[industryEn.toLowerCase()] || [];
                        const isRelevant = themeKeywords.some(themeKw => mappedIndustryKeywords.includes(themeKw));

                        if (isRelevant) {
                            const newTicker = companyInfo.ticker;
                            themeTickerScores[newTicker] = (themeTickerScores[newTicker] || 0) + count;
                            if (!kTickerInfo[newTicker]) {
                                const newInfo = { name: companyInfo.companyName, style: 'growth', keywords: [orgName.toLowerCase()] };
                                kTickerInfo[newTicker] = JSON.stringify(newInfo);
                            }
                        } else {
                            console.log(`  - [${companyInfo.ticker}] ${companyInfo.companyName}는 '${themeName}' 테마와 관련성이 낮아 제외합니다. (산업: ${industry || 'N/A'})`);
                        }
                    }
                } catch (e) {
                    console.warn(`  - '${orgName}' 처리 중 오류 발생: ${e.message}`);
                }
            }

            // STEP 4: 후보군 선정 (언급 빈도 상위 20개)
            const candidatesForAnalysis = Object.entries(themeTickerScores)
                .sort(([,a],[,b]) => b-a)
                .slice(0, 20) // 언급 빈도 상위 20개 종목만 심층 분석
                .map(([ticker, newsScore]) => ({ ticker, newsScore }));
            
            console.log(`  - 상위 ${candidatesForAnalysis.length}개 후보 종목에 대한 심층 분석을 시작합니다...`);

            // ✨ FIX: API 호출 제한(Rate Limit)을 피하기 위해 작업을 작은 묶음(chunk)으로 나누어 처리합니다.
            const CHUNK_SIZE = 5;
            let analysisResults = [];
            for (let i = 0; i < candidatesForAnalysis.length; i += CHUNK_SIZE) {
                const chunk = candidatesForAnalysis.slice(i, i + CHUNK_SIZE);
                console.log(`    - API 호출 묶음 처리 중 (${i + 1} - ${i + chunk.length})...`);
                // ✨ FIX: getCompanyProfile 호출이 추가되었으므로, Promise.all에 추가합니다.
                const chunkPromises = chunk.map(c => Promise.all([
                    getFinancialMetrics(c.ticker),      // API Call 1: 모든 재무/기본 정보
                    getAnalystRatingScore(c.ticker),    // API Call 2: 애널리스트 평가
                    getEarningsSurpriseScore(c.ticker), // API Call 3: 어닝 서프라이즈
                    getCurrentPriceFromYahoo(c.ticker)  // API Call 4: 현재가 (Yahoo)
                ]));
                const chunkResults = await Promise.all(chunkPromises);
                analysisResults.push(...chunkResults);
                await sleep(2000); // 각 묶음 처리 후 2초간 대기하여 API 서버 부담을 줄입니다.
            }

            // STEP 6: 최종 점수 계산 및 추천 목록 생성
            const scoredStocks = [];
            for (let i = 0; i < candidatesForAnalysis.length; i++) {
                const { ticker, newsScore } = candidatesForAnalysis[i];
                const [metrics, analystScore, surpriseScore, currentPrice] = analysisResults[i];

                if (!metrics) {
                    console.log(`  - [${ticker}] 재무 정보가 없어 분석을 건너뜁니다.`);
                    continue;
                }

                // ✨ FIX: 통합된 재무 지표에서 각 점수 계산
                const marketCap = metrics.marketCapitalization || 0;
                const pe = metrics.peNormalizedAnnual;
                const pb = metrics.pbAnnual;
                let financialsScore = 0;
                if (pe && pe > 0 && pe < 30) financialsScore += (1 - pe / 30) * 5;
                if (pb && pb > 0 && pb < 3) financialsScore += (1 - pb / 3) * 5;
                
                // '베타' 점수: 1보다 낮을수록 안정적이라고 판단하여 높은 점수 부여 (최대 10점)
                const beta = metrics.beta || 1.5; // 데이터 없으면 1.5로 간주
                const betaScore = Math.max(0, (1.5 - beta) / 1.5 * 10);

                // '상승 잠재력' 점수: 52주 최고가 대비 현재가가 낮을수록 높은 점수 (최대 10점)
                const high52w = metrics['52WeekHigh'];
                const low52w = metrics['52WeekLow'];
                const potentialScore = (high52w && currentPrice) ? ((high52w - currentPrice) / (high52w - low52w || 1)) * 10 : 0;

                const sentimentScore = analyzeLocalNewsSentiment(ticker, allFoundArticles, kTickerInfo);

                // ✨ FIX: 점수 체계를 '관심도'와 '펀더멘탈'로 분리
                const hypeScore = (newsScore * 0.6) + (sentimentScore * 0.4); // 관심도 = 언급량 60% + 감성 40%
                const valueScore = (analystScore * 0.3) + (betaScore * 0.2) + (financialsScore * 0.2) + (surpriseScore * 0.15) + (potentialScore * 0.15); // 펀더멘탈 점수 재구성
                
                let compositeScore = (hypeScore * 0.3) + (valueScore * 0.7); // 최종 점수 = 관심도 30% + 펀더멘탈 70%

                // ✨ FIX: 시가총액 기준으로 스타일을 동적으로 결정하고 Redis에 저장
                let existingInfo; // ✨ FIX: existingInfo를 루프 상단에 선언하여 스코프 문제 해결
                let style = 'growth'; // 기본값
                // 시가총액이 낮을수록 보너스 점수 부여 (숨은 보석 찾기)
                if (marketCap) {
                    if (marketCap >= 100000) { // 시가총액 단위가 백만 달러이므로, 1000억 달러 = 100,000 백만 달러
                        style = 'leading';
                    } else {
                        const marketCapBonus = (1 - Math.min(marketCap, 100e9) / 100e9) * 10; // 최대 10점 보너스
                        compositeScore += marketCapBonus;
                    }
                    // Redis에 최신 정보 저장
                    // ✨ FIX: kTickerInfo에서 name을 안전하게 파싱하여 사용
                    const infoValue = kTickerInfo[ticker];
                    if (typeof infoValue === 'string') {
                        try {
                            existingInfo = JSON.parse(infoValue);
                        } catch (e) {
                            console.error(`[DEBUG] Failed to parse kTickerInfo for ${ticker}. Value:`, infoValue);
                            existingInfo = { name: ticker, keywords: [] };
                        }
                    } else {
                        console.error(`[DEBUG] kTickerInfo for ${ticker} is not a string. Value:`, infoValue);
                        existingInfo = { name: ticker, keywords: [] };
                    }
                    const stockInfo = { name: existingInfo.name || ticker, style, keywords: existingInfo.keywords || [] };
                    await redis.hset('stock-info', { [ticker]: JSON.stringify(stockInfo) });
                    // 메모리에 있는 정보도 업데이트
                    kTickerInfo[ticker] = JSON.stringify(stockInfo); // ✨ FIX: 메모리 내 kTickerInfo에도 항상 JSON 문자열을 저장하여 데이터 형식을 일관되게 유지
                }

                // ✨ FIX: 상세 페이지에서 사용할 수 있도록, 추천 근거가 된 뉴스 기사 목록을 찾습니다.
                let relevantArticlesForStock = [];
                if (existingInfo) {
                    // ✨ FIX: keywords가 비어있으면 회사 이름을 기본 키워드로 사용
                    const searchKeywords = (existingInfo.keywords && existingInfo.keywords.length > 0)
                        ? existingInfo.keywords
                        : [existingInfo.name.toLowerCase()];
                    relevantArticlesForStock = allFoundArticles.filter(a => 
                        searchKeywords.some(kw => a.title.toLowerCase().includes(kw))
                    );
                }

                console.log(`  - [${ticker}] 점수: ${compositeScore.toFixed(2)} (뉴스언급: ${newsScore}, 베타: ${betaScore.toFixed(1)}, 애널리스트: ${analystScore}, 서프라이즈: ${surpriseScore}, 재무: ${financialsScore.toFixed(1)}, 감성: ${sentimentScore.toFixed(1)}, 시총: ${marketCap ? (marketCap/1000).toFixed(1)+'B' : 'N/A'})`);
                // ✨ FIX: hypeScore와 valueScore를 scoredStocks 객체에 올바르게 추가
                scoredStocks.push({ 
                    ticker, 
                    score: compositeScore, 
                    companyName: existingInfo?.name || ticker,
                    hypeScore, // ✨ FIX: reason 객체 밖으로 이동
                    valueScore, // ✨ FIX: reason 객체 밖으로 이동
                    reason: {
                        newsScore,
                        insiderScore: betaScore, // '내부자' 항목을 '베타' 점수로 대체
                        analystScore,
                        surpriseScore,
                        financialsScore,
                        sentimentScore,
                        potentialScore, // '상승 잠재력' 점수 추가
                    },
                    relevantArticles: relevantArticlesForStock.slice(0, 10)
                });
            }

            // STEP 7: Filter and categorize stocks into 'leading' and 'growth'
            const SCORE_THRESHOLD = 8.0; // 추천 기준 점수
            const finalRecommendations = scoredStocks
                .filter(stock => stock.score > SCORE_THRESHOLD)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);
            
            if (finalRecommendations.length > 0) {
                const leading = finalRecommendations.filter(s => {
                    try {
                        return JSON.parse(kTickerInfo[s.ticker]).style === 'leading';
                    } catch {
                        return false;
                    }
                });
                const growth = finalRecommendations.filter(s => {
                     try {
                        return JSON.parse(kTickerInfo[s.ticker]).style !== 'leading';
                    } catch {
                        return true;
                    }
                });
                finalResults[themeName] = { leading, growth };
                console.log(`  - ${finalRecommendations.length}개의 추천 종목 선정 완료 (주도주: ${leading.length}, 성장주: ${growth.length}).`);
            }
        }
    } catch (error) {
        const errorMessage = `🚨 스크립트 실행 중 치명적인 오류 발생: ${error.message}`;
        console.error(errorMessage);
        await sendSlackNotification(errorMessage, 'danger');
        // 오류 발생 시 프로세스 종료
        process.exit(1);
    }

    // 4. 최종 결과를 Redis에 저장
    if (Object.keys(finalResults).length > 0) {
        const summary = Object.entries(finalResults)
            .map(([theme, res]) => `• *${theme}*: ${res.leading.length + res.growth.length}개`)
            .join('\n');
        const successMessage = `✅ 분석 완료! 총 ${Object.keys(finalResults).length}개 테마의 추천 종목을 Redis에 저장했습니다.\n\n${summary}`;
        console.log(successMessage);
        await redis.set(redisKey, JSON.stringify({ summary: marketSummary, results: finalResults, analyzedAt: new Date().toISOString() }));
        await sendSlackNotification(successMessage, 'good');
    } else {
        const warningMessage = "⚠️ 분석된 유효한 추천 종목이 없어 Redis에 데이터를 저장하지 않았습니다.";
        console.warn(warningMessage);
        await sendSlackNotification(warningMessage, 'warning');
    }
}

main().catch(console.error);
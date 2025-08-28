// 이 파일은 Vercel Cron Job에 의해 매일 자동으로 실행될 API입니다.
// 로직은 populate_index.js와 거의 동일합니다.

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const INDEX_NAME = 'gcp-starter-gemini';
const BATCH_SIZE = 100;
const kInvestmentThemes = { /* populate_index.js와 동일한 내용을 여기에 붙여넣으세요 */ };

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 메인 핸들러 ---
export default async function handler(request, response) {
  // 보안을 위해 Vercel 환경변수에 설정된 비밀 키를 확인
  const cronSecret = request.headers['authorization'];
  if (cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 로직은 populate_index.js의 main() 함수와 거의 동일
    // 여기서는 지난 하루치 데이터만 가져옵니다.
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 1); // 어제 날짜
    
    // ... populate_index.js의 뉴스 수집, 임베딩, Pinecone 저장 로직을 여기에 적용 ...
    // 단, DAYS_TO_FETCH 루프는 필요 없이 fromDate를 기준으로 하루치만 수집
    
    console.log("매일 데이터 축적을 시작합니다...");
    // (이 부분은 populate_index.js의 로직을 참고하여 완성해야 합니다.
    // 간단하게는 populate_index.js의 main 함수 내용을 여기에 맞게 수정하여 붙여넣으면 됩니다.)

    return response.status(200).json({ message: 'Daily data population completed successfully.' });

  } catch (error) {
    console.error('Cron job failed:', error);
    return response.status(500).json({ error: 'Cron job execution failed.' });
  }
}
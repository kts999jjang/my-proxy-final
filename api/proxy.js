// my-proxy-final/api/proxy.js

// 디버깅을 위해 임시로 파일 전체를 이 내용으로 교체해주세요.
module.exports = async (request, response) => {
  console.log("--- Available Environment Variables ---");
  // Vercel 서버가 가지고 있는 모든 환경 변수를 출력합니다.
  console.log(process.env);
  console.log("-------------------------------------");

  // KV 관련 변수들이 존재하는지 직접 확인
  console.log("KV_REST_API_URL:", process.env.KV_REST_API_URL);
  console.log("KV_REST_API_TOKEN:", process.env.KV_REST_API_TOKEN);

  response.status(200).json({
    message: "Debug log printed. Please check your Vercel logs.",
    has_kv_rest_api_url: !!process.env.KV_REST_API_URL,
    has_kv_rest_api_token: !!process.env.KV_REST_API_TOKEN,
  });
};
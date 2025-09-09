// /api/themes.js 또는 /api/proxy.js 에 임시로 붙여넣을 테스트 코드

// 12초(12000 밀리초)를 기다리는 함수
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async (request, response) => {
  console.log("Timeout test started. Waiting for 12 seconds...");
  
  // 12초 동안 대기
  await sleep(12000);
  
  console.log("12 seconds passed. Sending response.");

  // 12초 후 정상적인 응답 전송
  response.status(200).json({
    message: "Test successful after 12 seconds.",
  });
};
const kInvestmentThemes = {
    '인공지능(AI)': { 
        query: '("artificial intelligence" OR "AI chip" OR "large language model" OR "LLM") AND (NVIDIA OR "Advanced Micro Devices" OR "Taiwan Semiconductor")', 
    },
    '메타버스 & VR': { 
        query: '("metaverse" OR "virtual reality" OR "augmented reality" OR "XR") AND (Meta OR Apple OR Roblox OR Unity)', 
    },
    '전기차 & 자율주행': { 
        query: '("electric vehicle" OR "EV" OR "self-driving" OR "autonomous car") AND (Tesla OR Rivian OR Lucid OR "General Motors")', 
    },
    '클라우드 컴퓨팅': { 
        query: '("cloud computing" OR "data center" OR "SaaS" OR "IaaS") AND ("Amazon AWS" OR "Microsoft Azure" OR "Google Cloud")', 
    },
    '바이오/헬스케어': { 
        query: '("biotechnology" OR "pharmaceutical" OR "clinical trial" OR "FDA approval") AND (Moderna OR Pfizer OR "Johnson & Johnson")', 
    },
    '엔터테인먼트/미디어': { 
        query: '("streaming service" OR "content creation" OR "box office") AND (Disney OR Netflix OR "Warner Bros")', 
    },
    '친환경/에너지': { 
        query: '("renewable energy" OR "solar power" OR "wind turbine" OR "clean energy") AND ("NextEra Energy" OR "First Solar")', 
    },
};

module.exports = {
    kInvestmentThemes,
};
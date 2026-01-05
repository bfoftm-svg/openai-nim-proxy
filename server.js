// server.js - OpenAI to NVIDIA NIM API Proxy (FIXED & SAFE)

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ================== MIDDLEWARE ==================
app.use(cors());

// 🔧 Increase payload limit (100MB)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ================== NVIDIA CONFIG ==================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ================== FLAGS ==================
const ENABLE_THINKING_MODE = false;

// ================== MODEL MAP ==================
const MODEL_MAPPING = {
  'minimax-m2': 'minimaxai/minimax-m2',
  'glm-4.7': 'z-ai/glm4.7',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek-r1': 'deepseek-ai/deepseek-r1',
  'deepseek-r1-0528': 'deepseek-ai/deepseek-r1-0528',
  'kimi-thinking': 'moonshotai/kimi-k2-thinking',
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek-ai/deepseek-v3.1',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'deepseek-ai/deepseek-r1',
  'claude-3-sonnet': 'deepseek-ai/deepseek-v3.2',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// ================== HEALTH ==================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NVIDIA NIM Proxy',
    models: Object.keys(MODEL_MAPPING)
  });
});

// ================== MODELS ==================
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy'
  }));

  res.json({ object: 'list', data: models });
});

// ================== CHAT ==================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model];
    if (!nimModel && model) nimModel = model;
    if (!nimModel) nimModel = 'deepseek-ai/deepseek-v3.2';

    console.log(`Routing: ${model} -> ${nimModel}`);

    const isThinkingModel = 
        nimModel.includes('thinking') || 
        nimModel.includes('r1') || 
        nimModel.includes('m2') || 
        nimModel.includes('glm');

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 4096,
      stream: !!stream
    };

    if (ENABLE_THINKING_MODE || isThinkingModel) {
        nimRequest.extra_body = { 
            chat_template_kwargs: { thinking: true } 
        };
    }

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json',
        timeout: 180000 // 3 minute timeout for deep thinking models
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
      return;
    }

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: response.data.choices,
      usage: response.data.usage || {}
    });

  } catch (err) {
    // SAFE LOGGING: Avoid JSON.stringify on the whole error object
    console.error('--- Proxy Error ---');
    console.error('Model:', req.body?.model);
    console.error('Status:', err.response?.status || 'No Status');
    
    // Log data safely if it exists
    if (err.response?.data) {
        console.error('Error Details:', err.response.data);
    } else {
        console.error('Message:', err.message);
    }

    // Don't let the response crash the server if response data is circular
    const errorMsg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;

    res.status(err.response?.status || 500).json({
      error: {
        message: errorMsg,
        type: 'proxy_error',
        status: err.response?.status
      }
    });
  }
});

// ================== FALLBACK ==================
app.all('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
  

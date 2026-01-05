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
const NIM_API_BASE =
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ================== FLAGS ==================
const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

// ================== MODEL MAP ==================
const MODEL_MAPPING = {
  // --- New Models ---
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek-r1': 'deepseek-ai/deepseek-r1',
  'deepseek-r1-0528': 'deepseek-ai/deepseek-r1-0528',
  'kimi-thinking': 'moonshotai/kimi-k2-thinking',
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
'glm-4.7': 'z-ai/glm4.7',


  // --- Compatibility ---
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
    created: Date.now(),
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

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature ?? 0.9,
      max_tokens: max_tokens ?? 4096,
      extra_body:
        ENABLE_THINKING_MODE ||
        model?.includes('thinking') ||
        model?.includes('r1')
          ? { chat_template_kwargs: { thinking: true } }
          : undefined,
      stream: !!stream
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    // ---------- STREAM ----------
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.pipe(res);
      return;
    }

    // ---------- NON STREAM ----------
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: response.data.choices,
      usage: response.data.usage || {}
    });
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: 'proxy_error'
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
  console.log('Models:', Object.keys(MODEL_MAPPING).join(', '));
});

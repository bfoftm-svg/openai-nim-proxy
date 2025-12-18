// server.js - OpenAI to NVIDIA NIM API Proxy (FIXED)

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// 🔧 Increase payload limit (100MB)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 CONFIGURATION
const SHOW_REASONING = true;       // Show <think> tags in output
const ENABLE_THINKING_MODE = true; // Enable thinking for R1/Kimi

// Model mapping - Friendly Name -> NVIDIA ID
const MODEL_MAPPING = {
// --- New Models ---
'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
'deepseek-r1': 'deepseek-ai/deepseek-r1',
'deepseek-r1-0528': 'deepseek-ai/deepseek-r1-0528',
'kimi-thinking': 'moonshotai/kimi-k2-thinking',
'kimi-k2': 'moonshotai/kimi-k2-instruct',

// --- OpenAI / Claude / Gemini Compatibility ---
'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
'gpt-4': 'deepseek-ai/deepseek-v3.1',
'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
'gpt-4o': 'deepseek-ai/deepseek-v3.1',
'claude-3-opus': 'deepseek-ai/deepseek-r1',
'claude-3-sonnet': 'deepseek-ai/deepseek-v3.2',
'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// Health check
app.get('/health', (req, res) => {
res.json({
status: 'ok',
service: 'NVIDIA NIM Proxy',
models: Object.keys(MODEL_MAPPING)
});
});

// List models (OpenAI compatible)
app.get('/v1/models', (req, res) => {
const models = Object.keys(MODEL_MAPPING).map(model => ({
id: model,
object: 'model',
created: Date.now(),
owned_by: 'nvidia-nim-proxy'
}));

res.json({ object: 'list', data: models });
});

// Chat completions
app.post('/v1/chat/completions', async (req, res) => {
try {
const { model, messages, temperature, max_tokens, stream } = req.body;

// Model selection  
let nimModel = MODEL_MAPPING[model];  
if (!nimModel && (model.includes('/') || model.includes('deepseek') || model.includes('meta'))) {  
  nimModel = model;  
}  
if (!nimModel) {  
  nimModel = 'deepseek-ai/deepseek-v3.2';  
}  

console.log(`Routing: ${model} -> ${nimModel}`);  

const nimRequest = {  
  model: nimModel,  
  messages,  
  temperature: temperature || 0.6,  
  max_tokens: max_tokens || 4096,  
  extra_body:  
    ENABLE_THINKING_MODE || model.includes('thinking') || model.includes('r1')  
      ? { chat_template_kwargs: { thinking: true } }  
      : undefined,  
  stream: stream || false  
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

// Streaming  
if (stream) {  
  res.setHeader('Content-Type', 'text/event-stream');  
  res.setHeader('Cache-Control', 'no-cache');  
  res.setHeader('Connection', 'keep-alive');  

  let buffer = '';  
  let reasoningStarted = false;  
  const NL = String.fromCharCode(10);  

  response.data.on('data', chunk => {  
    buffer += chunk.toString();  
    const lines = buffer.split(NL);  
    buffer = lines.pop() || '';  

    lines.forEach(line => {  
      if (!line.startsWith('data: ')) return;  
      if (line.includes('[DONE]')) {  
        res.write(line + NL);  
        return;  
      }  

      try {  
        const data = JSON.parse(line.slice(6));  
        const delta = data.choices?.[0]?.delta;  
        if (!delta) return;  

        const reasoning = delta.reasoning_content;  
        const content = delta.content;  

        if (SHOW_REASONING) {  
          let out = '';  
          if (reasoning && !reasoningStarted) {  
            out = `<think>${NL}${reasoning}`;  
            reasoningStarted = true;  
          } else if (reasoning) {  
            out = reasoning;  
          }  

          if (content && reasoningStarted) {  
            out += `</think>${NL}${NL}${content}`;  
            reasoningStarted = false;  
          } else if (content) {  
            out += content;  
          }  

          delta.content = out;  
          delete delta.reasoning_content;  
        } else {  
          delta.content = content || '';  
          delete delta.reasoning_content;  
        }  

        res.write(`data: ${JSON.stringify(data)}${NL}${NL}`);  
      } catch {}  
    });  
  });  

  response.data.on('end', () => res.end());  
  response.data.on('error', () => res.end());  
} else {  
  // Non-streaming  
  const openaiResponse = {  
    id: `chatcmpl-${Date.now()}`,  
    object: 'chat.completion',  
    created: Math.floor(Date.now() / 1000),  
    model,  
    choices: response.data.choices.map(choice => {  
      let fullContent = choice.message?.content || '';  

      if (SHOW_REASONING && choice.message?.reasoning_content) {  
        fullContent = `<think>

${choice.message.reasoning_content}
</think>

${fullContent}`;
}

return {  
        index: choice.index,  
        message: {  
          role: choice.message.role,  
          content: fullContent  
        },  
        finish_reason: choice.finish_reason  
      };  
    }),  
    usage: response.data.usage || {}  
  };  

  res.json(openaiResponse);  
}

} catch (error) {
console.error('Proxy error:', error.message);
res.status(error.response?.status || 500).json({
error: {
message: error.message,
type: 'proxy_error'
}
});
}
});

// Fallback
app.all('*', (req, res) => {
res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
console.log(🚀 Proxy running on port ${PORT});
console.log('Models:', Object.keys(MODEL_MAPPING).join(', '));
});

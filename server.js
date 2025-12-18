// server.js - OpenAI to NVIDIA NIM API Proxy (BEST VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ================== MIDDLEWARE ==================
app.use(cors());
// 🔧 Increase payload limit (100MB) to fix 413 errors from the Node side
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ================== CONFIGURATION ==================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;       // Show <think> tags in output
const ENABLE_THINKING_MODE = true; // Enable thinking for R1/Kimi

// ================== MODEL MAPPING ==================
const MODEL_MAPPING = {
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

// ================== HEALTH CHECK ==================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NVIDIA NIM Proxy', models: Object.keys(MODEL_MAPPING) });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ================== CHAT COMPLETIONS ==================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Intelligent Model Routing
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel && model) nimModel = model;
    if (!nimModel) nimModel = 'deepseek-ai/deepseek-v3.2'; // Default fallback

    console.log(`Routing: ${model} -> ${nimModel}`);

    // Construct Request to NVIDIA
    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 4096,
      extra_body: (ENABLE_THINKING_MODE || model?.includes('thinking') || model?.includes('r1'))
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

    // ================== STREAM HANDLING (WITH REASONING FIX) ==================
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;
      const NL = '\n';

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(NL);
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          if (line.includes('[DONE]')) {
            res.write(line + NL + NL);
            return;
          }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (!delta) return;

            // --- THE MAGIC FIX: Extract hidden reasoning and put it in content ---
            const reasoning = delta.reasoning_content;
            const content = delta.content;

            if (SHOW_REASONING) {
              let out = '';
              
              // Handle start of reasoning
              if (reasoning && !reasoningStarted) {
                out = `<think>${NL}${reasoning}`;
                reasoningStarted = true;
              } 
              // Handle ongoing reasoning
              else if (reasoning) {
                out = reasoning;
              }

              // Handle switch from reasoning to content
              if (content && reasoningStarted) {
                out += `</think>${NL}${NL}${content}`;
                reasoningStarted = false;
              } 
              // Handle normal content
              else if (content) {
                out += content;
              }

              delta.content = out; // Overwrite content with the combined text
              delete delta.reasoning_content; // Clean up
            }
            // ---------------------------------------------------------------------

            res.write(`data: ${JSON.stringify(data)}${NL}${NL}`);
          } catch (e) {
            // content parsing error, skip line
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());

    } else {
      // ================== NON-STREAM HANDLING ==================
      // If you don't stream, we still need to fix the reasoning
      const choices = response.data.choices.map(choice => {
        let fullContent = choice.message?.content || '';
        if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${fullContent}`;
        }
        return {
            ...choice,
            message: { role: choice.message.role, content: fullContent }
        };
      });

      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: choices,
        usage: response.data.usage || {}
      });
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: { message: error.message, type: 'proxy_error' }
    });
  }
});

// Fallback
app.all('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log('Models:', Object.keys(MODEL_MAPPING).join(', '));
});

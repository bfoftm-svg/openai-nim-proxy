// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 CONFIGURATION
const SHOW_REASONING = true;       // Show <think> tags in output
const ENABLE_THINKING_MODE = true; // Enable thinking for R1/Kimi

// Model mapping - Friendly Name -> NVIDIA ID
const MODEL_MAPPING = {
  // --- New Models You Added ---
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek-r1': 'deepseek-ai/deepseek-r1',
  'deepseek-r1-0528': 'deepseek-ai/deepseek-r1-0528',
  'kimi-thinking': 'moonshotai/kimi-k2-thinking',
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
  
  // --- Standard Mappings ---
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek-ai/deepseek-v3.1',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  
  // --- Other High-Perf Models ---
  'claude-3-opus': 'deepseek-ai/deepseek-r1',
  'claude-3-sonnet': 'deepseek-ai/deepseek-v3.2',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NVIDIA Proxy', models: Object.keys(MODEL_MAPPING) });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// Chat completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // 1. Smart Model Selection
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel && (model.includes('/') || model.includes('deepseek') || model.includes('meta'))) {
       nimModel = model;
    }
    if (!nimModel) {
      nimModel = 'deepseek-ai/deepseek-v3.2'; // Safe fallback
    }

    console.log(`Incoming: ${model} -> Routing to: ${nimModel}`);

    // 2. Prepare Request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      extra_body: (ENABLE_THINKING_MODE || model.includes('thinking') || model.includes('r1')) 
        ? { chat_template_kwargs: { thinking: true } } 
        : undefined,
      stream: stream || false
    };
    
    // 3. Send to NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json'
    });
    
    // 4. Handle Response
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      // SAFE SPLITTER: Uses code 10 (newline) to prevent copy-paste crashes
      const NEWLINE_CHAR = String.fromCharCode(10); 
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(NEWLINE_CHAR);
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + NEWLINE_CHAR);
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>' + NEWLINE_CHAR + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>' + NEWLINE_CHAR + NEWLINE_CHAR + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  // Hide reasoning if disabled
                  if (content) data.choices[0].delta.content = content;
                  else data.choices[0].delta.content = '';
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}${NEWLINE_CHAR}${NEWLINE_CHAR}`);
            } catch (e) {
               // Ignore partial JSON parse errors
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream error:', err); res.end(); });
    } else {
      // Non-streaming response
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>
' + choice.message.reasoning_content + '
</think>

' + fullContent;
          }
          return {
            index: choice.index,
            message: { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage
      };
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: { message: error.message, type: 'error', code: 500 }
    });
  }
});

app.all('*', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log('Available models: ' + Object.keys(MODEL_MAPPING).join(', '));
});

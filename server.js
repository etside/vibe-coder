import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV = Object.fromEntries(
  readFileSync(join(__dir, '.env'), 'utf8').trim().split('\n')
    .map(l => l.split('='))
);

const CF_ACCOUNT_ID = ENV.CF_ACCOUNT_ID;
const CF_API_TOKEN = ENV.CF_API_TOKEN;
const CF_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/moonshotai/kimi-k2.6`;
const EXPORT_DIR = '/home/tjms/Music';
const PORT = ENV.PORT || 3000;

const SYSTEM_PROMPT = `You are an expert web developer. When given a description, output ONLY a single complete HTML file with:
- Embedded CSS using modern animations: CSS keyframes, scroll-driven animations, View Transitions API, GSAP-style transforms, particle effects, glassmorphism, neon glows, 3D transforms
- Embedded vanilla JS for interactivity
- No external dependencies except CDN links for animation libraries (GSAP, anime.js, three.js) when needed
- Fully self-contained, beautiful, production-quality
Output ONLY the HTML. No explanation, no markdown fences.`;

const app = express();
app.use(express.static(__dir));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', async raw => {
    const { type, prompt, filename, html } = JSON.parse(raw);

    if (type === 'export') {
      const file = join(EXPORT_DIR, filename || `site-${Date.now()}.html`);
      writeFileSync(file, html);
      ws.send(JSON.stringify({ type: 'exported', file }));
      return;
    }

    if (type === 'generate') {
      try {
        const res = await fetch(CF_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CF_API_TOKEN}`
          },
          body: JSON.stringify({
            stream: true,
            chat_template_kwargs: { thinking: false },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt }
            ]
          })
        });

        if (!res.ok) {
          const err = await res.text();
          ws.send(JSON.stringify({ type: 'error', message: err }));
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let reasoningCount = 0;
        // Read first chunk to check for quota/error response
        const first = await reader.read();
        const firstText = dec.decode(first.value, { stream: true });
        // Cloudflare returns errors as plain JSON (not SSE) even with stream:true
        if (!firstText.startsWith('data:')) {
          try {
            const errJson = JSON.parse(firstText);
            if (!errJson.success) {
              ws.send(JSON.stringify({ type: 'error', message: errJson.errors?.[0]?.message || 'API error' }));
              return;
            }
          } catch {}
        }
        buf += firstText;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') { ws.send(JSON.stringify({ type: 'done' })); continue; }
            try {
              const delta = JSON.parse(data).choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.reasoning_content) {
                reasoningCount++;
                if (reasoningCount % 20 === 0)
                  ws.send(JSON.stringify({ type: 'thinking', count: reasoningCount }));
              } else if (delta.content) {
                ws.send(JSON.stringify({ type: 'chunk', chunk: delta.content }));
              }
            } catch {}
          }
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    }
  });
});

server.listen(PORT, () => console.log(`Vibe Coder → http://localhost:${PORT}`));

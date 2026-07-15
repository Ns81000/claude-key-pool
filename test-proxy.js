// Proxy exerciser. Run with the dev server up on :9999.
//   node test-proxy.js            -> non-stream + stream smoke test
//   node test-proxy.js models     -> GET /v1/models
import http from 'node:http';

const PORT = 9999;

function request({ path, method = 'POST', body }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function nonStream() {
  console.log('\n=== non-stream /v1/messages ===');
  const r = await request({
    path: '/v1/messages',
    body: { model: 'haiku', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in 3 words.' }] },
  });
  console.log('status:', r.status);
  console.log('content-type:', r.headers['content-type']);
  console.log('content-encoding:', r.headers['content-encoding'] ?? '(none)');
  console.log('body head:', r.body.slice(0, 300));
}

async function stream() {
  console.log('\n=== stream /v1/messages ===');
  const r = await request({
    path: '/v1/messages',
    body: { model: 'haiku', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Say hello in 3 words.' }] },
  });
  console.log('status:', r.status);
  console.log('content-type:', r.headers['content-type']);
  const frames = r.body.split('\n').filter((l) => l.startsWith('event:')).slice(0, 8);
  console.log('first events:', frames.join(' | '));
  console.log('bytes:', r.body.length);
}

async function models() {
  console.log('\n=== GET /v1/models ===');
  const r = await request({ path: '/v1/models', method: 'GET' });
  console.log('status:', r.status);
  console.log('content-encoding:', r.headers['content-encoding'] ?? '(none)');
  console.log('body head:', r.body.slice(0, 300));
}

const mode = process.argv[2];
try {
  if (mode === 'models') {
    await models();
  } else {
    await nonStream();
    await stream();
  }
} catch (e) {
  console.error('request failed:', e.message);
  process.exit(1);
}

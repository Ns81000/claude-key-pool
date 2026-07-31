// Using native Node fetch

const TARGET_URL = 'https://api.lumosel.vip';
const API_KEY = 'lumo_live_7400641ea657e41778803e81fbeda5fb9a336552';

async function checkModelsEndpoint() {
  console.log(`Checking models endpoint on ${TARGET_URL}...`);

  const headersVariants = [
    { name: 'x-api-key', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } },
    { name: 'Bearer token', headers: { 'Authorization': `Bearer ${API_KEY}` } },
  ];

  const endpoints = ['/v1/models', '/models'];

  let foundModels = [];

  for (const endpoint of endpoints) {
    for (const variant of headersVariants) {
      const url = `${TARGET_URL}${endpoint}`;
      try {
        console.log(`\nFetching ${url} using ${variant.name}...`);
        const res = await fetch(url, { headers: variant.headers });
        console.log(`Response Status: ${res.status} ${res.statusText}`);
        const text = await res.text();

        try {
          const data = JSON.parse(text);
          if (res.ok) {
            console.log('Success response:');
            if (Array.isArray(data.data)) {
              const modelIds = data.data.map(m => m.id || m.name || m);
              console.log(`Found ${modelIds.length} models:`);
              console.log(modelIds);
              foundModels.push(...modelIds);
            } else {
              console.log(JSON.stringify(data, null, 2));
            }
          } else {
            console.log(`Error payload:`, data);
          }
        } catch {
          console.log(`Raw response:`, text.slice(0, 300));
        }
      } catch (err) {
        console.error(`Request failed:`, err.message);
      }
    }
  }

  return [...new Set(foundModels)];
}

async function probeSpecificModels() {
  const candidateModels = [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
    'glm-5.2',
    'gpt-5.6',
    'gpt-5.6-sol',
    'kimi-k3'
  ];

  console.log('\n========================================');
  console.log('1. Probing Anthropic endpoint (/v1/messages)...');
  console.log('========================================\n');

  for (const model of candidateModels) {
    process.stdout.write(`Testing /v1/messages [${model.padEnd(20)}]: `);
    try {
      const res = await fetch(`${TARGET_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      const bodyText = await res.text();
      let resJson = null;
      try { resJson = JSON.parse(bodyText); } catch {}

      if (res.status === 200) {
        console.log(`✅ 200 OK`);
      } else if (res.status === 404) {
        console.log(`❌ 404 Not Found (${resJson?.error?.message || resJson?.message || 'Not Found'})`);
      } else {
        console.log(`⚠️ ${res.status} (${resJson?.error?.message || resJson?.message || bodyText.slice(0, 100).replace(/\n/g, ' ')})`);
      }
    } catch (err) {
      console.log(`💥 Error: ${err.message}`);
    }
  }

  console.log('\n========================================');
  console.log('2. Probing OpenAI endpoint (/v1/chat/completions)...');
  console.log('========================================\n');

  for (const model of candidateModels) {
    process.stdout.write(`Testing /v1/chat/completions [${model.padEnd(20)}]: `);
    try {
      const res = await fetch(`${TARGET_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      const bodyText = await res.text();
      let resJson = null;
      try { resJson = JSON.parse(bodyText); } catch {}

      if (res.status === 200) {
        console.log(`✅ 200 OK`);
      } else if (res.status === 404) {
        console.log(`❌ 404 Not Found (${resJson?.error?.message || resJson?.message || 'Not Found'})`);
      } else {
        console.log(`⚠️ ${res.status} (${resJson?.error?.message || resJson?.message || bodyText.slice(0, 100).replace(/\n/g, ' ')})`);
      }
    } catch (err) {
      console.log(`💥 Error: ${err.message}`);
    }
  }
}

async function main() {
  const models = await checkModelsEndpoint();
  if (models.length === 0) {
    console.log('No models returned from GET /v1/models endpoint directly.');
  }
  await probeSpecificModels();
}

main();

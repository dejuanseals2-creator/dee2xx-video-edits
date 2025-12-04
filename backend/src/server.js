const express = require('express');
const multer = require('multer');
const { queue } = require('./queue');
const { v4: uuidv4 } = require('uuid');
const { ensureBucket } = require('./storage');
const { MAX_BULK } = require('./utils');

require('dotenv').config();
const app = express();
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads' });

async function init() {
  await ensureBucket();
}

app.post('/api/generate', upload.single('file'), async (req, res) => {
  // single job: receives { prompt, length, metadata } and optional file/url
  const { prompt, length = 15, metadata } = req.body;
  const jobId = uuidv4();
  const job = await queue.add('generate', {
    jobId, prompt, length, metadata, file: req.file ? req.file.path : null
  });
  res.json({ ok: true, jobId, queued: job.id });
});

app.post('/api/bulk', express.json(), async (req, res) => {
  // Accepts { items: [{ prompt, length, url? }... ] }
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({error:'items array required'});
  if (items.length > MAX_BULK) return res.status(400).json({error:`Max bulk ${MAX_BULK}`});
  const bulkId = uuidv4();
  const queued = [];
  for (const it of items) {
    const jobId = uuidv4();
    const job = await queue.add('generate', { jobId, prompt: it.prompt, url: it.url, length: it.length || 15, bulkId });
    queued.push({ jobId, internalId: job.id });
  }
  res.json({ ok: true, bulkId, queued });
});

app.get('/api/status/:jobId', async (req, res) => {
  const job = await queue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error:'not found' });
  const state = await job.getState();
  res.json({ id: job.id, state, data: job.data });
});

init().then(()=> {
  const port = process.env.PORT || 4000;
  app.listen(port, ()=> console.log('API listening', port));
});

const { Worker } = require('bullmq');
const { connection } = require('./queue');
const { processJob } = require('./worker_processor');
require('dotenv').config();

const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

const worker = new Worker('ai-generation', async job => {
  return await processJob(job);
}, { connection, concurrency });

worker.on('completed', job => console.log('Job completed', job.id));
worker.on('failed', (job, err) => console.error('Job failed', job.id, err));
const provider = require('./providers/replicate_provider'); // adapter example
const { uploadFileToS3 } = require('./storage');
const path = require('path');
const fs = require('fs');

async function processJob(job) {
  // job.data: { jobId, prompt, url, length, file, bulkId }
  const { jobId, prompt, url, length = 15 } = job.data;
  // 1) If URL provided, download/extract media (hook)
  // 2) Call provider to create video
  const out = await provider.generateVideo({ prompt, length, sourceUrl: url });
  // out should be { localPath or buffer, metadata }
  // 3) Upload result to S3
  const filePath = out.localPath;
  const key = `videos/${jobId}.mp4`;
  await uploadFileToS3(filePath, key);
  // 4) optionally call transcription provider for subtitles, and TTS provider for voiceover
  return { jobId, s3key: key, metadata: out.metadata || {}};
}

module.exports = { processJob };
class ProviderBase {
  async generateVideo(opts) {
    throw new Error('override');
  }
  async transcribeAudio(opts) {
    throw new Error('override');
  }
  async synthesizeSpeech(opts) {
    throw new Error('override');
  }
}
module.exports = ProviderBase;
const ProviderBase = require('./provider_base');
const axios = require('axios');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class ReplicateProvider extends ProviderBase {
  constructor() {
    super();
    this.apiKey = process.env.PROVIDER_REPLICATE_API_KEY;
  }

  async generateVideo({ prompt, length = 15, sourceUrl }) {
    // Example: call some replicate endpoint or other provider
    // This is a stub that simulates generation time and returns a dummy file path.
    const outPath = `/tmp/${uuidv4()}.mp4`;
    // In real adapter: send request to provider, poll for completion, download result to outPath.
    // For now create an empty file as placeholder
    fs.writeFileSync(outPath, ''); // placeholder
    return { localPath: outPath, metadata: { provider: 'replicate', prompt } };
  }
}

module.exports = new ReplicateProvider();
const AWS = require('aws-sdk');
const fs = require('fs');
const s3 = new AWS.S3({
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  s3ForcePathStyle: true,
  signatureVersion: 'v4'
});
const BUCKET = process.env.S3_BUCKET || 'ai-videos';

async function ensureBucket() {
  try {
    await s3.createBucket({ Bucket: BUCKET }).promise();
  } catch (e) {
    // bucket exists or error - ignore for dev
  }
}

async function uploadFileToS3(localPath, key) {
  const body = fs.createReadStream(localPath);
  await s3.putObject({ Bucket: BUCKET, Key: key, Body: body }).promise();
  return { key, url: `${process.env.S3_ENDPOINT}/${BUCKET}/${key}` };
}

module.exports = { ensureBucket, uploadFileToS3 };
const MAX_BULK = parseInt(process.env.MAX_BULK || '100', 10);
module.exports = { MAX_BULK };
{
  "name": "ai-video-studio-frontend",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "axios": "^1.4.0",
    "react-scripts": "5.0.1"
  },
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build"
  }
}
import React, { useState } from 'react';
import axios from 'axios';

export default function App(){
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState([]);
  const [bulkSize, setBulkSize] = useState(1);

  async function submitSingle(){
    const resp = await axios.post('/api/generate', { prompt, length: 15 });
    alert(JSON.stringify(resp.data));
  }

  async function submitBulk(){
    if (items.length === 0) return alert('add items');
    if (items.length > 100) return alert('max 100 per bulk');
    const resp = await axios.post('/api/bulk', { items });
    alert(JSON.stringify(resp.data));
  }

  function addItem(){
    setItems(prev => [...prev, { prompt }]);
    setPrompt('');
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>AI Video Studio — demo UI</h2>
      <div>
        <textarea value={prompt} onChange={e=>setPrompt(e.target.value)} rows={4} cols={60} placeholder="Write video prompt or paste URL..." />
      </div>
      <div style={{ marginTop:10 }}>
        <button onClick={submitSingle}>Generate single</button>
        <button onClick={addItem}>Add to bulk</button>
        <button onClick={submitBulk}>Submit bulk ({items.length})</button>
      </div>
      <div style={{ marginTop:20 }}>
        <h4>Bulk items</h4>
        <ol>
          {items.map((it,i)=> <li key={i}>{it.prompt}</li>)}
        </ol>
      </div>
    </div>
  );
}
const axios = require('axios');
async function run(){
  const items = [];
  for (let i=0;i<5;i++){
    items.push({ prompt: `Short clip about a cat doing a silly trick #${i}`, length: 12 });
  }
  const resp = await axios.post('http://localhost:4000/api/bulk', { items });
  console.log(resp.data);
}
run();

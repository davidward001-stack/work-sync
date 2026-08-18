import express, { Request, Response, NextFunction } from 'express';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'crypto';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { Task, TaskCreateRequest, TaskUpdateRequest } from './types';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Config
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WORK_SYNC_API_KEY || 'dev-key-change-me';
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://d33a8b9d05525f4bc756d1f0c552c761.r2.cloudflarestorage.com';
const R2_BUCKET = process.env.R2_BUCKET || 'work-sync';
const R2_KEY_ID = process.env.R2_KEY_ID || '';
const R2_SECRET = process.env.R2_SECRET || '';

// In-memory store
let tasks: Map<string, Task> = new Map();
let lastSyncTime = 0;

// R2 client
const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_KEY_ID,
    secretAccessKey: R2_SECRET,
  },
});

// Auth middleware
const authenticateApiKey = (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers['x-api-key'] as string;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Load tasks from R2
async function loadTasksFromR2() {
  try {
    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'tasks.jsonl',
    });
    const response = await s3.send(cmd);
    const body = await response.Body?.transformToString();

    if (body) {
      const lines = body.trim().split('\n');
      tasks.clear();
      lines.forEach(line => {
        if (line) {
          const task = JSON.parse(line) as Task;
          tasks.set(task.id, task);
        }
      });
    }
    lastSyncTime = Date.now();
  } catch (error: any) {
    // File might not exist on first run
    if (error.Code !== 'NoSuchKey') {
      console.error('Error loading tasks from R2:', error);
    }
  }
}

// Save tasks to R2
async function saveTasksToR2() {
  try {
    const lines = Array.from(tasks.values())
      .map(task => JSON.stringify(task))
      .join('\n');

    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'tasks.jsonl',
      Body: lines,
      ContentType: 'application/x-ndjson',
    });
    await s3.send(cmd);
  } catch (error) {
    console.error('Error saving tasks to R2:', error);
  }
}

// Simple UUID generator (crypto.randomUUID is available in Node 15.7+)
function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// Routes

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', tasks: tasks.size });
});

// Get all pending tasks (desktop reads)
app.get('/api/tasks', authenticateApiKey, (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  let result = Array.from(tasks.values());

  if (status) {
    result = result.filter(t => t.status === status);
  }

  res.json(result);
});

// Get a single task
app.get('/api/tasks/:id', authenticateApiKey, (req: Request, res: Response) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// Create a new task (phone posts)
app.post('/api/tasks', authenticateApiKey, async (req: Request, res: Response) => {
  const { content } = req.body as TaskCreateRequest;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  const task: Task = {
    id: generateId(),
    created: new Date().toISOString(),
    content: content.trim(),
    status: 'pending',
  };

  tasks.set(task.id, task);
  await saveTasksToR2();

  res.status(201).json(task);
});

// Update a task (mark done, add result)
app.patch('/api/tasks/:id', authenticateApiKey, async (req: Request, res: Response) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const update = req.body as TaskUpdateRequest;

  if (update.status) {
    task.status = update.status;
  }
  if (update.result !== undefined) {
    task.result = update.result;
  }
  if (update.status === 'done' && !task.completed) {
    task.completed = new Date().toISOString();
  }

  tasks.set(task.id, task);
  await saveTasksToR2();

  res.json(task);
});

// Delete a task
app.delete('/api/tasks/:id', authenticateApiKey, async (req: Request, res: Response) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  tasks.delete(req.params.id);
  await saveTasksToR2();

  res.json({ deleted: true });
});

// Startup
async function start() {
  await loadTasksFromR2();

  app.listen(PORT, () => {
    console.log(`Work-sync running on port ${PORT}`);
    console.log(`Loaded ${tasks.size} tasks from R2`);
  });
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

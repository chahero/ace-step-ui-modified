import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { config } from '../config/index.js';
import multer from 'multer';
import path from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

const router = Router();

// --- Audio upload via multer disk storage ---
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.opus'];

const audioStorage = multer.diskStorage({
  destination: async (_req: Request, _file, cb) => {
    const datasetName = (_req.body?.datasetName as string) || 'default';
    const dest = path.join(config.datasets.uploadsDir, datasetName);
    try {
      await mkdir(dest, { recursive: true });
      cb(null, dest);
    } catch (err) {
      cb(err as Error, dest);
    }
  },
  filename: (_req, file, cb) => {
    // Preserve original filename but ensure uniqueness
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext);
    const safeName = base.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    cb(null, `${safeName}${ext}`);
  },
});

const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${AUDIO_EXTENSIONS.join(', ')}`));
    }
  },
});

// Get audio duration via ffprobe
function getAudioDuration(filePath: string): number {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : Math.round(duration);
  } catch {
    return 0;
  }
}

// Resolve ACE-Step base directory
function getAceStepDir(): string {
  const envPath = process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.resolve(config.datasets.dir, '..');
}

function resolveTrainingModelName(checkpoint?: unknown, configPath?: unknown): string {
  if (typeof configPath === 'string' && configPath.trim()) return configPath.trim();
  if (typeof checkpoint === 'string' && checkpoint.trim()) return checkpoint.trim();
  return '';
}

type AnyRecord = Record<string, any>;

async function aceStepRequest(pathname: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<AnyRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  try {
    const response = await fetch(`${config.acestep.apiUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.detail || data.error || data.message || `ACE-Step API returned ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function getStatus(data: AnyRecord, fallback: string): string {
  return data.status || data.message || data.detail || data.status_message || fallback;
}

function getSamples(data: AnyRecord): AnyRecord[] {
  const candidates = [
    data.samples,
    data.data?.samples,
    data.dataset?.samples,
    data.result?.samples,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function normalizeSample(sample: AnyRecord | null | undefined, index = 0) {
  const audio = sample?.audio ?? sample?.audio_path ?? sample?.audioPath ?? sample?.path ?? sample?.file_path ?? null;
  const filename = sample?.filename
    || (typeof audio === 'string' ? path.basename(audio) : '')
    || `sample_${index + 1}`;

  return {
    index,
    audio,
    filename,
    caption: sample?.caption ?? '',
    genre: sample?.genre ?? '',
    promptOverride: sample?.promptOverride ?? sample?.prompt_override ?? 'Use Global Ratio',
    lyrics: sample?.lyrics ?? '[Instrumental]',
    bpm: sample?.bpm ?? null,
    key: sample?.key ?? sample?.keyscale ?? sample?.key_scale ?? '',
    timeSignature: sample?.timeSignature ?? sample?.timesignature ?? sample?.time_signature ?? '',
    duration: sample?.duration ?? 0,
    language: sample?.language ?? 'instrumental',
    instrumental: sample?.instrumental ?? sample?.is_instrumental ?? true,
    rawLyrics: sample?.rawLyrics ?? sample?.raw_lyrics ?? '',
  };
}

function samplesToDataframe(samples: AnyRecord[]) {
  const headers = ['#', 'Filename', 'Duration', 'Lyrics', 'Labeled', 'BPM', 'Key', 'Caption'];
  return {
    headers,
    data: samples.map((sample, i) => {
      const normalized = normalizeSample(sample, i);
      return [
        i + 1,
        normalized.filename,
        normalized.duration ? `${normalized.duration}s` : '',
        normalized.lyrics,
        sample.labeled || sample.is_labeled ? '✅' : '❌',
        normalized.bpm ?? '',
        normalized.key,
        normalized.caption,
      ];
    }),
  };
}

function getDatasetSettings(data: AnyRecord, fallbackName = 'my_lora_dataset') {
  const source = data.settings || data.metadata || data.dataset?.metadata || data;
  return {
    datasetName: source.datasetName ?? source.dataset_name ?? source.name ?? fallbackName,
    customTag: source.customTag ?? source.custom_tag ?? '',
    tagPosition: source.tagPosition ?? source.tag_position ?? 'replace',
    allInstrumental: source.allInstrumental ?? source.all_instrumental ?? true,
    genreRatio: source.genreRatio ?? source.genre_ratio ?? 0,
  };
}

function normalizeDatasetResponse(data: AnyRecord, fallbackStatus: string, fallbackDatasetName?: string) {
  const samples = getSamples(data);
  const sampleCount = data.sampleCount ?? data.sample_count ?? data.count ?? samples.length;
  const sample = data.sample ? normalizeSample(data.sample, data.sample.index ?? 0) : (samples[0] ? normalizeSample(samples[0], 0) : normalizeSample(undefined, 0));
  return {
    status: getStatus(data, fallbackStatus),
    dataframe: data.dataframe ?? data.table ?? samplesToDataframe(samples),
    sampleCount,
    sample,
    settings: getDatasetSettings(data, fallbackDatasetName),
    datasetPath: data.datasetPath ?? data.dataset_path ?? data.path ?? data.save_path,
  };
}

function getTrainingStatusText(data: AnyRecord, fallback: string): string {
  const pieces = [
    data.status,
    data.state,
    data.progress,
    data.message,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join('\n') : fallback;
}

// ================== NEW ROUTES ==================

// POST /api/training/upload-audio — Upload audio files for a dataset
router.post('/upload-audio', authMiddleware, audioUpload.array('audio', 50), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No audio files uploaded' });
      return;
    }

    const datasetName = (req.body?.datasetName as string) || 'default';
    const uploadDir = path.join(config.datasets.uploadsDir, datasetName);

    res.json({
      files: files.map(f => ({
        filename: f.filename,
        originalName: f.originalname,
        size: f.size,
        path: f.path,
      })),
      uploadDir,
      count: files.length,
    });
  } catch (error) {
    console.error('[Training] Upload audio error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
  }
});

// POST /api/training/build-dataset — Scan audio directory + create dataset JSON
router.post('/build-dataset', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      datasetName = 'my_lora_dataset',
      customTag = '',
      tagPosition = 'prepend',
      allInstrumental = true,
    } = req.body;

    const audioDir = path.join(config.datasets.uploadsDir, datasetName);
    if (!existsSync(audioDir)) {
      res.status(400).json({ error: `Audio directory not found: uploads/${datasetName}` });
      return;
    }

    // Scan for audio files
    const entries = readdirSync(audioDir);
    const audioFiles = entries.filter(f => AUDIO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    if (audioFiles.length === 0) {
      res.status(400).json({ error: 'No audio files found in directory' });
      return;
    }

    // Build samples in the ACE-Step dataset format
    const samples = audioFiles.map(filename => {
      const audioPath = path.join(audioDir, filename);
      const duration = getAudioDuration(audioPath);
      const baseName = path.basename(filename, path.extname(filename));

      // Check for companion .txt lyrics file
      let rawLyrics = '';
      const lyricsPath = path.join(audioDir, `${baseName}.txt`);
      if (existsSync(lyricsPath)) {
        try {
          rawLyrics = readFileSync(lyricsPath, 'utf-8').trim();
        } catch { /* ignore */ }
      }

      const isInstrumental = allInstrumental || !rawLyrics;

      return {
        id: randomUUID().slice(0, 8),
        audio_path: audioPath,
        filename,
        caption: '',
        genre: '',
        lyrics: isInstrumental ? '[Instrumental]' : rawLyrics,
        raw_lyrics: rawLyrics,
        formatted_lyrics: '',
        bpm: null as number | null,
        keyscale: '',
        timesignature: '',
        duration,
        language: isInstrumental ? 'instrumental' : 'unknown',
        is_instrumental: isInstrumental,
        custom_tag: customTag,
        labeled: false,
        prompt_override: null as string | null,
      };
    });

    // Build dataset JSON
    const dataset = {
      metadata: {
        name: datasetName,
        custom_tag: customTag,
        tag_position: tagPosition,
        created_at: new Date().toISOString(),
        num_samples: samples.length,
        all_instrumental: allInstrumental,
        genre_ratio: 0,
      },
      samples,
    };

    // Save JSON to datasets dir
    await mkdir(config.datasets.dir, { recursive: true });
    const jsonPath = path.join(config.datasets.dir, `${datasetName}.json`);
    await writeFile(jsonPath, JSON.stringify(dataset, null, 2), 'utf-8');

    res.json({
      status: `Dataset saved (${samples.length} samples).`,
      dataframe: samplesToDataframe(samples),
      sampleCount: samples.length,
      sample: samples.length > 0 ? normalizeSample(samples[0], 0) : normalizeSample(undefined, 0),
      settings: {
        datasetName,
        customTag,
        tagPosition,
        allInstrumental,
        genreRatio: 0,
      },
      datasetPath: jsonPath,
    });
  } catch (error) {
    console.error('[Training] Build dataset error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build dataset' });
  }
});

// GET /api/training/audio — Proxy audio files from datasets directory
router.get('/audio', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let filePath: string;
    const aceStepDir = getAceStepDir();

    if (req.query.path) {
      filePath = req.query.path as string;
    } else if (req.query.file) {
      // Relative path within datasets dir
      filePath = path.join(config.datasets.dir, req.query.file as string);
    } else {
      res.status(400).json({ error: 'path or file parameter required' });
      return;
    }

    // Path traversal protection
    const resolved = path.resolve(filePath);
    if (resolved.includes('..') || !resolved.startsWith(aceStepDir)) {
      res.status(403).json({ error: 'Access denied: path outside ACE-Step directory' });
      return;
    }

    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'Audio file not found' });
      return;
    }

    // Determine content type
    const ext = path.extname(resolved).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/opus',
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.sendFile(resolved);
  } catch (error) {
    console.error('[Training] Audio proxy error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to serve audio' });
  }
});

// POST /api/training/preprocess — Preprocess dataset through ACE-Step API.
router.post('/preprocess', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { datasetPath, outputDir, skipExisting = false } = req.body;
    if (!datasetPath) {
      res.status(400).json({ error: 'datasetPath is required' });
      return;
    }

    await aceStepRequest('/v1/dataset/load', {
      method: 'POST',
      body: { dataset_path: datasetPath },
    });

    const data = await aceStepRequest('/v1/dataset/preprocess', {
      method: 'POST',
      body: {
        output_dir: outputDir || './datasets/preprocessed_tensors',
        skip_existing: skipExisting,
      },
      timeoutMs: 1_800_000,
    });

    res.json({
      status: data.status || 'Preprocessing complete',
      message: data.message || data.status || 'Preprocessing complete',
      output_files: data.output_files ?? data.outputFiles,
      output_dir: data.output_dir ?? outputDir,
    });
  } catch (error) {
    console.error('[Training] Preprocess error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Preprocessing failed' });
  }
});

// POST /api/training/scan-directory — Scan a directory for audio files through ACE-Step API.
router.post('/scan-directory', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      audioDir,
      datasetName = 'my_lora_dataset',
      customTag = '',
      tagPosition = 'prepend',
      allInstrumental = true,
    } = req.body;

    if (!audioDir || typeof audioDir !== 'string') {
      res.status(400).json({ error: 'audioDir is required' });
      return;
    }

    const data = await aceStepRequest('/v1/dataset/scan', {
      method: 'POST',
      body: {
        audio_dir: audioDir,
        dataset_name: datasetName,
        custom_tag: customTag,
        tag_position: tagPosition,
        all_instrumental: allInstrumental,
      },
    });
    const normalized = normalizeDatasetResponse(data, 'Dataset scanned', datasetName);
    res.json({
      ...normalized,
      audioDir: data.audio_dir ?? data.audioDir ?? audioDir,
    });
  } catch (error) {
    console.error('[Training] Scan directory error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to scan directory' });
  }
});

// POST /api/training/auto-label — Auto-label dataset samples via ACE-Step API.
router.post('/auto-label', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      skipMetas = false,
      formatLyrics = false,
      transcribeLyrics = false,
      onlyUnlabeled = false,
      lmModelPath,
      savePath,
    } = req.body;

    const data = await aceStepRequest('/v1/dataset/auto_label', {
      method: 'POST',
      body: {
        skip_metas: skipMetas,
        format_lyrics: formatLyrics,
        transcribe_lyrics: transcribeLyrics,
        only_unlabeled: onlyUnlabeled,
        lm_model_path: lmModelPath || undefined,
        save_path: savePath || undefined,
      },
      timeoutMs: 1_800_000,
    });

    res.json({
      dataframe: data.dataframe ?? data.table ?? samplesToDataframe(getSamples(data)),
      status: getStatus(data, 'Auto-label complete'),
    });
  } catch (error) {
    console.error('[Training] Auto-label error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Auto-label failed' });
  }
});

// POST /api/training/init-model — Initialize or change model for training.
router.post('/init-model', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      checkpoint,
      configPath,
      device = 'auto',
      initLlm = false,
      lmModelPath = '',
      backend = 'pt',
      useFlashAttention = false,
      offloadToCpu = false,
      offloadDitToCpu = false,
      compileModel = false,
      quantization = false,
    } = req.body;

    const model = resolveTrainingModelName(checkpoint, configPath);
    if (!model) {
      res.status(400).json({ error: 'checkpoint or configPath is required' });
      return;
    }

    const data = await aceStepRequest('/v1/init', {
      method: 'POST',
      body: {
        model,
        init_llm: !!initLlm,
        lm_model_path: lmModelPath || undefined,
      },
      timeoutMs: 300_000,
    });

    res.json({
      status: data.status || data.message || `Initialized ${model} via ACE-Step API`,
      modelReady: true,
      mode: 'api',
      model,
    });
  } catch (error) {
    console.error('[Training] Init model error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Model init failed' });
  }
});

// GET /api/training/checkpoints — List available model checkpoints
router.get('/checkpoints', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const aceStepDir = getAceStepDir();
    const checkpointDir = path.join(aceStepDir, 'checkpoints');
    if (!existsSync(checkpointDir)) {
      res.json({ checkpoints: [], configs: [] });
      return;
    }

    // List checkpoint directories
    const entries = readdirSync(checkpointDir);
    const checkpoints = entries.filter(e => {
      const fullPath = path.join(checkpointDir, e);
      return statSync(fullPath).isDirectory();
    });

    // List config directories (acestep-v15-*)
    const configDirs = entries.filter(e =>
      e.startsWith('acestep-v15') && statSync(path.join(checkpointDir, e)).isDirectory()
    );

    res.json({ checkpoints, configs: configDirs });
  } catch (error) {
    console.error('[Training] List checkpoints error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list checkpoints' });
  }
});

// GET /api/training/lora-checkpoints — List LoRA training checkpoints in output dir
router.get('/lora-checkpoints', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const outputDir = (req.query.dir as string) || './lora_output';
    const aceStepDir = getAceStepDir();
    const resolvedDir = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(aceStepDir, outputDir);

    if (!existsSync(resolvedDir)) {
      res.json({ checkpoints: [] });
      return;
    }

    const entries = readdirSync(resolvedDir);
    const checkpointsDir = path.join(resolvedDir, 'checkpoints');
    const checkpoints: string[] = [];

    if (existsSync(checkpointsDir)) {
      const cpEntries = readdirSync(checkpointsDir);
      cpEntries.forEach(e => {
        if (statSync(path.join(checkpointsDir, e)).isDirectory()) {
          checkpoints.push(path.join(checkpointsDir, e));
        }
      });
    }

    // Also check for "final" directory
    const finalDir = path.join(resolvedDir, 'final');
    if (existsSync(finalDir)) {
      checkpoints.push(finalDir);
    }

    res.json({ checkpoints, outputDir: resolvedDir });
  } catch (error) {
    console.error('[Training] List LoRA checkpoints error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list checkpoints' });
  }
});

// ================== EXISTING ROUTES ==================

// POST /api/training/load-dataset — Load an existing dataset JSON for preprocessing
router.post('/load-dataset', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { datasetPath } = req.body;
    if (!datasetPath || typeof datasetPath !== 'string') {
      res.status(400).json({ error: 'datasetPath is required' });
      return;
    }
    // Reject path traversal
    if (datasetPath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const data = await aceStepRequest('/v1/dataset/load', {
      method: 'POST',
      body: { dataset_path: datasetPath },
    });

    res.json(normalizeDatasetResponse(data, 'Dataset loaded'));
  } catch (error) {
    console.error('[Training] Load dataset error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load dataset' });
  }
});

// GET /api/training/sample-preview — Get preview data for a specific sample
router.get('/sample-preview', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const idx = parseInt(req.query.idx as string) || 0;

    const data = await aceStepRequest(`/v1/dataset/sample/${idx}`);
    res.json(normalizeSample(data.sample ?? data.data ?? data, idx));
  } catch (error) {
    console.error('[Training] Sample preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get sample preview' });
  }
});

// POST /api/training/save-sample — Save edits to a dataset sample
router.post('/save-sample', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sampleIdx, caption, genre, promptOverride, lyrics, bpm, key, timeSignature, language, instrumental } = req.body;

    const idx = sampleIdx ?? 0;
    const data = await aceStepRequest(`/v1/dataset/sample/${idx}`, {
      method: 'PUT',
      body: {
        sample_idx: idx,
        caption: caption ?? '',
        genre: genre ?? '',
        prompt_override: promptOverride === 'Use Global Ratio' ? null : promptOverride ?? null,
        lyrics: lyrics ?? '',
        bpm: bpm || null,
        keyscale: key ?? '',
        timesignature: timeSignature ?? '',
        language: language ?? 'instrumental',
        is_instrumental: instrumental ?? true,
      },
    });

    res.json({
      dataframe: data.dataframe ?? data.table ?? samplesToDataframe(getSamples(data)),
      status: getStatus(data, 'Sample saved'),
    });
  } catch (error) {
    console.error('[Training] Save sample error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save sample edit' });
  }
});

// POST /api/training/update-settings — Update dataset global settings
// Settings are applied directly when saving through the ACE-Step API.
router.post('/update-settings', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true });
});

// POST /api/training/save-dataset — Save the dataset to a JSON file
router.post('/save-dataset', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { savePath, datasetName, customTag, tagPosition, allInstrumental, genreRatio } = req.body;

    const resolvedPath = (savePath ?? `./datasets/${datasetName ?? 'my_lora_dataset'}.json`).trim();

    const body: Record<string, unknown> = {
      save_path: resolvedPath,
      dataset_name: datasetName ?? 'my_lora_dataset',
    };
    if (customTag !== undefined) body.custom_tag = customTag;
    if (tagPosition !== undefined) body.tag_position = tagPosition;
    if (allInstrumental !== undefined) body.all_instrumental = allInstrumental;
    if (genreRatio !== undefined) body.genre_ratio = genreRatio;

    const data = await aceStepRequest('/v1/dataset/save', {
      method: 'POST',
      body,
      timeoutMs: 30_000,
    });
    res.json({
      status: data.status ?? 'Saved',
      path: data.save_path ?? resolvedPath,
    });
  } catch (error) {
    console.error('[Training] Save dataset error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save dataset' });
  }
});

// POST /api/training/load-tensors — Load preprocessed tensors for training
router.post('/load-tensors', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tensorDir } = req.body;

    const data = await aceStepRequest('/v1/training/load_tensor_info', {
      method: 'POST',
      body: {
        tensor_dir: tensorDir ?? './datasets/preprocessed_tensors',
      },
    });

    res.json({ status: getTrainingStatusText(data, 'Training tensor info loaded') });
  } catch (error) {
    console.error('[Training] Load tensors error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load training dataset' });
  }
});

// POST /api/training/start — Start LoRA training
router.post('/start', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      tensorDir, rank, alpha, dropout, learningRate,
      epochs, batchSize, gradientAccumulation, saveEvery,
      shift, seed, outputDir,
    } = req.body;

    const data = await aceStepRequest('/v1/training/start', {
      method: 'POST',
      body: {
        tensor_dir: tensorDir ?? './datasets/preprocessed_tensors',
        lora_rank: rank ?? 64,
        lora_alpha: alpha ?? 128,
        lora_dropout: dropout ?? 0.1,
        learning_rate: learningRate ?? 0.0003,
        train_epochs: epochs ?? 1000,
        train_batch_size: batchSize ?? 1,
        gradient_accumulation: gradientAccumulation ?? 1,
        save_every_n_epochs: saveEvery ?? 200,
        training_shift: shift ?? 3.0,
        training_seed: seed ?? 42,
        lora_output_dir: outputDir ?? './lora_output',
      },
      timeoutMs: 30_000,
    });

    res.json({
      progress: getTrainingStatusText(data, 'Training started'),
      log: data.log || data.training_log || data.message || '',
      metrics: data.metrics || data.lineplot || data.loss_history || null,
    });
  } catch (error) {
    console.error('[Training] Start training error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start training' });
  }
});

// POST /api/training/stop — Stop current training
router.post('/stop', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await aceStepRequest('/v1/training/stop', { method: 'POST' });

    res.json({ status: getStatus(data, 'Training stopped') });
  } catch (error) {
    console.error('[Training] Stop training error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to stop training' });
  }
});

// POST /api/training/export — Export trained LoRA weights
router.post('/export', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { exportPath, loraOutputDir } = req.body;

    const data = await aceStepRequest('/v1/training/export', {
      method: 'POST',
      body: {
        export_path: exportPath ?? './lora_output/final_lora',
        lora_output_dir: loraOutputDir ?? './lora_output',
      },
      timeoutMs: 300_000,
    });

    res.json({ status: getStatus(data, 'LoRA exported') });
  } catch (error) {
    console.error('[Training] Export LoRA error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to export LoRA' });
  }
});

// POST /api/training/import-dataset — Import train/test split
router.post('/import-dataset', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { datasetType } = req.body;
    res.status(501).json({
      error: 'Import dataset is not available in ACE-Step API mode.',
      status: `Import dataset (${datasetType ?? 'train'}) is not supported by the current REST API.`,
    });
  } catch (error) {
    console.error('[Training] Import dataset error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to import dataset' });
  }
});

export default router;

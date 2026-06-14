import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const frontendPort = process.env.FRONTEND_PORT || '3000';
const aceStepPath = process.env.ACESTEP_PATH
  ? (path.isAbsolute(process.env.ACESTEP_PATH) ? process.env.ACESTEP_PATH : path.resolve(__dirname, '../../..', process.env.ACESTEP_PATH))
  : path.resolve(__dirname, '../../../ACE-Step-1.5');

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendPort: parseInt(frontendPort, 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // SQLite database
  database: {
    path: process.env.DATABASE_PATH || path.join(__dirname, '../../data/acestep.db'),
  },

  // ACE-Step API (local)
  acestep: {
    apiUrl: process.env.ACESTEP_API_URL || 'http://localhost:8001',
  },

  // Pexels (optional - for video backgrounds)
  pexels: {
    apiKey: process.env.PEXELS_API_KEY || '',
  },

  // Frontend origin used for CORS, embeds, and redirects.
  frontendUrl: `http://localhost:${frontendPort}`,

  // Storage (local only)
  storage: {
    provider: 'local' as const,
    audioDir: process.env.AUDIO_DIR || path.join(__dirname, '../../public/audio'),
  },

  // Training datasets (inside ACE-Step-1.5 so the ACE-Step API can access them)
  datasets: {
    dir: process.env.DATASETS_DIR || path.join(aceStepPath, 'datasets'),
    uploadsDir: process.env.DATASETS_UPLOADS_DIR || path.join(aceStepPath, 'datasets/uploads'),
  },

  // Simplified JWT (for local session, not critical security)
  jwt: {
    secret: process.env.JWT_SECRET || 'ace-step-ui-local-secret',
    expiresIn: '365d', // Long-lived for local app
  },
};

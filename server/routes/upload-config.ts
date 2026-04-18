import { Hono } from 'hono';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const app = new Hono();

app.get('/api/upload-config', rateLimitGeneral, (c) => {
  return c.json({
    twoModeEnabled: true,
    inlineEnabled: true,
    fileReferenceEnabled: true,
    modeChooserEnabled: true,
    inlineAttachmentMaxMb: 4,
    inlineImageContextMaxBytes: 32_768,
    inlineImageAutoDowngradeToFileReference: true,
    inlineImageShrinkMinDimension: 512,
    inlineImageMaxDimension: 2048,
    inlineImageWebpQuality: 82,
    exposeInlineBase64ToAgent: false,
  });
});

export default app;

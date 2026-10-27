import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import { DEFAULT_IMAGE_WORKER_LIMITS } from '../src/modules/image/policy.js';

/** No object writes or deletion. Metadata repair is explicit and uses a compare-and-set. */
export async function imageDeliveryCommand(args: string[]) {
 const [mode, report] = args;
 if (!['audit', 'repair-dimensions'].includes(mode ?? '') || !report || args.length !== 2) {
  throw new Error('Usage: image-delivery (audit|repair-dimensions) NEW_REPORT.jsonl');
 }
 const config = loadEnv();
 const client = createPrismaClientForDatabase(config.DATABASE_URL);
 const s3 = createS3Client(config);
 const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
 const output = await open(report, 'wx', 0o600);
 let failures = 0;
 try {
  const originals = await client.assetRepresentation.findMany({ where: {
   role: 'ORIGINAL', state: 'READY', bucket: config.S3_BUCKET_PUBLIC,
   asset: { status: 'READY', kind: { in: ['IMAGE', 'POSTER'] } },
  }, orderBy: { id: 'asc' } });
  const retained = await client.votePoster.findMany({ orderBy: { id: 'asc' } });
  for (const item of [...originals, ...retained]) {
   let status = 'OK';
   try {
    const metadata = await storage.head(item.bucket, item.objectKey);
    if (!metadata) status = 'MISSING';
    else if (metadata.size > DEFAULT_IMAGE_WORKER_LIMITS.maxOutputBytes || !metadata.contentType.startsWith('image/')) status = 'UNSUPPORTED_SOURCE';
    else if ('width' in item && (!item.width || !item.height)) {
     status = 'MISSING_DIMENSIONS';
     if (mode === 'repair-dimensions') {
      const source = await storage.stream(item.bucket, item.objectKey);
      if (!source || !('body' in source)) throw new Error('Source unavailable');
      const chunks: Buffer[] = [];
      let size = 0;
      try {
       for await (const chunk of source.body) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > DEFAULT_IMAGE_WORKER_LIMITS.maxOutputBytes) throw new Error('Source too large');
        chunks.push(bytes);
       }
      } finally { source.body.destroy(); }
      const decoded = await sharp(Buffer.concat(chunks), { limitInputPixels: DEFAULT_IMAGE_WORKER_LIMITS.maxPixels }).metadata();
      if (!decoded.width || !decoded.height || (decoded.pages ?? 1) !== 1) throw new Error('Invalid image');
      const swap = decoded.orientation !== undefined && decoded.orientation >= 5 && decoded.orientation <= 8;
      const width = swap ? decoded.height : decoded.width;
      const height = swap ? decoded.width : decoded.height;
      const result = await client.assetRepresentation.updateMany({ where: {
       id: item.id, bucket: item.bucket, objectKey: item.objectKey, state: 'READY', width: item.width, height: item.height,
      }, data: { width, height } });
      status = result.count === 1 ? 'REPAIRED' : 'SOURCE_CHANGED';
     }
    }
   } catch { status = 'READ_FAILED'; }
   if (status !== 'OK' && status !== 'REPAIRED') failures++;
   await output.write(JSON.stringify({ id: item.id, kind: 'width' in item ? 'original' : 'retained-vote', bucket: item.bucket, objectKey: item.objectKey, status }) + '\n');
  }
 } finally { await output.close(); await client.$disconnect(); s3.destroy(); }
 if (failures) throw new Error(`Image audit found ${failures} unresolved sources; inspect the private report`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 imageDeliveryCommand(process.argv.slice(2)).catch(() => { console.error('Image delivery audit/repair failed; inspect report and configuration'); process.exitCode = 1; });
}

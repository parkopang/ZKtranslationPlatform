import crypto from 'node:crypto';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let client: S3Client | null | undefined;

function storageConfig(): { client: S3Client; bucket: string } | null {
  const region = process.env.S3_REGION?.trim() || process.env.COS_REGION?.trim() || 'us-east-1';
  // Tencent COS exposes an S3-compatible regional endpoint. Keep S3_* names for
  // backwards compatibility while accepting the deployment-facing COS_* names.
  const endpoint = process.env.S3_ENDPOINT?.trim() || process.env.COS_ENDPOINT?.trim() ||
    (region.startsWith('ap-') ? `https://cos.${region}.myqcloud.com` : '');
  const bucket = process.env.S3_BUCKET?.trim() || process.env.COS_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY?.trim() || process.env.COS_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.S3_SECRET_KEY?.trim() || process.env.COS_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (client === undefined) {
    const pathStyle = process.env.S3_FORCE_PATH_STYLE?.trim();
    const forcePathStyle = pathStyle ? pathStyle !== 'false' : !Boolean(process.env.COS_ENDPOINT || process.env.COS_BUCKET);
    const config: S3ClientConfig = {
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    };
    client = new S3Client(config);
  }
  return client ? { client, bucket } : null;
}

function safeFileName(originalName: string): string {
  const name = path.basename(originalName || 'source.bin').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return name.slice(0, 120) || 'source.bin';
}

export function storageConfigured(): boolean {
  return Boolean(storageConfig());
}

export async function storeSourceFile(articleId: string, file: { originalname: string; mimetype: string; buffer: Buffer }): Promise<{ key: string; sha256: string; size: number } | null> {
  const configured = storageConfig();
  if (!configured) return null;
  const key = `articles/${articleId}/${crypto.randomUUID()}-${safeFileName(file.originalname)}`;
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  await configured.client.send(new PutObjectCommand({
    Bucket: configured.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    Metadata: { sha256, 'original-name': safeFileName(file.originalname) },
  }));
  return { key, sha256, size: file.buffer.byteLength };
}

export async function sourceFileUrl(key: string, expiresIn = 900): Promise<string | null> {
  const configured = storageConfig();
  if (!configured) return null;
  return getSignedUrl(configured.client, new GetObjectCommand({ Bucket: configured.bucket, Key: key }), { expiresIn });
}

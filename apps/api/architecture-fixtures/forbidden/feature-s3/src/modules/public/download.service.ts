import { GetObjectCommand } from '@aws-sdk/client-s3';

export const command = () => new GetObjectCommand({ Bucket: 'public', Key: 'object' });

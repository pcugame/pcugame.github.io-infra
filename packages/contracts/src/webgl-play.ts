import { WebglDisplayDimensionSchema } from './webgl-display.js';
import { z } from "zod";
export const WebglPlayCreateBodySchema = z
  .object({ projectId: z.number().int().positive() })
  .strict();
export const WebglPlayRenewBodySchema = z
  .object({ visible: z.boolean().optional() })
  .strict()
  .nullish();
export const WebglPlaySessionParamsSchema = z.object({ id: z.string().uuid() });
export const WebglPlayCreateDataSchema = z.object({
  id: z.string().uuid(),
  controlSecret: z.string(),
  iframeUrl: z.string().url(),
  projectTitle: z.string(),
  webglDisplayWidth: WebglDisplayDimensionSchema.nullable().optional(),
  webglDisplayHeight: WebglDisplayDimensionSchema.nullable().optional(),
  expiresAt: z.string(),
  absoluteExpiresAt: z.string(),
});
export const WebglPlayRenewDataSchema = z.object({
  expiresAt: z.string(),
  absoluteExpiresAt: z.string(),
});
export const WebglPlayCloseDataSchema = z.object({ closed: z.boolean() });
export type WebglPlaySession = z.infer<typeof WebglPlayCreateDataSchema>;

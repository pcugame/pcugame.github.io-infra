import { WebglDisplayDimensionSchema, WebglDisplayKindSchema } from './webgl-display.js';
import { z } from "zod";
export const WebglPlayCreateBodySchema = z
  .object({ projectId: z.number().int().positive(), diagnostics: z.boolean().optional() })
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
  webglDisplayKind: WebglDisplayKindSchema.optional(),
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

export const WebglDiagnosticDataSchema = z.object({
  gameOrigin: z.string(), policyVersion: z.number().int().nonnegative(), approvedOrigins: z.array(z.string()),
  items: z.array(z.object({ origin: z.string(), directive: z.string(), count: z.number().int().positive(), firstSeenAt: z.string().datetime(), lastSeenAt: z.string().datetime() }).strict()),
}).strict();
export type WebglDiagnosticData = z.infer<typeof WebglDiagnosticDataSchema>;

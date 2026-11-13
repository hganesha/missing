import { z } from "zod";

export const documentStudioRequestSchema = z.object({
  documentType: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(100),
  contentBase64: z.string().min(4).max(12 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export type DocumentStudioRequest = z.infer<typeof documentStudioRequestSchema>;

import { z } from "zod";

export function createToolDefinition(
  name: string,
  description: string,
  schema: z.ZodObject<any>
) {
  const jsonSchema = z.toJSONSchema(schema);
  const { $schema, ...cleanSchema } = jsonSchema as Record<string, unknown>;
  return {
    name,
    description,
    inputSchema: cleanSchema,
  };
}

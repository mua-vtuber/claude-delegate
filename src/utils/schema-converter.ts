import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export function createToolDefinition(
  name: string,
  description: string,
  schema: z.ZodObject<any>
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod-to-json-schema types expect zod/v3, project uses zod v4
  const jsonSchema = zodToJsonSchema(schema as any, { target: "openApi3" });
  // Remove $schema and additionalProperties that zodToJsonSchema adds
  const { $schema, additionalProperties, ...cleanSchema } = jsonSchema as any;
  return {
    name,
    description,
    inputSchema: cleanSchema,
  };
}

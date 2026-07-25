import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/client/validators/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";

type SchemaDialect =
  | { status: "unstamped" }
  | { status: "stamped"; uri: string };

const DRAFT_07_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);

function schemaDialect(schema: JsonSchemaType): SchemaDialect {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") {
    return { status: "unstamped" };
  }
  return {
    status: "stamped",
    uri: schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema,
  };
}

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  const defaultValidator = new AjvJsonSchemaValidator();
  let draft07Validator: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const dialect = schemaDialect(schema);
      if (dialect.status !== "stamped" || !DRAFT_07_SCHEMA_URIS.has(dialect.uri)) {
        return defaultValidator.getValidator<T>(schema);
      }

      draft07Validator ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07Validator.getValidator<T>(schema);
    },
  };
}

import { z } from "zod";

// RFC 3986 URI references, including relative paths. Do not normalize: source
// identity and listener matching use the exact value provided by the producer.
const uriReference =
  /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
const pathCharacters = /^(?:[A-Za-z0-9\-._~:@!$&'()*+,;=/]|%[0-9A-Fa-f]{2})*$/;
const queryCharacters =
  /^(?:[A-Za-z0-9\-._~:@!$&'()*+,;=/?]|%[0-9A-Fa-f]{2})*$/;
const authorityCharacters =
  /^(?:[A-Za-z0-9\-._~:@!$&'()*+,;=[\]]|%[0-9A-Fa-f]{2})*$/;
export const eventSourceSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const parts = uriReference.exec(value);
    if (!parts) return false;
    const [, scheme, authority, path = "", query = "", fragment = ""] = parts;
    if (
      !pathCharacters.test(path) ||
      !queryCharacters.test(query) ||
      !queryCharacters.test(fragment)
    )
      return false;
    if (
      !scheme &&
      authority === undefined &&
      !path.startsWith("/") &&
      (path.split("/")[0] ?? "").includes(":")
    )
      return false;
    if (authority !== undefined) {
      if (!authorityCharacters.test(authority)) return false;
      // Use HTTP's authority parser for host/IP/port syntax only. The original
      // scheme, path and identity remain untouched, including relative sources.
      try {
        new URL(`http://${authority || "cloudevents.invalid"}/`);
      } catch {
        return false;
      }
    }
    return true;
  }, "Must be a valid nonempty URI reference");

export type EventListener = {
  sources: string[];
  types: string[];
  notify?:
    | {
        chatId: string;
        name?: string | undefined;
        description?: string | undefined;
      }
    | undefined;
};

const knownAttributes = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "subject",
  "time",
  "dataschema",
  "datacontenttype",
  "data",
]);
export const cloudEventSchema = z
  .object({
    specversion: z.literal("1.0"),
    id: z.string().min(1),
    source: eventSourceSchema,
    type: z.string().min(1),
    subject: z.string().min(1).optional(),
    time: z.iso.datetime({ offset: true }).optional(),
    dataschema: eventSourceSchema
      .refine(
        (value) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value),
        "dataschema must be an absolute URI",
      )
      .optional(),
    datacontenttype: z
      .string()
      .refine(
        (value) =>
          /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
            value,
          ),
        "Only JSON event data is supported",
      )
      .optional(),
    data: z.json().optional(),
  })
  .catchall(
    z.union([
      z.string(),
      z.boolean(),
      z.number().int().min(-2147483648).max(2147483647),
    ]),
  )
  .superRefine((event, context) => {
    for (const key of Object.keys(event)) {
      if (knownAttributes.has(key)) continue;
      if (key === "data_base64" || !/^[a-z0-9]+$/.test(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            key === "data_base64"
              ? "data_base64 is unsupported; send JSON data"
              : "Extension names must contain only lowercase letters and digits",
        });
      }
    }
  });

export type CloudEvent = z.infer<typeof cloudEventSchema>;

export function parseCloudEvent(input: unknown): CloudEvent {
  return cloudEventSchema.parse(input);
}

export function matchesListener(
  event: CloudEvent,
  listener: EventListener,
): boolean {
  return (
    listener.sources.includes(event.source) &&
    listener.types.includes(event.type)
  );
}

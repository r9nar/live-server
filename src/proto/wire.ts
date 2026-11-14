import protobuf from "protobufjs";

/** Structural reader for messages that are not in the schema (wire format, no .proto). */
const MAX_DEPTH = 6;
const VALID_WIRE_TYPES = new Set([0, 1, 2, 5]);
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F]/;

function append(target: Record<string, unknown>, field: number, value: unknown): void {
  const current = target[field];
  if (current === undefined) {
    target[field] = value;
  } else if (Array.isArray(current)) {
    current.push(value);
  } else {
    target[field] = [current, value];
  }
}

function decodeText(bytes: Uint8Array, depth: number): unknown {
  if (bytes.length === 0) return "";
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!CONTROL_CHARS.test(text)) return text;
  const nested = decodeWire(buffer, depth);
  if (nested) return nested;
  return buffer.toString("base64");
}

/** Decodes any protobuf message into `{ fieldNumber: value }` without a schema. */
export function decodeWire(buffer: Uint8Array, depth = 0): Record<string, unknown> | null {
  if (!buffer || buffer.length === 0 || depth > MAX_DEPTH) return null;

  const reader = protobuf.Reader.create(buffer);
  const result: Record<string, unknown> = {};

  try {
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (!field || !VALID_WIRE_TYPES.has(wire)) {
        return Object.keys(result).length ? result : null;
      }

      let value: unknown;
      if (wire === 0) value = reader.int64().toString();
      else if (wire === 1) value = reader.fixed64().toString();
      else if (wire === 5) value = reader.fixed32();
      else value = decodeText(reader.bytes(), depth + 1);

      append(result, field, value);
    }
  } catch {
    return Object.keys(result).length ? result : null;
  }

  return Object.keys(result).length ? result : null;
}

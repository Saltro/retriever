type Attributes = Record<string, string | number | undefined>;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openTag(name: string, attributes: Attributes): string {
  const rendered = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
  return `<${name}${rendered}>`;
}

export function element(name: string, attributes: Attributes, body?: string): string {
  return body === undefined
    ? `${openTag(name, attributes)}</${name}>`
    : `${openTag(name, attributes)}\n${body}\n</${name}>`;
}

/** One-line element, for short literal instructions that need no body block. */
export function inlineElement(name: string, attributes: Attributes, text: string): string {
  return `${openTag(name, attributes)}${escapeXml(text)}</${name}>`;
}

/** Event text is data, never markup: escape it so it cannot break the surrounding structure. */
export function promptBody(text: string): string {
  return escapeXml(text.trim());
}
